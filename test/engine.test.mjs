// Unit tests for the workflow model checker. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { verify, buildModel, usableBySomeone, reopenSteps } from '../engine/interlock.mjs';
import { resolutionFor } from '../engine/resolution.mjs';

const statuses = new Map([
  ['1', { name: 'To Do', category: 'TODO' }],
  ['2', { name: 'In Progress', category: 'IN_PROGRESS' }],
  ['3', { name: 'Code Review', category: 'IN_PROGRESS' }],
  ['4', { name: 'Done', category: 'DONE' }],
  ['5', { name: 'Stuck', category: 'IN_PROGRESS' }],
]);
const setRes = [{ ruleKey: 'system:update-field', parameters: { field: 'resolution', value: '10000' } }];
const clearRes = [{ ruleKey: 'system:update-field', parameters: { field: 'resolution', value: '' } }];
const tr = (id, name, from, to, extra = {}) => ({ id, name, type: from ? 'DIRECTED' : 'GLOBAL', toStatusReference: to, links: (from || []).map((f) => ({ fromStatusReference: f })), actions: [], ...extra });
const wf = (transitions, ids = ['1', '2', '3', '4']) => ({ id: 'w', name: 'W', statuses: ids.map((s) => ({ statusReference: s })),
  transitions: [{ id: '0', type: 'INITIAL', toStatusReference: '1' }, ...transitions] });
const props = (r) => r.findings.map((f) => `${f.property}:${f.subject}`).sort();

test('a sound workflow has no findings', () => {
  const r = verify(wf([tr('1', 'Start', ['1'], '2'), tr('2', 'Review', ['2'], '3'), tr('3', 'Approve', ['3'], '4', { actions: setRes }), tr('4', 'Reopen', ['4'], '2', { actions: clearRes })]), statuses);
  assert.deepEqual(r.findings, []);
});

test('done without setting a resolution is found, with the route', () => {
  const r = verify(wf([tr('1', 'Start', ['1'], '2'), tr('2', 'Finish', ['2'], '4')], ['1', '2', '4']), statuses);
  assert.deepEqual(props(r), ['doneUnresolved:Done']);
  assert.deepEqual(r.findings[0].route.hops.map((h) => h.transition), ['Start', 'Finish']);
});

test('a transition screen that asks for the resolution counts as setting it', () => {
  const t = [tr('1', 'Start', ['1'], '2'), tr('2', 'Finish', ['2'], '4', { transitionScreen: { parameters: { screenId: '77' } } })];
  assert.deepEqual(verify(wf(t, ['1', '2', '4']), statuses, { screenHasResolution: new Set(['77']) }).findings, []);
});

test('reopening without clearing the resolution is found', () => {
  const r = verify(wf([tr('1', 'Finish', ['1'], '4', { actions: setRes }), tr('2', 'Reopen', ['4'], '1')], ['1', '4']), statuses);
  assert.deepEqual(props(r), ['openResolved:To Do']);
});

test('a status with no way to done is found as stuck', () => {
  const r = verify(wf([tr('1', 'Park', ['1'], '5'), tr('2', 'Finish', ['1'], '4', { actions: setRes })], ['1', '4', '5']), statuses);
  assert.ok(props(r).includes('stranded:Stuck'));
});

test('a rule that every route passes Code Review is proved or refuted', () => {
  const base = [tr('1', 'Start', ['1'], '2'), tr('2', 'Review', ['2'], '3'), tr('3', 'Approve', ['3'], '4', { actions: setRes })];
  const rule = { mustPass: [{ target: '4', via: '3' }] };
  assert.deepEqual(verify(wf(base), statuses, rule).findings, []);
  const shortcut = verify(wf([...base, tr('9', 'Close', null, '4', { actions: setRes })]), statuses, rule);
  assert.deepEqual(props(shortcut), ['mustPass:Done without Code Review']);
});

test('a rule through the initial status always holds', () => {
  const r = verify(wf([tr('1', 'Finish', ['1'], '4', { actions: setRes })], ['1', '4']), statuses, { mustPass: [{ target: '4', via: '1' }] });
  assert.deepEqual(r.findings, []);
});

test('condition groups: ANY lets someone through if one branch does, ALL needs every branch', () => {
  const nobody = { ruleKey: 'system:restrict-issue-transition', parameters: {} };
  const role = { ruleKey: 'system:restrict-issue-transition', parameters: { roleIds: ['10002'] } };
  const model = (conditions) => buildModel(wf([tr('1', 'Go', ['1'], '4', { conditions })], ['1', '4']), statuses);
  assert.equal(usableBySomeone(model({ operation: 'ANY', conditions: [nobody, role] }).transitions[0]), true);
  assert.equal(usableBySomeone(model({ operation: 'ALL', conditions: [nobody, role] }).transitions[0]), false);
  assert.equal(usableBySomeone(model({ operation: 'ALL', conditions: [], conditionGroups: [{ operation: 'ANY', conditions: [nobody, role] }] }).transitions[0]), true);
});

test('a fix or replay chooses the resolution a person would', () => {
  const values = ['Done', "Won't Do", 'Declined', 'Duplicate', 'Cancelled'].map((name, i) => ({ id: String(i), name }));
  assert.equal(resolutionFor(values, 'Declined', 'Decline').name, 'Declined');
  assert.equal(resolutionFor(values, 'Rejected').name, 'Declined');
  assert.equal(resolutionFor(values, 'Canceled', 'Cancel request').name, 'Cancelled');
  assert.equal(resolutionFor(values, 'Purchased').name, 'Done');
});

test('a route to a successful outcome that skips every approval step is found', () => {
  const st = new Map([...statuses, ['6', { name: 'Awaiting approval', category: 'IN_PROGRESS' }], ['7', { name: 'Declined', category: 'DONE' }]]);
  const approvalWf = (extra) => ({ id: 'w', name: 'W', statuses: [
    { statusReference: '1' }, { statusReference: '6', properties: { 'approval.groups': 'cab' } }, { statusReference: '4' }, { statusReference: '7' }],
  transitions: [{ id: '0', type: 'INITIAL', toStatusReference: '1' }, tr('1', 'Ask', ['1'], '6'), tr('2', 'Approve', ['6'], '4', { actions: setRes }),
    tr('3', 'Decline', ['1', '6'], '7', { actions: setRes }), ...extra] });
  assert.deepEqual(verify(approvalWf([]), st).findings.filter((f) => f.property === 'approvalSkipped'), []);
  const skip = verify(approvalWf([tr('9', 'Emergency close', ['1'], '4', { actions: setRes })]), st);
  const f = skip.findings.filter((x) => x.property === 'approvalSkipped');
  assert.deepEqual(f.map((x) => x.subject), ['Done']);
  assert.deepEqual(f[0].route.hops.map((h) => h.transition), ['Emergency close']);
});

test('declining at the approval step and coming back later is not an approval', () => {
  const st = new Map([...statuses, ['6', { name: 'Awaiting approval', category: 'IN_PROGRESS' }], ['7', { name: 'Declined', category: 'DONE' }]]);
  const w = { id: 'w', name: 'W', statuses: [{ statusReference: '1' }, { statusReference: '6', properties: { 'approval.groups': 'cab' } }, { statusReference: '4' }, { statusReference: '7' }],
    transitions: [{ id: '0', type: 'INITIAL', toStatusReference: '1' }, tr('1', 'Ask', ['1'], '6'), tr('2', 'Approve', ['6'], '4', { actions: setRes }),
      tr('3', 'Decline', ['6'], '7', { actions: setRes }), tr('4', 'Reopen', ['7'], '1', { actions: clearRes }), tr('5', 'Close', ['1'], '4', { actions: setRes })] };
  // Close from To Do is only reachable again after a decline, so the route To Do -> Close -> Done is unapproved
  const f = verify(w, st).findings.filter((x) => x.property === 'approvalSkipped');
  assert.deepEqual(f.map((x) => x.subject), ['Done']);
});

test('work that starts at the approval step can still skip it', () => {
  const st = new Map([...statuses, ['6', { name: 'Awaiting approval', category: 'IN_PROGRESS' }], ['7', { name: 'Declined', category: 'DONE' }]]);
  const w = (extra) => ({ id: 'w', name: 'W', statuses: [{ statusReference: '6', properties: { 'approval.groups': 'cab', 'approval.transition.approved': '2' } }, { statusReference: '4' }, { statusReference: '7' }],
    transitions: [{ id: '0', type: 'INITIAL', toStatusReference: '6' }, tr('2', 'Approve', ['6'], '4', { actions: setRes }), tr('3', 'Decline', ['6'], '7', { actions: setRes }), ...extra] });
  assert.deepEqual(verify(w([]), st).findings.filter((f) => f.property === 'approvalSkipped'), []);
  const f = verify(w([tr('9', 'Emergency', ['6'], '4', { actions: setRes })]), st).findings.filter((x) => x.property === 'approvalSkipped');
  assert.deepEqual(f.map((x) => x.route.hops.map((h) => h.transition).join()), ['Emergency']);
});

test('a rule is checked on every arrival: reopening and closing again without review breaks it', () => {
  const w = wf([tr('1', 'Start', ['1'], '2'), tr('2', 'Review', ['2'], '3'), tr('3', 'Approve', ['3'], '4', { actions: setRes }),
    tr('4', 'Reopen', ['4'], '2', { actions: clearRes }), tr('5', 'Quick close', ['2'], '4', { actions: setRes, conditions: undefined })]);
  // without the reopen, Quick close from In Progress is a direct skip anyway; take it away to test the reopen case
  const noShortcut = wf([tr('1', 'Start', ['1'], '2'), tr('2', 'Review', ['2'], '3'), tr('3', 'Approve', ['3'], '4', { actions: setRes }),
    tr('4', 'Reopen', ['4'], '2', { actions: clearRes }), tr('6', 'Close again', ['2'], '4', { actions: setRes })]);
  const f = verify(noShortcut, statuses, { mustPass: [{ target: '4', via: '3' }] }).findings.filter((x) => x.property === 'mustPass');
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].route.hops.map((h) => h.transition), ['Start', 'Close again']);
  const ok = wf([tr('1', 'Start', ['1'], '2'), tr('2', 'Review', ['2'], '3'), tr('3', 'Approve', ['3'], '4', { actions: setRes }), tr('4', 'Reopen', ['4'], '3', { actions: clearRes })]);
  assert.deepEqual(verify(ok, statuses, { mustPass: [{ target: '4', via: '3' }] }).findings.filter((x) => x.property === 'mustPass'), []);
  const reopen = wf([tr('1', 'Start', ['1'], '2'), tr('2', 'Review', ['2'], '3'), tr('3', 'Approve', ['3'], '4', { actions: setRes }),
    tr('4', 'Reopen', ['4'], '5'), tr('7', 'Close', ['5'], '4', { actions: setRes })], ['1', '2', '3', '4', '5']);
  const g = verify(reopen, statuses, { mustPass: [{ target: '4', via: '3' }] }).findings.filter((x) => x.property === 'mustPass');
  assert.deepEqual(g[0].route.hops.map((h) => h.transition), ['Start', 'Review', 'Approve', 'Reopen', 'Close']);
  assert.equal(verify(ok, statuses, { mustPass: [{ target: '4', via: '99' }] }).findings.filter((x) => x.property === 'ruleStale').length, 1);
});

test('approvals: a global close never approves, and reopened work must be approved again', () => {
  const st = new Map([...statuses, ['6', { name: 'Awaiting approval', category: 'IN_PROGRESS' }], ['7', { name: 'Declined', category: 'DONE' }]]);
  const w = (extra) => ({ id: 'w', name: 'W', statuses: [{ statusReference: '1' }, { statusReference: '6', properties: { 'approval.groups': 'cab' } }, { statusReference: '4' }, { statusReference: '7' }],
    transitions: [{ id: '0', type: 'INITIAL', toStatusReference: '1' }, tr('1', 'Ask', ['1'], '6'), tr('2', 'Approve', ['6'], '4', { actions: setRes }), tr('3', 'Decline', ['6'], '7', { actions: setRes }), ...extra] });
  const skipped = (wf) => verify(wf, st).findings.filter((f) => f.property === 'approvalSkipped').map((f) => f.route.hops.map((h) => h.transition).join());
  assert.deepEqual(skipped(w([tr('8', 'Close', null, '4', { actions: setRes })])).length, 1);
  // Close is only reachable from In Progress, and In Progress only by reopening finished work
  const st2 = new Map([...st]);
  const w2 = { ...w([tr('4', 'Reopen', ['4'], '2', { actions: clearRes }), tr('5', 'Close', ['2'], '4', { actions: setRes })]) };
  w2.statuses = [...w2.statuses, { statusReference: '2' }];
  assert.deepEqual(verify(w2, st2).findings.filter((f) => f.property === 'approvalSkipped').map((f) => f.route.hops.map((h) => h.transition).join()), ['Ask,Approve,Reopen,Close']);
});

test('a screen Interlock cannot read never invents a reopened-but-resolved finding', () => {
  const t1 = tr('1', 'Start', ['1'], '2', { transitionScreen: { parameters: { screenId: '77' } } });
  const w = wf([t1, tr('2', 'Finish', ['2'], '4', { actions: setRes }), tr('3', 'Reopen', ['4'], '2', { actions: clearRes })], ['1', '2', '4']);
  assert.deepEqual(verify(w, statuses, { unreadableScreens: new Set(['77']) }).findings, []);
});

test('rules whose required status is done, or whose target is open, are not broken by reopening', () => {
  const w = wf([tr('1', 'Start', ['1'], '2'), tr('2', 'Review', ['2'], '3'), tr('3', 'Approve', ['3'], '4', { actions: setRes }), tr('4', 'Reopen', ['4'], '5', { actions: clearRes })], ['1', '2', '3', '4', '5']);
  // "Stuck only through Done": every route to Stuck passes Done
  assert.deepEqual(verify(w, statuses, { mustPass: [{ target: '5', via: '4' }] }).findings.filter((f) => f.property === 'mustPass'), []);
});

test('an unreadable screen into a done status never invents a reopened-but-resolved finding', () => {
  const finish = tr('2', 'Finish', ['2'], '4', { transitionScreen: { parameters: { screenId: '88' } } });
  const w = wf([tr('1', 'Start', ['1'], '2'), finish, tr('3', 'Reopen', ['4'], '2')], ['1', '2', '4']);
  const props = verify(w, statuses, { unreadableScreens: new Set(['88']) }).findings.map((f) => f.property);
  assert.ok(!props.includes('openResolved'));
});

test('the reopen fix goes on the step out of done, even when the route reaches the status through another open one', () => {
  const cat = { 1: 'TODO', 2: 'IN_PROGRESS', 3: 'DONE', 4: 'TODO' };
  const t = (id, from, to, actions = []) => ({ id, type: 'DIRECTED', links: from.map((f) => ({ fromStatusReference: f })), toStatusReference: to, actions });
  const clear = [{ ruleKey: 'system:update-field', parameters: { field: 'resolution', value: '' } }];
  // Done -> Reopened (keeps the resolution) -> In Progress: the finding is on In Progress, the fix on Reopen
  const ts = [t('a', ['1'], '2'), t('b', ['2'], '3'), t('c', ['3'], '4'), t('d', ['4'], '2')];
  assert.deepEqual(reopenSteps(ts, cat, '2', ['1', '2', '3', '4']).map((x) => x.id), ['c']);
  // once Reopen clears the resolution there is nothing left to fix
  ts[2].actions = clear;
  assert.deepEqual(reopenSteps(ts, cat, '2', ['1', '2', '3', '4']), []);
});

test('rules: passing the required status survives loops and done-to-done moves; reworked finished work must pass again', () => {
  const s4 = new Map([['1', { name: 'To Do', category: 'TODO' }], ['2', { name: 'Review', category: 'IN_PROGRESS' }], ['3', { name: 'QA', category: 'IN_PROGRESS' }], ['4', { name: 'Blocked', category: 'IN_PROGRESS' }], ['5', { name: 'Done', category: 'DONE' }], ['6', { name: 'Closed', category: 'DONE' }], ['7', { name: 'Reopened', category: 'TODO' }]]);
  const w = wf([tr('1', 'Start', ['1'], '2'), tr('2', 'To QA', ['2'], '3'), tr('3', 'Block', ['3'], '4'), tr('4', 'Unblock', ['4'], '3'), tr('5', 'Finish', ['3'], '5'),
    tr('6', 'Close', ['5'], '6'), tr('7', 'Un-close', ['6'], '5'), tr('8', 'Reopen', ['5'], '7'), tr('9', 'Close reopened', ['7'], '6')], ['1', '2', '3', '4', '5', '6', '7']);
  const rule = (target, via) => verify(w, s4, { mustPass: [{ target, via }] }).findings.filter((f) => f.property === 'mustPass');
  assert.deepEqual(rule('3', '2'), []); // QA only through Review: the Blocked loop is not a violation
  // Done only through Review: Done -> Closed -> Done is not a violation (on the same workflow without the reopen)
  const noReopen = wf(w.transitions.filter((t) => t.id !== '8' && t.id !== '9' && t.id !== '0'), ['1', '2', '3', '4', '5', '6', '7']);
  assert.deepEqual(verify(noReopen, s4, { mustPass: [{ target: '5', via: '2' }] }).findings.filter((f) => f.property === 'mustPass'), []);
  // with the reopen, reworked work can finish again without review: a violation
  assert.equal(rule('5', '2').length, 1);
  // Closed only through Done: reopened work closed again without finishing again is a violation
  const broken = rule('6', '5');
  assert.equal(broken.length, 1);
  assert.deepEqual(broken[0].route.hops.map((h) => h.transition).slice(-2), ['Reopen', 'Close reopened']);
});

test('unreadable screens: a resolution property that depends on the screen is undecided, never held', () => {
  const screen = (id) => ({ transitionScreen: { parameters: { screenId: id } } });
  // Finish has an unreadable screen into Done; Reopen goes back with nothing on it
  const w = wf([tr('1', 'Start', ['1'], '2'), tr('2', 'Finish', ['2'], '4', screen('88')), tr('3', 'Reopen', ['4'], '2')], ['1', '2', '4']);
  const out = verify(w, statuses, { unreadableScreens: new Set(['88']) });
  assert.ok(!out.findings.some((f) => f.property === 'doneUnresolved' || f.property === 'openResolved'));
  assert.deepEqual(out.undecided.sort(), ['doneUnresolved', 'openResolved']);
  assert.ok(!out.held.includes('doneUnresolved') && !out.held.includes('openResolved'));
});

test('a workflow with no create transition holds nothing', () => {
  const w = { id: 'w', name: 'No start', statuses: [{ statusReference: '1' }, { statusReference: '4' }], transitions: [tr('2', 'Finish', ['1'], '4')] };
  const out = verify(w, statuses);
  assert.deepEqual(out.held, []);
  assert.equal(out.noInitial, true);
});

test('approvals: cancelled work closed later is not a skip; sending work back is not an approval', () => {
  const st = new Map([['1', { name: 'Draft', category: 'TODO' }], ['2', { name: 'Awaiting approval', category: 'IN_PROGRESS', approval: true }], ['3', { name: 'In progress', category: 'IN_PROGRESS' }],
    ['4', { name: 'Canceled', category: 'DONE' }], ['5', { name: 'Closed', category: 'DONE' }]]);
  const approvalStatus = (w) => ({ ...w, statuses: w.statuses.map((s) => (s.statusReference === '2' ? { ...s, properties: { 'approval.groups': 'true' } } : s)) });
  const base = [tr('1', 'Submit', ['1'], '2'), tr('2', 'Approve', ['2'], '3'), tr('3', 'Mark as canceled', ['2'], '4'), tr('4', 'Mark as closed', ['4'], '5'), tr('5', 'Close', ['3'], '5')];
  const props = (ts) => verify(approvalStatus(wf(ts, ['1', '2', '3', '4', '5'])), st).findings.filter((f) => f.property === 'approvalSkipped').map((f) => f.subject);
  assert.deepEqual(props(base), []);
  // "Back to draft" from the approval step is not an approval: Draft -> Close then skips it
  assert.deepEqual(props([...base, tr('6', 'Back to draft', ['2'], '1'), tr('7', 'Close draft', ['1'], '5')]), ['Closed']);
});

test('approvals: cancelled work moved on to a successful done status still needs the approval', () => {
  const st = new Map([['1', { name: 'Open', category: 'TODO' }], ['2', { name: 'Awaiting approval', category: 'IN_PROGRESS' }], ['3', { name: 'Canceled', category: 'DONE' }], ['4', { name: 'Completed', category: 'DONE' }]]);
  const w = wf([tr('1', 'Submit', ['1'], '2'), tr('2', 'Approve', ['2'], '4'), tr('3', 'Cancel', ['1'], '3'), tr('4', 'Mark completed', ['3'], '4')], ['1', '2', '3', '4']);
  const ww = { ...w, statuses: w.statuses.map((s) => (s.statusReference === '2' ? { ...s, properties: { 'approval.groups': 'true' } } : s)) };
  assert.deepEqual(verify(ww, st).findings.filter((f) => f.property === 'approvalSkipped').map((f) => f.subject), ['Completed']);
});

// ---------- the history trace ----------
import { lastStatusChange, waysOf } from '../engine/trace.mjs';
const h = (created, ...items) => ({ created, items });
const st = (from, to) => ({ field: 'status', fromString: from, toString: to });

test('the trace reads the newest status change, whatever order Jira returns', () => {
  const histories = [h('2024-01-03', st('Closed', 'Reopened')), h('2024-01-01', st('Open', 'Resolved'), { field: 'resolution', fromString: null, toString: 'Fixed' }), h('2024-01-02', st('Resolved', 'Closed'))];
  assert.deepEqual(lastStatusChange(histories), { from: 'Closed', to: 'Reopened', effect: 'resolution left as it was', at: '2024-01-03', person: false });
  assert.equal(lastStatusChange([...histories].reverse()).from, 'Closed');
  assert.equal(lastStatusChange([h('2024-01-01', { field: 'summary' })]), null);
});

test('the trace counts routes and marks the ones ending in a flagged status', () => {
  const issues = [
    { key: 'A-1', histories: [h('2024-01-02', st('Accepted', 'Purchased'))] },
    { key: 'A-2', histories: [h('2024-01-02', st('Accepted', 'Purchased'))] },
    { key: 'A-3', histories: [h('2024-01-02', st('Review', 'Rejected'), { field: 'resolution', fromString: 'Done', toString: null })] },
    { key: 'A-4', histories: [] },
  ];
  const t = waysOf(issues, ['Purchased']);
  assert.equal(t.read, 3);
  assert.equal(t.noStep, 1);
  assert.equal(t.system, 3);
  assert.equal(waysOf(issues, ['Purchased'], '2024-01-03').beforeSince, 3);
  assert.equal(waysOf(issues, ['Purchased'], '2024-01-01').beforeSince, 0);
  assert.equal(t.onProvedStatus, 2);
  assert.deepEqual(t.ways.map((w) => [w.count, w.to, w.flagged, w.effect]), [[2, 'Purchased', true, 'resolution left as it was'], [1, 'Rejected', false, 'resolution cleared']]);
});
