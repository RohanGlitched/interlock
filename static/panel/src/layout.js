// Lay a workflow out as a track diagram: statuses are blocks on a line, left to right in the order work
// reaches them from creation; transitions are tracks between blocks; "from any status" transitions drop
// in from an overhead rail.
export const BLOCK_W = 170, BLOCK_H = 42, COL = 236, ROW = 82, TOP = 92, LEFT = 40;

const ORDER = { TODO: 0, IN_PROGRESS: 1, DONE: 2 };

export function layout(model) {
  const directed = model.transitions.filter((t) => t.type !== 'GLOBAL');
  const dist = new Map([[model.initial, 0]]), q = [model.initial];
  while (q.length) {
    const s = q.shift();
    for (const t of directed) if (t.from.includes(s) && !dist.has(t.to)) { dist.set(t.to, dist.get(s) + 1); q.push(t.to); }
  }
  const col = new Map();
  if (dist.size <= 1) {
    // a workflow moved only by "from any status" transitions has no order of its own: read it as a line
    // from to-do statuses through in-progress ones to done ones
    // from to-do statuses through in-progress ones to done ones, wrapped three to a row so it stays legible
    const line = [...model.statuses].sort((a, b) => ORDER[a.category] - ORDER[b.category]);
    const per = line.length > 4 ? 3 : line.length;
    const pos = new Map(line.map((s, i) => [s.id, { x: LEFT + (i % per) * COL, y: TOP + Math.floor(i / per) * ROW }]));
    return { pos, width: LEFT * 2 + (per - 1) * COL + BLOCK_W, height: TOP + Math.ceil(line.length / per) * ROW + 60 };
  } else {
    const maxD = Math.max(...dist.values());
    const catCol = { TODO: 0, IN_PROGRESS: Math.max(1, Math.ceil(maxD / 2)), DONE: maxD + 1 };
    for (const s of model.statuses) col.set(s.id, dist.has(s.id) ? dist.get(s.id) : catCol[s.category] ?? 1);
    const lastCol = Math.max(...col.values());
    for (const s of model.statuses) if (s.category === 'DONE' && !dist.has(s.id)) col.set(s.id, lastCol);
  }
  const byCol = new Map();
  for (const s of model.statuses) { const c = col.get(s.id); if (!byCol.has(c)) byCol.set(c, []); byCol.get(c).push(s); }
  const cols = [...byCol.keys()].sort((a, b) => a - b);
  for (const c of cols) byCol.get(c).sort((a, b) => ORDER[a.category] - ORDER[b.category] || a.name.localeCompare(b.name));
  // fewer crossings: order each column by the average row of its neighbours (two sweeps each way)
  const rowOf = new Map();
  const index = () => { for (const c of cols) byCol.get(c).forEach((s, i) => rowOf.set(s.id, i)); };
  const nbrs = new Map(model.statuses.map((s) => [s.id, []]));
  for (const t of directed) for (const f of t.from) if (f !== t.to && nbrs.has(f) && nbrs.has(t.to)) { nbrs.get(f).push(t.to); nbrs.get(t.to).push(f); }
  index();
  for (let pass = 0; pass < 4; pass++) {
    for (const c of pass % 2 ? [...cols].reverse() : cols) {
      const list = byCol.get(c);
      const score = (s) => { const n = nbrs.get(s.id).filter((x) => col.get(x) !== c); return n.length ? n.reduce((a, x) => a + rowOf.get(x), 0) / n.length : rowOf.get(s.id); };
      list.sort((a, b) => score(a) - score(b)); index();
    }
  }
  const pos = new Map();
  let rows = 1;
  cols.forEach((c, ci) => {
    const list = byCol.get(c);
    list.forEach((s, i) => pos.set(s.id, { x: LEFT + ci * COL, y: TOP + i * ROW }));
    rows = Math.max(rows, list.length);
  });
  return { pos, width: LEFT * 2 + (cols.length - 1) * COL + BLOCK_W, height: TOP + rows * ROW + 60 };
}

// One track per pair of statuses, however many transitions share it.
export function tracks(model) {
  const by = new Map();
  for (const t of model.transitions) {
    if (t.type === 'GLOBAL') continue;
    for (const f of t.from) {
      if (f === t.to) continue;
      const k = `${f}>${t.to}`;
      if (!by.has(k)) by.set(k, { from: f, to: t.to, transitions: [] });
      by.get(k).transitions.push(t);
    }
  }
  return [...by.values()];
}

// A track between two blocks: leaves the right edge, enters the left edge; tracks that run backwards or
// stay in one column loop under the line so they never cross a block.
export function trackPath(a, b, lane = 0) {
  const x1 = a.x + BLOCK_W, y1 = a.y + BLOCK_H / 2, x2 = b.x, y2 = b.y + BLOCK_H / 2;
  if (x2 > x1 + 4) {
    const dx = (x2 - x1) * 0.5;
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }
  const sx = a.x + BLOCK_W / 2 + 18, sy = a.y + BLOCK_H, ex = b.x + BLOCK_W / 2 - 18, ey = b.y + BLOCK_H;
  const dip = Math.max(sy, ey) + 24 + lane * 9;
  return `M${sx},${sy} C${sx},${dip} ${ex},${dip} ${ex},${ey}`;
}

// A "from any status" transition drops from the overhead rail onto the top of its block.
export function globalPath(b, k) {
  const x = b.x + BLOCK_W / 2 + (k % 3) * 14 - 14;
  return `M${x},34 L${x},${b.y}`;
}
