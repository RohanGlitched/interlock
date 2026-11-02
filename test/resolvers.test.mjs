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
