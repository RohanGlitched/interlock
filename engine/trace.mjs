// How did work items already in a bad state get there? For each item, the last status change in its
// history is the step that put it where it is now; count those steps, with what happened to the
// resolution on the way, and say whether each one ends in a status the proof flagged.

// histories: Jira changelog entries ({ created, items: [{ field, fromString, toString }] }) in any order.
export function lastStatusChange(histories = []) {
  // Jira returns history newest first on some endpoints and oldest first on others, so sort by date
  const h = histories.filter((x) => x.items.some((i) => i.field === 'status'))
    .sort((a, b) => new Date(b.created) - new Date(a.created))[0];
  if (!h) return null;
  const st = h.items.find((i) => i.field === 'status');
  const res = h.items.find((i) => i.field === 'resolution');
  const effect = res ? (res.toString ? `resolution set to ${res.toString}` : 'resolution cleared') : 'resolution left as it was';
  return { from: st.fromString, to: st.toString, effect, at: h.created, person: !!h.author };
}

// issues: [{ key, histories }]; flagged: names of the statuses the proof found reachable in the bad state.
// since: optional time (an applied fix); items whose step came before it are counted as left over from before.
export function waysOf(issues, flagged = [], since = null) {
  const on = new Set(flagged.map((s) => s.toLowerCase()));
  const ways = new Map();
  // items with no status change were created or imported in that state; steps with no author are system
  // changes (a migration, a script), not a person using the workflow. Both are counted apart, not blamed on a route.
  let read = 0, noStep = 0, system = 0, beforeSince = 0;
  for (const issue of issues) {
    const step = lastStatusChange(issue.histories);
    if (!step) { noStep++; continue; }
    read++;
    if (!step.person) system++;
    if (since && new Date(step.at) < new Date(since)) beforeSince++;
    const k = `${step.from}→${step.to}|${step.effect}`;
    const w = ways.get(k) || { from: step.from, to: step.to, effect: step.effect, count: 0, example: issue.key, flagged: on.has(String(step.to).toLowerCase()) };
    w.count++;
    ways.set(k, w);
  }
  const all = [...ways.values()].sort((a, b) => b.count - a.count);
  return { read, noStep, system, beforeSince, ways: all.slice(0, 5), onProvedStatus: all.filter((w) => w.flagged).reduce((n, w) => n + w.count, 0) };
}
