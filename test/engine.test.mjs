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
