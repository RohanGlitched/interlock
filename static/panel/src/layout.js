// Lay a workflow out as a track diagram: statuses are blocks on a line, left to right in the order work
// reaches them from creation; transitions are tracks between blocks; "from any status" transitions drop
// in from an overhead rail.
export const BLOCK_W = 170, BLOCK_H = 42, COL = 236, ROW = 82, TOP = 92, LEFT = 40;

const ORDER = { TODO: 0, IN_PROGRESS: 1, DONE: 2 };

// The same diagram can run top to bottom: columns become rows. The page picks whichever fills its frame
// better, so a short, wide workflow in a tall frame is drawn large instead of in a strip.
export const VCOL = 204, VROW = 96;
export function layout(model, vertical = false) {
  const h = layoutLine(model);
  if (!vertical) return h;
  const pos = new Map();
  let rows = 1, cols = 1;
  for (const [id, p] of h.pos) {
    const ci = Math.round((p.x - LEFT) / COL), ri = Math.round((p.y - TOP) / ROW);
    pos.set(id, { x: LEFT + ri * VCOL, y: TOP + ci * VROW });
    rows = Math.max(rows, ri + 1); cols = Math.max(cols, ci + 1);
  }
  return { pos, vertical: true, width: LEFT * 2 + (rows - 1) * VCOL + BLOCK_W, height: TOP + cols * VROW + 40 };
}

function layoutLine(model) {
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
    const per = Math.min(3, line.length);
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
export function trackPath(a, b, lane = 0, vertical = false) {
  if (vertical) {
    // top to bottom: leave the bottom edge, enter the top edge; tracks that run back loop round the right
    if (b.y > a.y + 4) {
      const x1 = a.x + BLOCK_W / 2 + lane * 8 - 12, y1 = a.y + BLOCK_H, x2 = b.x + BLOCK_W / 2 + lane * 8 - 12, y2 = b.y, dy = (y2 - y1) * 0.5;
      return `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`;
    }
    const sx = a.x + BLOCK_W, sy = a.y + BLOCK_H / 2 + 6, ex = b.x + BLOCK_W, ey = b.y + BLOCK_H / 2 - 6;
    const bulge = Math.max(sx, ex) + 22 + lane * 9;
    return `M${sx},${sy} C${bulge},${sy} ${bulge},${ey} ${ex},${ey}`;
  }
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
export function globalPath(b, k, vertical = false) {
  // top to bottom: the rail runs down the left edge and each drop runs along the gap above its block's row
  if (vertical) { const x = b.x + 22 + (k % 3) * 12, y = b.y - 24 - (k % 2) * 6; return `M16,${y} L${x},${y} L${x},${b.y}`; }
  const x = b.x + BLOCK_W / 2 + (k % 3) * 14 - 14;
  return `M${x},34 L${x},${b.y}`;
}
