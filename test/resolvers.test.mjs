// The daily watch and its report against stand-ins for Jira and app storage. Run with: npm test
// (node --import ./test/forge/register.mjs swaps @forge/api, @forge/kvs and @forge/resolver for test/forge/stub-*.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
const { watch } = await import('../src/index.js');
const defs = globalThis.RESOLVERS;

// one site: a workflow whose Ship step reaches Done without a resolution (a finding), and project OPS for reports
const S = { admin: true, created: [], refuse: false, wf: null };
const tr = (id, name, from, to) => ({ id, name, type: 'DIRECTED', toStatusReference: to, links: from.map((f) => ({ fromStatusReference: f })), actions: [] });
const shipWf = (broken) => ({ id: 'w1', name: 'Ship', statuses: ['1', '2', '3'].map((s) => ({ statusReference: s })),
  transitions: [{ id: '0', type: 'INITIAL', toStatusReference: '1' }, tr('1', 'Start', ['1'], '2'),
    { ...tr('2', 'Finish', ['2'], '3'), actions: broken ? [] : [{ ruleKey: 'system:update-field', parameters: { field: 'resolution', value: '10000' } }] }] });
const page = (values) => ({ values, isLast: true });
globalThis.JIRA = async (path, init) => {
  if (path.includes('mypermissions')) return { permissions: { ADMINISTER: { havePermission: S.admin } } };
  if (path.includes('/myself')) return { accountId: 'a1', displayName: 'Asha' };
  if (path.includes('workflows/search')) return page([S.wf]);
  if (path.includes('statuses/search')) return page([{ id: '1', name: 'To Do', statusCategory: 'TODO' }, { id: '2', name: 'In Progress', statusCategory: 'IN_PROGRESS' }, { id: '3', name: 'Done', statusCategory: 'DONE' }, { id: '4', name: 'Blocked', statusCategory: 'IN_PROGRESS' }]);
  if (path.includes('project/search')) return page([]);
  if (path.includes('/project/OPS')) return { id: '10', key: 'OPS' };
  if (path.includes('/createmeta/')) return { issueTypes: [{ id: '7', name: 'Task', subtask: false }] };
  if (path.endsWith('/rest/api/3/issue') && init?.method === 'POST') {
    if (S.refuse) return { __status: 400, body: { errors: { project: 'You cannot create work items here' } } };
    S.created.push(JSON.parse(init.body).fields.summary);
    return { key: `OPS-${S.created.length}` };
  }
  return {};
};
const ctx = { context: { accountId: 'a1' } };
const fresh = () => { globalThis.KV.clear(); Object.assign(S, { admin: true, created: [], refuse: false, wf: shipWf(false) }); };

test('reporting can be turned on by admins only, for a real project key', async () => {
  fresh();
  S.admin = false;
  await assert.rejects(defs.setWatchNotify({ ...ctx, payload: { projectKey: 'OPS' } }), /administrators/);
  S.admin = true;
  for (const bad of ['OPS/../x', '1AB', 'A'.repeat(30)]) await assert.rejects(defs.setWatchNotify({ ...ctx, payload: { projectKey: bad } }), /not a project key/);
  assert.equal((await defs.setWatchNotify({ ...ctx, payload: { projectKey: 'ops' } })).notify.projectKey, 'OPS');
});

test('a new finding is reported once as a work item; what was already there is not', async () => {
  fresh();
  S.wf = shipWf(true);
  await watch(); // the finding exists before reporting is turned on
  await defs.setWatchNotify({ ...ctx, payload: { projectKey: 'OPS' } });
  await watch();
  assert.equal(S.created.length, 0);
  // the workflow is fixed, then broken again by an edit: that is new, and reported once
  S.wf = shipWf(false); await watch();
  S.wf = shipWf(true); globalThis.KV.delete(`watch:report:${new Date().toISOString().slice(0, 10)}`); await watch();
  assert.equal(S.created.length, 1);
  assert.match(S.created[0], /1 new workflow finding/);
  await watch();
  assert.equal(S.created.length, 1);
});

test('one report a day, and a refused report is shown with the reason and tried again', async () => {
  fresh();
  await defs.setWatchNotify({ ...ctx, payload: { projectKey: 'OPS' } });
  S.wf = shipWf(true); S.refuse = true;
  await watch();
  assert.match(globalThis.KV.get('watch:notified').error, /cannot create/);
  S.refuse = false;
  await watch(); // the refused report released the day's claim
  assert.equal(S.created.length, 1);
  // work can now get stuck in Blocked: a second new finding the same day waits for tomorrow's report
  S.wf = { ...shipWf(true), statuses: [...shipWf(true).statuses, { statusReference: '4' }], transitions: [...shipWf(true).transitions, tr('9', 'Block', ['2'], '4')] };
  await watch();
  assert.equal(S.created.length, 1);
});

// ---------- the fix: check with Jira, apply, undo ----------
const F = { wf: null, updates: 0, failUpdate: false };
const fixWf = () => ({ id: 'w2', name: 'Ship', version: { versionNumber: 1 }, statuses: ['1', '2', '3'].map((s) => ({ statusReference: s })),
  transitions: [{ id: '0', type: 'INITIAL', toStatusReference: '1', actions: [] }, tr('1', 'Start', ['1'], '2'), tr('2', 'Finish', ['2'], '3')] });
const base = globalThis.JIRA;
globalThis.JIRA = async (path, init) => {
  if (path === '/rest/api/3/workflows' && init?.method === 'POST') return { workflows: [structuredClone(F.wf)] };
  if (path.startsWith('/rest/api/3/statuses?')) return [{ id: '1', name: 'To Do', statusCategory: 'TODO' }, { id: '2', name: 'In Progress', statusCategory: 'IN_PROGRESS' }, { id: '3', name: 'Done', statusCategory: 'DONE' }];
  if (path.includes('/resolution/search')) return { values: [{ id: '10000', name: 'Done' }] };
  if (path.includes('/workflows/update/validation')) return { errors: [] };
  if (path.includes('/workflows/update')) {
    if (F.failUpdate) return { __status: 409, body: { errorMessages: ['The workflow changed'] } };
    F.updates++; F.wf.transitions = JSON.parse(init.body).workflows[0].transitions; return {};
  }
  return base(path, init);
};
const fix = (mode) => defs.fix({ ...ctx, payload: { workflowId: 'w2', property: 'doneUnresolved', status: '3', mode } });
const setsResolution = () => F.wf.transitions.find((t) => t.id === '2').actions.some((a) => a.parameters?.field === 'resolution' && a.parameters.value);

test('a fix is checked with Jira first, applied only on Apply, and undone exactly', async () => {
  fresh(); Object.assign(F, { wf: fixWf(), updates: 0, failUpdate: false });
  const check = await fix(undefined);
  assert.deepEqual(check.changed, ['Finish']);
  assert.equal(check.valid, true);
  assert.equal(F.updates, 0);
  await fix('apply');
  assert.equal(setsResolution(), true);
  await fix('undo');
  assert.equal(setsResolution(), false);
  assert.equal(globalThis.KV.get('fixes')?.['w2|doneUnresolved|3'], undefined);
});

test('a fix Jira refuses leaves no Undo record; Undo refuses to overwrite a later edit', async () => {
  fresh(); Object.assign(F, { wf: fixWf(), updates: 0, failUpdate: true });
  await assert.rejects(fix('apply'), /409/);
  assert.deepEqual(Object.keys(globalThis.KV.get('fixes') || {}), []);
  F.failUpdate = false;
  await fix('apply');
  F.wf.transitions.find((t) => t.id === '2').actions.push({ ruleKey: 'system:assign', parameters: {} }); // someone edits it since
  await assert.rejects(fix('undo'), /edited since/);
});

test('Undo works when Jira read the workflow back before the change showed', async () => {
  fresh(); Object.assign(F, { wf: fixWf(), updates: 0, failUpdate: false });
  const stale = structuredClone(F.wf);
  let reads = 0;
  const real = globalThis.JIRA;
  globalThis.JIRA = async (path, init) => {
    // the read-back right after the update returns the old workflow once
    if (path === '/rest/api/3/workflows' && init?.method === 'POST' && F.updates === 1 && reads++ === 0) return { workflows: [structuredClone(stale)] };
    return real(path, init);
  };
  try {
    await fix('apply');
    assert.equal(setsResolution(), true);
    await fix('undo');
    assert.equal(setsResolution(), false);
  } finally { globalThis.JIRA = real; }
});
