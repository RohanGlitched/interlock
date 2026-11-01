import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { verify, buildModel } from '../engine/interlock.mjs';

// Interlock reads the site's workflow configuration as the signed-in admin, checks every workflow,
// and can replay a finding on a scratch work item to prove it happens for real.

async function jira(path, init) {
  const res = await api.asUser().requestJira(path, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira answered ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function pool(items, n, fn) { // run fn over items, n at a time
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// Everything the checker needs, in one pass over the site's configuration.
export async function loadSite() {
  const workflows = [];
  for (let startAt = 0; ;) {
    const page = await jira(route`/rest/api/3/workflows/search?startAt=${startAt}&maxResults=50&expand=values.transitions`);
    workflows.push(...page.values);
    if (page.isLast || !page.values.length) break;
    startAt += page.values.length;
  }
  // a large site has thousands of statuses; the search pages at 200
  const statuses = {};
  for (let startAt = 0; ;) {
    const page = await jira(route`/rest/api/3/statuses/search?startAt=${startAt}&maxResults=200`);
    for (const s of page.values) statuses[s.id] = { name: s.name, category: s.statusCategory };
    if (page.isLast || !page.values.length) break;
    startAt += page.values.length;
  }
  const projects = [];
  for (let startAt = 0; ;) {
    const page = await jira(route`/rest/api/3/project/search?startAt=${startAt}&maxResults=50`);
    projects.push(...page.values.map((p) => ({ id: p.id, key: p.key, name: p.name, style: p.style, type: p.projectTypeKey })));
    if (page.isLast || !page.values.length) break;
    startAt += page.values.length;
  }
  // Which projects and work types use each company-managed workflow (via workflow schemes).
  const usage = {};
  const classic = projects.filter((p) => p.style === 'classic');
  await pool(classic, 6, async (p) => {
    const r = await jira(route`/rest/api/3/workflowscheme/project?projectId=${p.id}`).catch(() => null);
    const scheme = r?.values?.[0]?.workflowScheme;
    if (!scheme) return;
    const add = (name, issueType) => { (usage[name] ||= []).push({ project: p.key, projectId: p.id, issueType }); };
    if (scheme.defaultWorkflow) add(scheme.defaultWorkflow, null);
    for (const [issueType, name] of Object.entries(scheme.issueTypeMappings || {})) add(name, issueType);
  });
  // Transition screens that collect the Resolution field set it on the way through.
  const screenIds = [...new Set(workflows.flatMap((w) => w.transitions.map((t) => t.transitionScreen?.parameters?.screenId).filter(Boolean)))];
  const screenHasResolution = [];
  const screenErrors = [];
  await pool(screenIds, 6, async (id) => {
    const tabs = await jira(route`/rest/api/3/screens/${id}/tabs`).catch((e) => { screenErrors.push(`${id}: ${e.message}`); return []; });
    for (const tab of tabs) {
      const fields = await jira(route`/rest/api/3/screens/${id}/tabs/${tab.id}/fields`).catch((e) => { screenErrors.push(`${id}/${tab.id}: ${e.message}`); return []; });
      if (fields.some((f) => f.id === 'resolution')) { screenHasResolution.push(String(id)); return; }
    }
  });
  if (screenErrors.length) console.warn('screens unreadable', screenErrors.slice(0, 3));
  const teamManagedProjects = new Set(projects.filter((p) => p.style === 'next-gen').map((p) => p.id));
  // a team-managed workflow belongs to its one project, so it is used there (no scheme to look up)
  const byId = Object.fromEntries(projects.map((p) => [p.id, p]));
  for (const w of workflows) {
    const pid = w.scope?.type === 'PROJECT' ? w.scope.project?.id : null;
    if (pid && byId[pid] && !usage[w.name]) usage[w.name] = [{ project: byId[pid].key, projectId: pid, issueType: null }];
  }
  return { workflows, statuses, projects, usage, screenHasResolution, teamManagedProjects: [...teamManagedProjects] };
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
  return { checkedAt: new Date().toISOString(), ms: Date.now() - t0, results };
}

const resolver = new Resolver();

// A proof says what can happen; Jira's own data says whether it already has. For each resolution
// finding, count the work items in the projects using that workflow that are in the bad state today.
export async function measure(site, report) {
  const count = async (jql) => (await jira(route`/rest/api/3/search/approximate-count`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jql }),
  })).count;
  const jobs = [];
  for (const r of report.results) {
    const kinds = new Set(r.findings.map((f) => f.property).filter((p) => p === 'doneUnresolved' || p === 'openResolved'));
    if (!kinds.size || !r.usage.length) continue;
    const projects = [...new Set(r.usage.map((u) => u.project))];
    const explicit = r.usage.filter((u) => u.issueType);
    const scope = `project in (${projects.map((p) => `"${p}"`).join(',')})` + (explicit.length && explicit.length === r.usage.length ? ` AND issuetype in (${[...new Set(explicit.map((u) => u.issueType))].join(',')})` : '');
    jobs.push({ r, kinds, scope });
  }
  await pool(jobs, 6, async ({ r, kinds, scope }) => {
    try {
      r.observed = {};
      if (kinds.has('doneUnresolved')) {
        const [bad, done] = await Promise.all([count(`${scope} AND statusCategory = Done AND resolution IS EMPTY`), count(`${scope} AND statusCategory = Done`)]);
        r.observed.doneUnresolved = { bad, of: done, jql: `${scope} AND statusCategory = Done AND resolution IS EMPTY` };
      }
      if (kinds.has('openResolved')) {
        const [bad, open] = await Promise.all([count(`${scope} AND statusCategory != Done AND resolution IS NOT EMPTY`), count(`${scope} AND statusCategory != Done`)]);
        r.observed.openResolved = { bad, of: open, jql: `${scope} AND statusCategory != Done AND resolution IS NOT EMPTY` };
      }
    } catch (e) { r.observedError = e.message; }
  });
  return report;
}

resolver.define('checkSite', async (req) => {
  const site = await loadSite();
  // the proof comes back first; live counts follow in a second call (measureSite) so the page paints fast
  const report = checkSite(site, req.payload?.rules || {});
  // the UI draws each workflow, so it gets the models too (statuses and transitions only)
  const statuses = new Map(Object.entries(site.statuses));
  report.models = Object.fromEntries(site.workflows.map((w) => [w.id, buildModel(w, statuses, { screenHasResolution: new Set(site.screenHasResolution) })]));
  report.projects = site.projects;
  return report;
});

// Count the work items already in each bad state, for the workflows that have resolution findings.
resolver.define('measureSite', async (req) => {
  const site = await loadSite();
  const report = await measure(site, checkSite(site));
  return Object.fromEntries(report.results.filter((r) => r.observed || r.observedError).map((r) => [r.workflow.id, { observed: r.observed, observedError: r.observedError }]));
});

// Replay a finding's route on a new work item: create it where the workflow is used, run each
// transition through Jira, and read back status and resolution after every step.
resolver.define('replay', async (req) => {
  const { project, issueType, hops, label } = req.payload;
  let type = issueType;
  if (!type) {
    const meta = await jira(route`/rest/api/3/issue/createmeta/${project}/issuetypes`);
    type = (meta.issueTypes || meta.values).find((t) => !t.subtask)?.id;
  }
  const created = await jira(route`/rest/api/3/issue`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { project: { key: project }, issuetype: { id: type }, summary: `Interlock replay: ${label}`.slice(0, 250), labels: ['interlock-replay'] } }),
  });
  const steps = [];
  const read = async () => {
    const i = await jira(route`/rest/api/3/issue/${created.key}?fields=status,resolution`);
    return { status: i.fields.status.name, category: i.fields.status.statusCategory.key, resolution: i.fields.resolution?.name || null };
  };
  steps.push({ step: 'Created', ...(await read()) });
  for (const h of hops) {
    const avail = await jira(route`/rest/api/3/issue/${created.key}/transitions`);
    const t = avail.transitions.find((x) => x.id === String(h.transitionId)) || avail.transitions.find((x) => x.name === h.transition);
    if (!t) { steps.push({ step: h.transition, error: 'This transition is not available to you on the replay item' }); break; }
    await jira(route`/rest/api/3/issue/${created.key}/transitions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transition: { id: t.id } }),
    }).catch((e) => steps.push({ step: h.transition, error: e.message }));
    if (steps.at(-1)?.error) break;
    steps.push({ step: h.transition, ...(await read()) });
  }
  return { key: created.key, steps };
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
  const me = await jira(route`/rest/api/3/myself`);
  // 1. the workflow (reuse it if it already exists)
  const existing = await jira(route`/rest/api/3/workflows/search?queryString=${SHIP_WF}`);
  if (!existing.values.some((w) => w.name === SHIP_WF)) {
    const st = await jira(route`/rest/api/3/statuses/search?maxResults=200`);
    const find = (name, cat) => st.values.find((s) => s.name.toLowerCase() === name.toLowerCase() && s.statusCategory === cat);
    const want = [['To Do', 'TODO'], ['In Progress', 'IN_PROGRESS'], ['Code Review', 'IN_PROGRESS'], ['Done', 'DONE']];
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
resolver.define('fix', async (req) => {
  const { workflowId, property, status, mode } = req.payload;
  const got = await jira(route`/rest/api/3/workflows`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowIds: [workflowId] }) });
  const wf = got.workflows?.[0];
  if (!wf) throw new Error('Workflow not found');
  const st = await jira(route`/rest/api/3/statuses/search?maxResults=200`);
  const cat = Object.fromEntries(st.values.map((s) => [s.id, s.statusCategory]));
  const ids = new Set(wf.statuses.map((s) => s.statusReference));
  const all = wf.statuses.map((s) => s.statusReference);
  const changed = [];
  let resolutionName = null;
  if (property === 'doneUnresolved') {
    const res = await jira(route`/rest/api/3/resolution/search`);
    const done = res.values.find((r) => r.name === 'Done') || res.values[0];
    resolutionName = done.name;
    for (const t of wf.transitions) {
      if (t.type === 'INITIAL' || t.toStatusReference !== status) continue;
      const sets = (t.actions || []).some((a) => a.ruleKey === 'system:update-field' && a.parameters?.field === 'resolution' && a.parameters.value);
      if (sets) continue;
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
      t.actions = [...(t.actions || []), { ruleKey: 'system:update-field', parameters: { field: 'resolution', value: '', mode: '' } }];
      changed.push(t.name);
    }
  } else throw new Error('Interlock can repair resolution findings automatically; other findings need a person to redesign the workflow.');
  if (!changed.length) return { changed, note: 'Nothing to change on these transitions.' };
  const statuses = st.values.filter((s) => ids.has(s.id)).map((s) => ({ id: s.id, name: s.name, statusCategory: s.statusCategory, statusReference: s.id }));
  const update = { statuses, workflows: [{ id: wf.id, version: wf.version, name: wf.name, description: wf.description, statuses: wf.statuses, transitions: wf.transitions, startPointLayout: wf.startPointLayout }] };
  const validation = await jira(route`/rest/api/3/workflows/update/validation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload: update }) });
  if (validation.errors?.length) return { changed, resolutionName, valid: false, errors: validation.errors.map((e) => e.message || JSON.stringify(e)) };
  if (mode !== 'apply') return { changed, resolutionName, valid: true };
  await jira(route`/rest/api/3/workflows/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update) });
  return { changed, resolutionName, valid: true, applied: true };
});

export const handler = resolver.getDefinitions();

// ---------- tools for agents (Rovo actions, exposed over MCP) ----------

const findWorkflow = (site, name) => {
  const q = String(name || '').trim().toLowerCase();
  return site.workflows.find((w) => w.name.toLowerCase() === q) || site.workflows.find((w) => w.name.toLowerCase().includes(q));
};

const brief = (f) => ({
  problem: f.title, status: f.subject,
  route: f.route ? [f.route.startName, ...f.route.hops.map((h) => `${h.transition}${h.global ? ' (from any status)' : ''} -> ${h.toName}`)].join(' | ') : undefined,
});

export async function checkWorkflows(payload) {
  const site = await loadSite();
  const report = checkSite(site);
  const project = payload?.projectKey && String(payload.projectKey).toUpperCase();
  const projectId = project && site.projects.find((p) => p.key === project)?.id;
  const results = report.results.filter((r) => !project || r.usage.some((u) => u.project === project) || r.scope?.project?.id === projectId);
  return {
    checked: results.length, msToCheck: report.ms,
    workflowsWithFindings: results.filter((r) => r.findings.length).map((r) => ({
      workflow: r.workflow.name, usedIn: [...new Set(r.usage.map((u) => u.project))],
      findings: r.findings.map(brief),
    })),
  };
}

export async function getWorkflowFindings(payload) {
  const site = await loadSite();
  const w = findWorkflow(site, payload?.workflow);
  if (!w) return { error: `No workflow matches "${payload?.workflow}".` };
  const r = checkSite({ ...site, workflows: [w] }).results[0];
  return { workflow: w.name, statuses: r.statuses, transitions: r.transitions, reachableStates: r.states, propertiesThatHold: r.held, findings: r.findings.map((f) => ({ ...brief(f), why: f.why })) };
}

// "Can work reach <target> without passing <through>?" answered for every route, not a sample.
export async function proveRoute(payload) {
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
