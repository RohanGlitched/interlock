// The track diagram: no track passes through a status it does not belong to. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../engine/interlock.mjs';
import { layout, tracks, trackPath, globalPath, BLOCK_W, BLOCK_H } from '../static/panel/src/layout.js';

// points along an SVG path made of M, L and C segments
function sample(d) {
  const tok = d.match(/[MLC]|-?\d+(\.\d+)?/g); let i = 0, cmd, cur, pts = [];
  const n = () => +tok[i++];
  while (i < tok.length) {
    if (/[MLC]/.test(tok[i])) cmd = tok[i++];
    if (cmd === 'M') { cur = [n(), n()]; pts.push(cur); }
    else if (cmd === 'L') { const e = [n(), n()]; for (let t = 0; t <= 1; t += 0.02) pts.push([cur[0] + (e[0] - cur[0]) * t, cur[1] + (e[1] - cur[1]) * t]); cur = e; }
    else { const c1 = [n(), n()], c2 = [n(), n()], e = [n(), n()]; for (let t = 0; t <= 1; t += 0.02) { const u = 1 - t; pts.push([u * u * u * cur[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * e[0], u * u * u * cur[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * e[1]]); } cur = e; }
  }
  return pts;
}

test('no track passes through a status it does not belong to', () => {
  // a workflow with forward steps, loops back across columns and rows, and "from any status" transitions
  const ids = ['1', '2', '3', '4', '5', '6', '7'];
  const statuses = new Map(ids.map((id, i) => [id, { name: `S${id}`, category: i === 0 ? 'TODO' : i >= 5 ? 'DONE' : 'IN_PROGRESS' }]));
  const tr = (id, from, to, type = 'DIRECTED') => ({ id, name: `t${id}`, type, toStatusReference: to, links: from.map((f) => ({ fromStatusReference: f })), actions: [] });
  const transitions = [{ id: '0', type: 'INITIAL', toStatusReference: '1' }, tr('1', ['1'], '2'), tr('2', ['1'], '3'), tr('3', ['2'], '4'), tr('4', ['3'], '4'), tr('5', ['4'], '6'),
    tr('6', ['4'], '7'), tr('7', ['6'], '2'), tr('8', ['7'], '3'), tr('9', ['4'], '1'), tr('10', ['6'], '1'), tr('11', [], '7', 'GLOBAL'), tr('12', [], '5', 'GLOBAL')];
  const m = buildModel({ id: 'w', name: 'W', statuses: ids.map((s) => ({ statusReference: s })), transitions }, statuses);
  // the same diagram left to right and top to bottom
  for (const vertical of [false, true]) {
    const { pos } = layout(m, vertical);
    const floor = Math.max(...[...pos.values()].map((p) => p.y)) + BLOCK_H;
    const through = (pts, own) => pts.some(([x, y]) => [...pos].some(([id, p]) => !own.has(id) && x > p.x + 2 && x < p.x + BLOCK_W - 2 && y > p.y + 2 && y < p.y + BLOCK_H - 2));
    const how = vertical ? 'top to bottom' : 'left to right';
    tracks(m).forEach((t, k) => assert.equal(through(sample(trackPath(pos.get(t.from), pos.get(t.to), k % 4, vertical, floor)), new Set([t.from, t.to])), false, `${how}: ${t.from} to ${t.to}`));
    m.transitions.filter((t) => t.type === 'GLOBAL').forEach((t, k) => assert.equal(through(sample(globalPath(pos.get(t.to), k, vertical)), new Set([t.to])), false, `${how}: global to ${t.to}`));
  }
});

test('300 random workflows: no track or drop passes through a status, in either direction', () => {
  // seeded, so the same 300 workflows every run: a creation spine, up to 1.5 extra transitions per status in any
  // direction, and sometimes a "from any status" transition
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let drawn = 0;
  for (let w = 0; w < 300; w++) {
    const N = 3 + Math.floor(rnd() * 10);
    const ids = Array.from({ length: N }, (_, i) => String(i + 1));
    const statuses = new Map(ids.map((id, i) => [id, { name: `S${id}`, category: i === 0 ? 'TODO' : i >= N - 2 ? 'DONE' : 'IN_PROGRESS' }]));
    const tr = (id, from, to, type = 'DIRECTED') => ({ id, name: `t${id}`, type, toStatusReference: to, links: from.map((f) => ({ fromStatusReference: f })), actions: [] });
    const ts = [{ id: '0', type: 'INITIAL', toStatusReference: '1' }];
    for (let i = 1; i < N; i++) ts.push(tr(`c${i}`, [String(1 + Math.floor(rnd() * i))], String(i + 1)));
    for (let e = 0, E = Math.floor(rnd() * N * 1.5); e < E; e++) ts.push(tr(`e${e}`, [ids[Math.floor(rnd() * N)]], ids[Math.floor(rnd() * N)]));
    if (rnd() < 0.4) ts.push(tr('g', [], ids[Math.floor(rnd() * N)], 'GLOBAL'));
    const m = buildModel({ id: 'w', name: 'W', statuses: ids.map((s) => ({ statusReference: s })), transitions: ts }, statuses);
    for (const vertical of [false, true]) {
      const { pos } = layout(m, vertical);
      const floor = Math.max(...[...pos.values()].map((p) => p.y)) + BLOCK_H;
      const through = (pts, own) => pts.some(([x, y]) => [...pos].some(([id, p]) => !own.has(id) && x > p.x + 2 && x < p.x + BLOCK_W - 2 && y > p.y + 2 && y < p.y + BLOCK_H - 2));
      tracks(m).forEach((t, k) => { drawn++; assert.equal(through(sample(trackPath(pos.get(t.from), pos.get(t.to), k % 4, vertical, floor)), new Set([t.from, t.to])), false, `workflow ${w}, ${vertical ? 'top to bottom' : 'left to right'}: ${t.from} to ${t.to}`); });
      m.transitions.filter((t) => t.type === 'GLOBAL').forEach((t, k) => { drawn++; assert.equal(through(sample(globalPath(pos.get(t.to), k, vertical)), new Set([t.to])), false, `workflow ${w}: global to ${t.to}`); });
    }
  }
  assert.ok(drawn > 3000);
});
