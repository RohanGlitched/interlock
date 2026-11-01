// Unit tests for the workflow model checker. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { verify, buildModel, usableBySomeone } from '../engine/interlock.mjs';
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
