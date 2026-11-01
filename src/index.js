import Resolver from '@forge/resolver';
import api, { route, assumeTrustedRoute } from '@forge/api';
import { kvs } from '@forge/kvs';
import { verify, buildModel } from '../engine/interlock.mjs';
import { resolutionFor } from '../engine/resolution.mjs';
import { waysOf } from '../engine/trace.mjs';

// Interlock reads the site's workflow configuration as the signed-in admin, checks every workflow,
// and can replay a finding on a scratch work item to prove it happens for real.

// Jira rate-limits busy sites with 429 (and sometimes 503): wait as long as it asks, up to three times.
async function withRetry(send) {
  for (let i = 0; ; i++) {
    const res = await send();
    if ((res.status !== 429 && res.status !== 503) || i === 3) return res;
    const wait = Math.min(10, Number(res.headers.get('retry-after')) || 2 ** i);
    await new Promise((ok) => setTimeout(ok, wait * 1000));
  }
}

async function jira(path, init) {
  const res = await withRetry(() => api.asUser().requestJira(path, init));
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira answered ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

// The same, as the app itself: used by the daily watch, which runs with no user signed in.
async function jiraApp(path, init) {
  const res = await withRetry(() => api.asApp().requestJira(path, init));
  if (!res.ok) throw new Error(`Jira answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

// Display conditions hide the page from non-admins, but a resolver can be called directly, so the ones
// that change what Interlock proves or records check the caller's global permission themselves.
async function requireAdmin() {
  const p = await jira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`);
  if (!p?.permissions?.ADMINISTER?.havePermission) throw new Error('Only Jira administrators can change what Interlock proves or records.');
}

async function pool(items, n, fn) { // run fn over items, n at a time
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// Everything the checker needs, in one pass over the site's configuration.
export async function loadSite({ asApp = false, fresh = false } = {}) {
  const call = asApp ? jiraApp : jira;
  const pages = async (path, take) => { // follow startAt paging until the last page
    for (let startAt = 0; ;) {
      const page = await call(path(startAt));
      take(page.values);
      if (page.isLast || !page.values.length) return;
      startAt += page.values.length;
    }
  };
  // workflows, statuses (a large site has thousands; the search pages at 200) and projects, read together
  const workflows = [], statuses = {}, projects = [];
  await Promise.all([
    pages((at) => route`/rest/api/3/workflows/search?startAt=${at}&maxResults=50&expand=values.transitions`, (v) => workflows.push(...v)),
    pages((at) => route`/rest/api/3/statuses/search?startAt=${at}&maxResults=200`, (v) => { for (const s of v) statuses[s.id] = { name: s.name, category: s.statusCategory }; }),
    pages((at) => route`/rest/api/3/project/search?startAt=${at}&maxResults=50`, (v) => projects.push(...v.map((p) => ({ id: p.id, key: p.key, name: p.name, style: p.style, type: p.projectTypeKey })))),
  ]);
  // Which projects and work types use each company-managed workflow (via workflow schemes), and which
  // transition screens collect the Resolution field (those set it on the way through). Both are read
  // together; screen answers are remembered for 10 minutes because screens rarely change and a site can
  // have hundreds of them.
  const usage = {}, schemes = {};
  const classic = projects.filter((p) => p.style === 'classic');
  const screenIds = [...new Set(workflows.flatMap((w) => w.transitions.map((t) => t.transitionScreen?.parameters?.screenId).filter(Boolean)))].map(String);
  const cached = fresh ? null : await kvs.get('cache:screens').catch(() => null);
  const known = cached && Date.now() - cached.at < 10 * 60e3 ? cached.screens : {};
  const screens = { ...known };
  const screenErrors = [], unreadable = [];
  await Promise.all([
    pool(classic, 10, async (p) => {
      const r = await call(route`/rest/api/3/workflowscheme/project?projectId=${p.id}`).catch(() => null);
      const scheme = r?.values?.[0]?.workflowScheme;
      if (!scheme) return;
      schemes[p.id] = scheme.issueTypeMappings || {};
      const add = (name, issueType) => { (usage[name] ||= []).push({ project: p.key, projectId: p.id, issueType }); };
      if (scheme.defaultWorkflow) add(scheme.defaultWorkflow, null);
      for (const [issueType, name] of Object.entries(scheme.issueTypeMappings || {})) add(name, issueType);
    }),
    pool(screenIds.filter((id) => !(id in known)), 10, async (id) => {
      const tabs = await call(route`/rest/api/3/screens/${id}/tabs`).catch((e) => { screenErrors.push(`${id}: ${e.message}`); return null; });
      // a screen Interlock cannot read is assumed to ask for the resolution: it may hide a finding, but it
      // never invents one; the report says how many screens were unreadable
      if (!tabs) { unreadable.push(id); return; }
      for (const tab of tabs) {
        const fields = await call(route`/rest/api/3/screens/${id}/tabs/${tab.id}/fields`).catch((e) => { screenErrors.push(`${id}/${tab.id}: ${e.message}`); return null; });
        // a tab that cannot be read makes the whole screen unreadable (never "no resolution", which would invent a finding)
        if (!fields) { unreadable.push(id); return; }
        if (fields.some((f) => f.id === 'resolution')) { screens[id] = true; return; }
      }
      screens[id] = false;
    }),
  ]);
  // the cache keeps the time of its last full read, so every answer in it is at most 10 minutes old
  await kvs.set('cache:screens', { at: Object.keys(known).length ? cached.at : Date.now(), screens }).catch(() => {});
  const screenHasResolution = [...Object.keys(screens).filter((id) => screens[id]), ...unreadable];
  if (screenErrors.length) console.warn(`Interlock: ${screenErrors.length} screen reads failed`);
  const teamManagedProjects = new Set(projects.filter((p) => p.style === 'next-gen').map((p) => p.id));
  // a team-managed workflow belongs to its one project, so it is used there (no scheme to look up)
  const byId = Object.fromEntries(projects.map((p) => [p.id, p]));
  for (const w of workflows) {
    const pid = w.scope?.type === 'PROJECT' ? w.scope.project?.id : null;
    if (pid && byId[pid] && !usage[w.name]) usage[w.name] = [{ project: byId[pid].key, projectId: pid, issueType: null }];
  }
  return { workflows, statuses, projects, usage, schemes, screenHasResolution, unreadableScreens: unreadable.length, teamManagedProjects: [...teamManagedProjects] };
}

export function checkSite(site, rules = {}) {
  const statuses = new Map(Object.entries(site.statuses));
  const screens = new Set(site.screenHasResolution), tm = new Set(site.teamManagedProjects);
  const t0 = Date.now();
  const results = site.workflows.map((w) => {
    const teamManaged = w.scope?.type === 'PROJECT' && tm.has(w.scope.project?.id);
    const r = verify(w, statuses, { screenHasResolution: screens, teamManaged, mustPass: rules[w.id] || [] });
    return { ...r, teamManaged, usage: site.usage[w.name] || [], scope: w.scope };
  });
  return { checkedAt: new Date().toISOString(), ms: Date.now() - t0, results, unreadableScreens: site.unreadableScreens || 0 };
}

const resolver = new Resolver();

// A proof says what can happen; Jira's own data says whether it already has. For each resolution
// finding, count the work items in the projects using that workflow that are in the bad state today.
export async function measure(site, report) {
  const count = async (jql) => (await jira(route`/rest/api/3/search/approximate-count`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jql }),
  })).count;
  const ours = ((await kvs.get('replays').catch(() => null)) || []).filter((k) => /^[A-Z][A-Z0-9_]+-\d+$/.test(k)).slice(0, 200);
  const notOurs = ours.length ? ` AND key not in (${ours.join(', ')})` : '';
  const jobs = [];
  for (const r of report.results) {
    const kinds = new Set(r.findings.map((f) => f.property).filter((p) => p === 'doneUnresolved' || p === 'openResolved'));
    if (!kinds.size || !r.usage.length) continue;
    // Per project: the work types mapped to this workflow, or, where it is the scheme's default, every
    // work type except those the scheme maps to other workflows. No work item is counted twice.
    const byProject = new Map();
    for (const u of r.usage) {
      const e = byProject.get(u.project) || { id: u.projectId, types: new Set(), isDefault: false };
      if (u.issueType) e.types.add(u.issueType); else e.isDefault = true;
      byProject.set(u.project, e);
    }
    const clauses = [...byProject].map(([key, e]) => {
      if (!e.isDefault) return `(project = "${key}" AND issuetype in (${[...e.types].join(',')}))`;
      const elsewhere = Object.entries(site.schemes?.[e.id] || {}).filter(([, name]) => name !== r.workflow.name).map(([t]) => t);
      return elsewhere.length ? `(project = "${key}" AND issuetype not in (${elsewhere.join(',')}))` : `project = "${key}"`;
    });
    // Interlock's own replay work items are evidence of the route, not of the site's data: left out
    const scope = `${clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`}${notOurs}`;
    jobs.push({ r, kinds, scope });
  }
  await pool(jobs, 6, async ({ r, kinds, scope }) => {
    try {
      r.observed = {};
      // and per flagged status, so each finding shows its own items and the rest are visibly something else
      const perStatus = async (property, resClause) => Object.fromEntries(await Promise.all(r.findings.filter((f) => f.property === property && /^\d+$/.test(String(f.status)))
        .map(async (f) => [f.subject, await count(`${scope} AND status = ${f.status} AND ${resClause}`)])));
      if (kinds.has('doneUnresolved')) {
        const [bad, done] = await Promise.all([count(`${scope} AND statusCategory = Done AND resolution IS EMPTY`), count(`${scope} AND statusCategory = Done`)]);
        r.observed.doneUnresolved = { bad, of: done, jql: `${scope} AND statusCategory = Done AND resolution IS EMPTY`, byStatus: bad ? await perStatus('doneUnresolved', 'resolution IS EMPTY') : {} };
      }
      if (kinds.has('openResolved')) {
        const [bad, open] = await Promise.all([count(`${scope} AND statusCategory != Done AND resolution IS NOT EMPTY`), count(`${scope} AND statusCategory != Done`)]);
        r.observed.openResolved = { bad, of: open, jql: `${scope} AND statusCategory != Done AND resolution IS NOT EMPTY`, byStatus: bad ? await perStatus('openResolved', 'resolution IS NOT EMPTY') : {} };
      }
    } catch (e) { r.observedError = e.message; }
  });
  return report;
}

// ---------- the watch: what changed since the last proof ----------
// Every proof (the daily scheduled one, and every check an admin runs) is compared with the previous one.
// A finding that appears is a regression someone introduced by editing a workflow; one that disappears
// was fixed. The last 60 changes are kept so the page can say what changed and when.
const findingKey = (f) => `${f.property}|${f.subject || ''}`;
function snapshotOf(report) {
  // only workflows with findings are kept, so the snapshot stays small on a site with thousands of workflows
  return Object.fromEntries(report.results.filter((r) => r.findings.length).map((r) => [r.workflow.id, { name: r.workflow.name, findings: r.findings.map((f) => ({ key: findingKey(f), title: f.title, subject: f.subject })) }]));
}
export async function recordProof(report, by) {
  const snap = snapshotOf(report), prev = await kvs.get('watch:snapshot');
  const at = new Date().toISOString(), changes = [];
  // a proof that could not read every screen is not compared: it would report changes that are only
  // differences in what Interlock could see
  if (prev && !report.unreadableScreens) {
    for (const [id, cur] of Object.entries(snap)) {
      const before = new Set((prev[id]?.findings || []).map((f) => f.key));
      for (const f of cur.findings) if (!before.has(f.key)) changes.push({ kind: 'new', workflow: cur.name, title: f.title, subject: f.subject });
    }
    for (const [id, old] of Object.entries(prev)) {
      const now = new Set((snap[id]?.findings || []).map((f) => f.key));
      for (const f of old.findings) if (!now.has(f.key)) changes.push({ kind: 'fixed', workflow: old.name, title: f.title, subject: f.subject });
    }
  }
  // the snapshot is written first, so a failure later can never leave the watch diffing an old proof; on a
  // site so large its findings exceed one storage value (240 KiB), the snapshot is dropped and the next
  // proof starts afresh rather than failing every day
  if (!report.unreadableScreens) {
    if (Buffer.byteLength(JSON.stringify(snap)) < 230000) await kvs.set('watch:snapshot', snap);
    else await kvs.delete('watch:snapshot');
  }
  // KVS values are capped at 240 KiB; history keeps the newest entries that fit in about 150 KB
  let history = (await kvs.get('watch:history')) || [];
  if (changes.length) history.unshift({ at, by, changes: changes.slice(0, 50) });
  history = history.slice(0, 60);
  while (history.length > 1 && Buffer.byteLength(JSON.stringify(history)) > 150000) history.pop();
  await kvs.set('watch:history', history);
  const last = { at, by, workflows: report.results.length, withFindings: report.results.filter((r) => r.findings.length).length, unreadableScreens: report.unreadableScreens || 0 };
  await kvs.set('watch:last', last);
  return { last, changes };
}

// The scheduled trigger: once a day, prove every workflow again with nobody watching.
export async function watch() {
  const report = checkSite(await loadSite({ asApp: true, fresh: true }), (await kvs.get('rules')) || {});
  const { changes } = await recordProof(report, 'daily watch');
  console.log(`Interlock watch: ${report.results.length} workflows, ${changes.length} changes since the last proof`);
}

// A finding an admin has looked at and decided is intended (a pre-approved standard-change shortcut, say)
// is recorded with who, when and why. It stops counting as a problem but stays visible, and can be undone.
const intendedKey = (workflowId, property, subject) => `${workflowId}|${property}|${subject || ''}`;
// How did the work items already in a bad state get there? Read the history of up to 50 of them and
// count the status changes that brought each one into its current state, with what happened to the
// resolution on the way. This ties Jira's data back to the route the proof found.
resolver.define('traceItems', async (req) => {
  await requireAdmin();
  const { jql, flagged = [], since = null } = req.payload;
  const res = await jira(route`/rest/api/3/search/jql`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql, maxResults: 50, fields: ['status'], expand: 'changelog' }),
  });
  // search returns only part of a long history; fetch the newest page of the full changelog for those
  const issues = await pool(res.issues || [], 6, async (issue) => {
    const c = issue.changelog || {};
    if ((c.total || 0) <= (c.histories || []).length) return { key: issue.key, histories: c.histories || [] };
    // newest page first, then older pages until one holds a status change (at most 5 pages)
    const histories = [];
    for (let startAt = Math.max(0, c.total - 100), n = 0; n < 5; n++, startAt = Math.max(0, startAt - 100)) {
      const page = await jira(route`/rest/api/3/issue/${issue.key}/changelog?startAt=${startAt}&maxResults=100`).catch(() => null);
      histories.push(...(page?.values || []));
      if (!page || startAt === 0 || (page.values || []).some((h) => h.items.some((i) => i.field === 'status'))) break;
    }
    return { key: issue.key, histories: histories.length ? histories : c.histories || [] };
  });
  return waysOf(issues, flagged, since);
});

resolver.define('saveRules', async (req) => {
  await requireAdmin();
  const all = (await kvs.get('rules')) || {};
  const { workflowId, rules } = req.payload;
  if (rules?.length) all[workflowId] = rules.slice(0, 20); else delete all[workflowId];
  await kvs.set('rules', all);
  return { rules: all };
});

resolver.define('markIntended', async (req) => {
  await requireAdmin();
  const { workflowId, property, subject, reason, undo } = req.payload;
  const all = (await kvs.get('intended')) || {};
  const k = intendedKey(workflowId, property, subject);
  if (undo) delete all[k];
  else {
    const me = await jira(route`/rest/api/3/myself`);
    all[k] = { by: me.displayName, byId: me.accountId, at: new Date().toISOString(), reason: String(reason || '').slice(0, 300) };
  }
  await kvs.set('intended', all);
  return { intended: all };
});

resolver.define('watchStatus', async () => {
  await requireAdmin();
  return { last: await kvs.get('watch:last'), history: ((await kvs.get('watch:history')) || []).slice(0, 10) };
});

resolver.define('checkSite', async (req) => {
  await requireAdmin();
  const site = await loadSite({ fresh: !!req.payload?.fresh });
  // the proof comes back first; live counts follow in a second call (measureSite) so the page paints fast
  // the team's own rules ("Done only through Code Review") are kept in app storage, so the page and the
  // daily watch prove the same thing
  const rules = (await kvs.get('rules').catch(() => null)) || {};
  const report = checkSite(site, rules);
  report.rules = rules;
  report.watch = await recordProof(report, req.context.accountId).catch(() => null);
  report.intended = (await kvs.get('intended').catch(() => null)) || {};
  report.fixes = (await kvs.get('fixes').catch(() => null)) || {};
  // one line of counts per proof in the app logs (no workflow or project names leave in logs)
  console.log(`INTERLOCK_REPORT ${JSON.stringify({ workflows: report.results.length, withFindings: report.results.filter((r) => r.findings.length).length, findings: report.results.reduce((n, r) => n + r.findings.length, 0) })}`);
  // the UI draws each workflow, so it gets the models too (statuses and transitions only)
  const statuses = new Map(Object.entries(site.statuses));
  report.models = Object.fromEntries(site.workflows.map((w) => [w.id, buildModel(w, statuses, { screenHasResolution: new Set(site.screenHasResolution) })]));
  // a resolver answer is capped at 5 MB (about 1,800 workflows' diagrams): on sites that large, only the
  // workflows with findings come with their diagram
  if (Buffer.byteLength(JSON.stringify(report.models)) > 3.5e6) {
    const keep = new Set(report.results.filter((r) => r.findings.length).map((r) => r.workflow.id));
    report.models = Object.fromEntries(Object.entries(report.models).filter(([id]) => keep.has(id)));
    report.modelsPartial = true;
  }
  report.projects = site.projects;
  return report;
});

// Count the work items already in each bad state, for the workflows that have resolution findings.
resolver.define('measureSite', async (req) => {
  await requireAdmin();
  const site = await loadSite();
  const report = await measure(site, checkSite(site));
  return Object.fromEntries(report.results.filter((r) => r.observed || r.observedError).map((r) => [r.workflow.id, { observed: r.observed, observedError: r.observedError }]));
});

// Replay a finding's route on a new work item: create it where the workflow is used, run each
// transition through Jira, and read back status and resolution after every step.
resolver.define('replay', async (req) => {
  await requireAdmin();
  const { project, projectId, issueType, hops, label, startName, workflow } = req.payload;
  let type = issueType;
  if (!type) {
    // the scheme's default workflow applies to every work type it does not map elsewhere, so pick one of those
    const meta = await jira(route`/rest/api/3/issue/createmeta/${project}/issuetypes`);
    const scheme = projectId ? (await jira(route`/rest/api/3/workflowscheme/project?projectId=${projectId}`).catch(() => null))?.values?.[0]?.workflowScheme : null;
    const mapped = scheme?.issueTypeMappings || {};
    type = (meta.issueTypes || meta.values).find((t) => !t.subtask && (!mapped[t.id] || mapped[t.id] === workflow))?.id;
    if (!type) throw new Error(`Every work type in ${project} uses a different workflow, so there is nothing to replay this route on.`);
  }
  const created = await jira(route`/rest/api/3/issue`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { project: { key: project }, issuetype: { id: type }, summary: `Interlock replay: ${label}`.slice(0, 250) } }),
  });
  const steps = [];
  const read = async () => {
    const i = await jira(route`/rest/api/3/issue/${created.key}?fields=status,resolution`);
    return { status: i.fields.status.name, category: i.fields.status.statusCategory.key, resolution: i.fields.resolution?.name || null };
  };
  // record the item as Interlock's own in app storage, which no user can edit (labels and issue
  // properties can be changed by people and automation rules)
  const mine = (await kvs.get('replays')) || [];
  await kvs.set('replays', [created.key, ...mine].slice(0, 500));
  steps.push({ step: 'Created', ...(await read()) });
  // a work item that starts somewhere else is on a different workflow: stop rather than prove the wrong thing
  if (startName && steps[0].status !== startName) {
    return { key: created.key, steps: [...steps, { step: 'Check the workflow', error: `${created.key} started in ${steps[0].status}, not ${startName}, so it follows a different workflow` }] };
  }
  for (const h of hops) {
    const avail = await jira(route`/rest/api/3/issue/${created.key}/transitions?expand=transitions.fields`);
    // match by name and where it leads; transition ids repeat across workflows
    const t = avail.transitions.find((x) => x.name === h.transition && x.to?.name === h.toName)
      || avail.transitions.find((x) => x.name === h.transition);
    if (!t) { steps.push({ step: h.transition, error: 'This transition is not available to you on the replay item' }); break; }
    // where the transition screen asks for a resolution and the route expects one, choose it the way a
    // person filling in the screen would (Done when offered, else the first resolution offered)
    const body = { transition: { id: t.id } };
    const res = t.fields?.resolution;
    if (h.resolution && res?.allowedValues?.length) {
      const pick = resolutionFor(res.allowedValues, h.toName, h.transition);
      body.fields = { resolution: { id: pick.id } };
    }
    await jira(route`/rest/api/3/issue/${created.key}/transitions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch((e) => steps.push({ step: h.transition, error: e.message }));
    if (steps.at(-1)?.error) break;
    steps.push({ step: h.transition, ...(await read()) });
  }
  // automation rules run a moment after a transition; look again so a rule that fixes the resolution counts
  // (only for routes short enough to stay well inside the function's time limit)
  if (!steps.at(-1)?.error && steps.length > 1 && hops.length <= 6) {
    await new Promise((r) => setTimeout(r, 5000));
    const later = await read();
    const last = steps.at(-1);
    if (later.status !== last.status || later.resolution !== last.resolution) steps.push({ step: 'Six seconds later (automation)', ...later });
  }
  return { key: created.key, steps };
});

// Remove a replay work item when the admin is done with it. Only items Interlock created (label and
// summary both match) can be deleted this way, and only with the admin's own delete permission.
resolver.define('deleteReplay', async (req) => {
  await requireAdmin();
  const key = String(req.payload.key || '');
  if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) throw new Error('Not a work item key');
  const i = await jira(route`/rest/api/3/issue/${key}?fields=summary`);
  const ours = ((await kvs.get('replays')) || []).includes(key);
  if (!ours || !i.fields.summary?.startsWith('Interlock replay:')) {
    throw new Error(`${key} was not created by an Interlock replay, so Interlock will not delete it`);
  }
  await jira(route`/rest/api/3/issue/${key}`, { method: 'DELETE' });
  await kvs.set('replays', ((await kvs.get('replays')) || []).filter((k) => k !== key));
  return { deleted: key };
});

// ---------- the Ship demo, for empty sites ----------
// A software delivery workflow with the shortcuts teams add over time: "Close" from any status (skips
// Code Review and sets no resolution) and "Reopen" (keeps the resolution). Built through the same public
// APIs an admin would use, then filled with realistic tickets moved along real routes.

const SHIP_WF = 'Ship: Software delivery workflow';
const SHIP_TICKETS = [
  ['Checkout: retry failed card payments once before showing an error', 'review'],
  ['Search: debounce queries typed faster than 150 ms', 'review'],
  ['Upgrade the payments SDK to 7.2', 'close'],
  ['Fix flaky test OrderHistorySpec.shows_refunds', 'close'],
  ['Mobile: dark mode contrast on the receipts screen', 'review'],
  ['Rate-limit the password reset endpoint', 'review'],
  ['Remove the legacy coupon service', 'close'],
  ['Hotfix: cart total ignores free-shipping threshold', 'close'],
  ['Add an index on orders(customer_id, created_at)', 'review'],
  ['Log the request id in every API error response', 'reopen'],
  ['Feature flag: one-click reorder', 'review'],
  ['Bump Node to 24 in CI images', 'close'],
  ['Inventory sync drops items with emoji in the SKU name', 'reopen'],
  ['Accessibility: focus order on the address form', 'progress'],
  ['Invoice PDF shows the wrong VAT number for EU customers', 'progress'],
  ['Migrate cron jobs to the job scheduler', 'review-wait'],
  ['Alert when the refund queue is older than 15 minutes', 'review-wait'],
  ['Clean up unused S3 buckets', 'close'],
  ['Customer export times out over 50,000 rows', 'todo'],
  ['Support Apple Pay on the web checkout', 'todo'],
];
const SHIP_ROUTES = {
  review: ['Start work', 'Ready for review', 'Approve'],
  close: ['Start work', 'Close'],
  reopen: ['Start work', 'Ready for review', 'Approve', 'Reopen'],
  progress: ['Start work'],
  'review-wait': ['Start work', 'Ready for review'],
  todo: [],
};

resolver.define('demoSetup', async (req) => {
  await requireAdmin();
  const me = await jira(route`/rest/api/3/myself`);
  // 1. the workflow (reuse it if it already exists)
  const existing = await jira(route`/rest/api/3/workflows/search?queryString=${SHIP_WF}`);
  if (!existing.values.some((w) => w.name === SHIP_WF)) {
    const want = [['To Do', 'TODO'], ['In Progress', 'IN_PROGRESS'], ['Code Review', 'IN_PROGRESS'], ['Done', 'DONE']];
    // look each status up by name, so a site with thousands of statuses reuses the existing ones
    const found = await Promise.all(want.map(([name]) => jira(route`/rest/api/3/statuses/search?searchString=${name}&maxResults=50`)));
    const st = { values: found.flatMap((f) => f.values) };
    const find = (name, cat) => st.values.find((s) => s.name.toLowerCase() === name.toLowerCase() && s.statusCategory === cat);
    const statuses = want.map(([name, cat]) => { const e = find(name, cat); return e ? { id: e.id, name: e.name, statusCategory: cat, statusReference: e.id } : { name, statusCategory: cat, statusReference: crypto.randomUUID() }; });
    const R = Object.fromEntries(want.map(([n], i) => [n, statuses[i].statusReference]));
    const res = await jira(route`/rest/api/3/resolution/search`);
    const doneRes = (res.values.find((r) => r.name === 'Done') || res.values[0]).id;
    const tr = (id, name, type, to, from, actions = []) => ({ id: String(id), name, type, toStatusReference: to, links: from.map((f) => ({ fromStatusReference: f })), actions, validators: [], triggers: [], properties: {} });
    const body = { scope: { type: 'GLOBAL' }, statuses, workflows: [{
      name: SHIP_WF, description: 'Created by Interlock as a demo: a delivery workflow with the shortcuts teams add over time.', startPointLayout: { x: -100, y: 0 },
      statuses: Object.values(R).map((r, i) => ({ statusReference: r, layout: { x: i * 200, y: 0 }, properties: {} })),
      transitions: [tr(1, 'Create', 'INITIAL', R['To Do'], []), tr(11, 'Start work', 'DIRECTED', R['In Progress'], [R['To Do']]),
        tr(21, 'Ready for review', 'DIRECTED', R['Code Review'], [R['In Progress']]),
        tr(31, 'Approve', 'DIRECTED', R['Done'], [R['Code Review']], [{ ruleKey: 'system:update-field', parameters: { field: 'resolution', value: doneRes, mode: '' } }]),
        tr(41, 'Request changes', 'DIRECTED', R['In Progress'], [R['Code Review']]),
        tr(51, 'Close', 'GLOBAL', R['Done'], []), tr(61, 'Reopen', 'DIRECTED', R['To Do'], [R['Done']])],
    }] };
    await jira(route`/rest/api/3/workflows/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  // 2. a scheme that uses it, and 3. a company-managed software project on that scheme
  const schemes = await jira(route`/rest/api/3/workflowscheme?maxResults=50`);
  let scheme = schemes.values.find((s) => s.name === 'Ship workflow scheme');
  if (!scheme) scheme = await jira(route`/rest/api/3/workflowscheme`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ship workflow scheme', description: 'Created by Interlock for the Ship demo.', defaultWorkflow: SHIP_WF }) });
  let key = 'SHIP';
  for (let n = 2; ; n++) {
    const r = await api.asUser().requestJira(route`/rest/api/3/project/${key}`);
    if (r.status === 404) break;
    key = `SHIP${n}`;
  }
  await jira(route`/rest/api/3/project`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    key, name: key === 'SHIP' ? 'Ship (Interlock demo)' : `Ship ${key.slice(4)} (Interlock demo)`, projectTypeKey: 'software', leadAccountId: me.accountId,
    assigneeType: 'UNASSIGNED', workflowScheme: scheme.id, description: 'Demo project created by Interlock: real tickets moved along real routes of the Ship workflow.',
  }) });
  // 4. the tickets
  const meta = await jira(route`/rest/api/3/issue/createmeta/${key}/issuetypes`);
  const type = (meta.issueTypes || meta.values).find((t) => t.name === 'Task') || (meta.issueTypes || meta.values).find((t) => !t.subtask);
  const created = await jira(route`/rest/api/3/issue/bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    issueUpdates: SHIP_TICKETS.map(([summary]) => ({ fields: { project: { key }, issuetype: { id: type.id }, summary } })),
  }) });
  return { project: key, moves: created.issues.map((i, n) => ({ key: i.key, route: SHIP_ROUTES[SHIP_TICKETS[n][1]] })) };
});

// Move a few demo tickets along their routes (called in small batches to stay inside Forge's time limit).
resolver.define('demoMove', async (req) => {
  await requireAdmin();
  for (const { key, route: steps } of req.payload.moves) {
    for (const name of steps) {
      const avail = await jira(route`/rest/api/3/issue/${key}/transitions`);
      const t = avail.transitions.find((x) => x.name === name);
      if (!t) break;
      await jira(route`/rest/api/3/issue/${key}/transitions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transition: { id: t.id } }) });
    }
  }
  return { ok: true };
});

// Repair a resolution finding at its cause, then prove it again. "validate" asks Jira to check the change
// without saving it; "apply" saves it (an admin clicks Apply after seeing exactly what will change).
// The statuses of one workflow, fetched by id (50 at a time), so a site with thousands of statuses works.
async function statusesById(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    // status ids are numbers; anything else is dropped before it reaches the query string
    const q = ids.slice(i, i + 50).filter((id) => /^\d+$/.test(id)).map((id) => `id=${id}`).join('&');
    if (q) out.push(...(await jira(assumeTrustedRoute(`/rest/api/3/statuses?${q}`))));
  }
  return out;
}

// Does this transition screen ask the person for a resolution? Then the person chooses it, and a fix must
// not overwrite their choice (a "Won't Do" must stay "Won't Do").
async function screenAsksResolution(screenId) {
  if (!screenId) return false;
  const tabs = await jira(route`/rest/api/3/screens/${screenId}/tabs`).catch(() => []);
  for (const tab of tabs) {
    const fields = await jira(route`/rest/api/3/screens/${screenId}/tabs/${tab.id}/fields`).catch(() => []);
    if (fields.some((f) => f.id === 'resolution')) return true;
  }
  return false;
}

const RES_ACTION = (a) => a.ruleKey === 'system:update-field' && a.parameters?.field === 'resolution';

// Fixes are kept one per workflow, property and status, with each changed transition's actions before and
// after, so Undo puts back exactly what was there, and refuses if someone has edited those transitions since.
const fixKey = (workflowId, property, status) => `${workflowId}|${property}|${status}`;
resolver.define('fix', async (req) => {
  await requireAdmin();
  const { workflowId, property, status, mode } = req.payload;
  const fixes = (await kvs.get('fixes')) || {};
  const record = fixes[fixKey(workflowId, property, status)];
  const got = await jira(route`/rest/api/3/workflows`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowIds: [workflowId] }) });
  const wf = got.workflows?.[0];
  if (!wf) throw new Error('Workflow not found');
  const all = wf.statuses.map((s) => s.statusReference);
  const st = await statusesById(all);
  const cat = Object.fromEntries(st.map((s) => [s.id, s.statusCategory]));
  const changed = [];
  let resolutionName = null;
  const before = {}; // each changed transition's actions before the fix, so Undo can put them back exactly
  if (mode === 'undo') {
    if (!record) throw new Error('Interlock has no record of this fix, so it cannot take it back.');
    for (const t of wf.transitions) {
      if (!(t.id in record.before)) continue;
      if (record.after && JSON.stringify(t.actions || []) !== JSON.stringify(record.after[t.id])) throw new Error(`"${t.name}" has been edited since Interlock fixed it, so Undo would overwrite that edit. Change it back in the workflow editor instead.`);
      t.actions = record.before[t.id];
      changed.push(t.name);
    }
  } else if (property === 'doneUnresolved') {
    const res = await jira(route`/rest/api/3/resolution/search`);
    const target = st.find((s) => s.id === status)?.name;
    const done = resolutionFor(res.values, target);
    resolutionName = done.name;
    for (const t of wf.transitions) {
      if (t.type === 'INITIAL' || t.toStatusReference !== status) continue;
      const sets = (t.actions || []).some((a) => RES_ACTION(a) && a.parameters.value);
      if (sets) continue;
      if (await screenAsksResolution(t.transitionScreen?.parameters?.screenId)) continue;
      before[t.id] = t.actions || [];
      t.actions = [...(t.actions || []), { ruleKey: 'system:update-field', parameters: { field: 'resolution', value: done.id, mode: '' } }];
      changed.push(t.name);
    }
  } else if (property === 'openResolved') {
    for (const t of wf.transitions) {
      if (t.type === 'INITIAL' || t.toStatusReference !== status) continue;
      const from = t.type === 'GLOBAL' ? all : (t.links || []).map((l) => l.fromStatusReference);
      if (!from.some((f) => cat[f] === 'DONE')) continue;
      const clears = (t.actions || []).some((a) => a.ruleKey === 'system:update-field' && a.parameters?.field === 'resolution' && !a.parameters.value);
      if (clears) continue;
      before[t.id] = t.actions || [];
      t.actions = [...(t.actions || []), { ruleKey: 'system:update-field', parameters: { field: 'resolution', value: '', mode: '' } }];
      changed.push(t.name);
    }
  } else throw new Error('Interlock can repair resolution findings automatically; other findings need a person to redesign the workflow.');
  if (!changed.length) return { changed, note: property === 'openResolved'
    ? 'Nothing to change: every transition back to this status from a done status already clears the resolution.'
    : 'Nothing to change: every transition into this status already sets the resolution or asks the person for one.' };
  // statuses go back with their descriptions, or the update would blank them site-wide
  const statuses = st.map((s) => ({ id: s.id, name: s.name, description: s.description || '', statusCategory: s.statusCategory, statusReference: s.id }));
  const update = { statuses, workflows: [{ id: wf.id, version: wf.version, name: wf.name, description: wf.description, statuses: wf.statuses, transitions: wf.transitions, startPointLayout: wf.startPointLayout }] };
  const validation = await jira(route`/rest/api/3/workflows/update/validation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload: update }) });
  if (validation.errors?.length) return { changed, resolutionName, valid: false, errors: validation.errors.map((e) => e.message || JSON.stringify(e)) };
  if (mode !== 'apply' && mode !== 'undo') return { changed, resolutionName, valid: true };
  await jira(route`/rest/api/3/workflows/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update) });
  const k = fixKey(workflowId, property, status);
  if (mode === 'undo') delete fixes[k];
  else {
    const after = Object.fromEntries(wf.transitions.filter((t) => t.id in before).map((t) => [t.id, t.actions]));
    fixes[k] = { workflowId, property, status, statusName: st.find((s) => s.id === status)?.name, before, after, transitions: changed, at: new Date().toISOString(), name: wf.name };
  }
  await kvs.set('fixes', fixes);
  return { changed, resolutionName, valid: true, applied: true, before };
});

export const handler = resolver.getDefinitions();

// ---------- tools for agents (Rovo actions, exposed over MCP) ----------

// exact name first; otherwise a part of the name that matches exactly one workflow (never a guess)
const findWorkflow = (site, name) => {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return null;
  const exact = site.workflows.find((w) => w.name.toLowerCase() === q);
  if (exact) return exact;
  const some = site.workflows.filter((w) => w.name.toLowerCase().includes(q));
  return some.length === 1 ? some[0] : null;
};

const brief = (f) => ({
  problem: f.title, status: f.subject,
  route: f.route ? [f.route.startName, ...f.route.hops.map((h) => `${h.transition}${h.global ? ' (from any status)' : ''} -> ${h.toName}`)].join(' | ') : undefined,
});

// The agents see what the page sees: the team's saved rules are proved, and findings an admin recorded
// as intended are reported apart, not as problems.
async function agentReport(site) {
  const report = checkSite(site, (await kvs.get('rules').catch(() => null)) || {});
  const intended = (await kvs.get('intended').catch(() => null)) || {};
  for (const r of report.results) {
    const isIntended = (f) => intended[`${r.workflow.id}|${f.property}|${f.subject || ''}`];
    r.intended = r.findings.filter(isIntended);
    r.findings = r.findings.filter((f) => !isIntended(f));
  }
  return report;
}

async function checkWorkflowsInner(payload) {
  const site = await loadSite();
  const report = await agentReport(site);
  const project = payload?.projectKey && String(payload.projectKey).toUpperCase();
  const projectId = project && site.projects.find((p) => p.key === project)?.id;
  const results = report.results.filter((r) => !project || r.usage.some((u) => u.project === project) || r.scope?.project?.id === projectId);
  return {
    checked: results.length, msToCheck: report.ms,
    // at most 50 workflows in one answer, so it stays readable for an agent; the count says how many there are
    workflowsWithFindings: results.filter((r) => r.findings.length).slice(0, 50).map((r) => ({
      workflow: r.workflow.name, usedIn: [...new Set(r.usage.map((u) => u.project))],
      findings: r.findings.map(brief), recordedAsIntended: r.intended.length || undefined,
    })),
    totalWithFindings: results.filter((r) => r.findings.length).length,
  };
}

async function getWorkflowFindingsInner(payload) {
  const site = await loadSite();
  const w = findWorkflow(site, payload?.workflow);
  if (!w) return { error: `No single workflow matches "${payload?.workflow}". Give its full name.` };
  const r = (await agentReport({ ...site, workflows: [w] })).results[0];
  return { workflow: w.name, statuses: r.statuses, transitions: r.transitions, reachableStates: r.states, propertiesThatHold: r.held, findings: r.findings.map((f) => ({ ...brief(f), why: f.why })) };
}

// "Can work reach <target> without passing <through>?" answered for every route, not a sample.
async function proveRouteInner(payload) {
  const site = await loadSite();
  const w = findWorkflow(site, payload?.workflow);
  if (!w) return { error: `No workflow matches "${payload?.workflow}".` };
  const statuses = new Map(Object.entries(site.statuses));
  const byName = (n) => w.statuses.map((s) => s.statusReference).find((id) => statuses.get(id)?.name.toLowerCase() === String(n || '').trim().toLowerCase());
  const target = byName(payload.target), via = byName(payload.through);
  if (!target || !via) return { error: `Use status names from this workflow: ${w.statuses.map((s) => statuses.get(s.statusReference)?.name).join(', ')}.` };
  const r = checkSite({ ...site, workflows: [w] }, { [w.id]: [{ target, via }] }).results[0];
  const f = r.findings.find((x) => x.property === 'mustPass');
  // `ruleHolds` is about the rule "every route to target passes through"; the answer sentence states the
  // finding plainly so it reads right whichever way the user phrased the question.
  return f
    ? { ruleHolds: false, canSkip: true, answer: `Work CAN reach ${payload.target} without passing ${payload.through}. The rule "${payload.target} only through ${payload.through}" is broken by this route.`, counterexample: brief(f).route }
    : { ruleHolds: true, canSkip: false, answer: `Work can NOT reach ${payload.target} without passing ${payload.through}: every route to ${payload.target} goes through ${payload.through}. Interlock checked all ${r.states} reachable states.` };
}

// Rovo and MCP callers who are not Jira admins cannot read workflow configuration; tell them so plainly.
const forAdmins = (fn) => async (payload) => {
  try { return await fn(payload); }
  catch (e) {
    if (/Jira answered (401|403)/.test(e.message)) return { error: 'Interlock reads workflow configuration, which only Jira administrators can see. Ask a Jira admin to run this check.' };
    throw e;
  }
};
export const checkWorkflows = forAdmins(checkWorkflowsInner);
export const getWorkflowFindings = forAdmins(getWorkflowFindingsInner);
export const proveRoute = forAdmins(proveRouteInner);
