// Lay a workflow out as a track diagram: statuses are blocks on a line, left to right in the order work
// reaches them from creation; transitions are tracks between blocks; "from any status" transitions drop
// in from an overhead rail.
export const BLOCK_W = 170, BLOCK_H = 42, COL = 236, ROW = 82, TOP = 92, LEFT = 40;

export function layout(model) {
  const directed = model.transitions.filter((t) => t.type !== 'GLOBAL');
  const dist = new Map([[model.initial, 0]]), q = [model.initial];
  while (q.length) {
    const s = q.shift();
    for (const t of directed) if (t.from.includes(s) && !dist.has(t.to)) { dist.set(t.to, dist.get(s) + 1); q.push(t.to); }
  }
  const maxD = Math.max(0, ...dist.values());
  const catCol = { TODO: 0, IN_PROGRESS: Math.max(1, Math.ceil(maxD / 2)), DONE: maxD + 1 };
  const col = new Map();
  for (const s of model.statuses) col.set(s.id, dist.has(s.id) ? dist.get(s.id) : catCol[s.category] ?? 1);
  // done statuses sit at the right end of the line
  const lastCol = Math.max(...col.values());
  for (const s of model.statuses) if (s.category === 'DONE' && !dist.has(s.id)) col.set(s.id, lastCol);
  const byCol = new Map();
  for (const s of model.statuses) { const c = col.get(s.id); if (!byCol.has(c)) byCol.set(c, []); byCol.get(c).push(s); }
  const order = { TODO: 0, IN_PROGRESS: 1, DONE: 2 };
  const pos = new Map();
  let rows = 1;
  for (const [c, list] of byCol) {
    list.sort((a, b) => order[a.category] - order[b.category] || a.name.localeCompare(b.name));
    list.forEach((s, i) => pos.set(s.id, { x: LEFT + c * COL, y: TOP + i * ROW }));
    rows = Math.max(rows, list.length);
  }
  const cols = Math.max(...byCol.keys()) + 1;
  return { pos, width: LEFT * 2 + (cols - 1) * COL + BLOCK_W, height: TOP + rows * ROW + 20 };
}

// A track between two blocks: leaves the right edge, enters the left edge; tracks that run backwards
// loop under the line so they never cross a block.
export function trackPath(a, b, lane = 0) {
  const x1 = a.x + BLOCK_W, y1 = a.y + BLOCK_H / 2, x2 = b.x, y2 = b.y + BLOCK_H / 2;
  if (x2 > x1 + 4) {
    const dx = (x2 - x1) * 0.5;
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }
  const sx = a.x + BLOCK_W / 2, sy = a.y + BLOCK_H, ex = b.x + BLOCK_W / 2, ey = b.y + BLOCK_H;
  const dip = Math.max(sy, ey) + 30 + lane * 10;
  return `M${sx},${sy} C${sx},${dip} ${ex},${dip} ${ex},${ey}`;
}

// A "from any status" transition drops from the overhead rail onto the top of its block.
export function globalPath(b, k) {
  const x = b.x + BLOCK_W / 2 + (k % 3) * 14 - 14;
  return `M${x},34 L${x},${b.y}`;
}
