// Read-only: how did the work items on a public Jira site reach a bad state? The same method as
// Interlock's "How did they get there?": the last status change on each item, with what happened to
// the resolution and whether a person or the system made it.
// Usage: node public-trace.mjs <host/path> "<jql>" [max items]
const [host, jql, n = '500'] = process.argv.slice(2);
const ways = new Map(), people = new Set(), days = new Set();
let total = 0, read = 0, noStep = 0, noAuthor = 0;
for (let at = 0; at < Number(n); at += 50) {
  const q = new URLSearchParams({ jql, startAt: at, maxResults: Math.min(50, Number(n) - at), fields: 'status', expand: 'changelog' });
  const page = await (await fetch(`https://${host}/rest/api/2/search?${q}`)).json();
  if (!page.issues) { console.error(JSON.stringify(page).slice(0, 300)); process.exit(1); }
  total = page.total;
  for (const issue of page.issues) {
    read++;
    let hs = issue.changelog?.histories || [];
    if ((issue.changelog?.total || 0) > hs.length) hs = (await (await fetch(`https://${host}/rest/api/2/issue/${issue.key}?expand=changelog&fields=status`)).json()).changelog?.histories || hs;
    const last = [...hs].sort((a, b) => new Date(b.created) - new Date(a.created)).find((h) => h.items.some((i) => i.field === 'status'));
    if (!last) { noStep++; continue; }
    if (!last.author) noAuthor++; else { people.add(last.author.accountId || last.author.name); days.add(last.created.slice(0, 10)); }
    const st = last.items.find((i) => i.field === 'status'), ri = last.items.find((i) => i.field === 'resolution');
    const effect = ri ? (ri.toString ? `resolution set to ${ri.toString}` : 'resolution cleared') : 'resolution left as it was';
    const k = `${issue.key.split('-')[0]} ${st.fromString} -> ${st.toString} | ${effect}`;
    const w = ways.get(k) || { k, count: 0, examples: [] };
    w.count++; if (w.examples.length < 3) w.examples.push(issue.key);
    ways.set(k, w);
  }
  if (at + 50 >= page.total) break;
}
console.log(`${total} match; read ${read}; ${noStep} have no status change; ${noAuthor} last steps have no author; people ${people.size} over ${days.size} days`);
for (const w of [...ways.values()].sort((a, b) => b.count - a.count).slice(0, 15)) console.log(w.count, w.k, w.examples.join(' '));
