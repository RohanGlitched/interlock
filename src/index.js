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
  const st = await jira(route`/rest/api/3/statuses/search?maxResults=200`);
  const statuses = Object.fromEntries(st.values.map((s) => [s.id, { name: s.name, category: s.statusCategory }]));
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
  const report = await measure(site, checkSite(site, req.payload?.rules || {}));
  // the UI draws each workflow, so it gets the models too (statuses and transitions only)
  const statuses = new Map(Object.entries(site.statuses));
  report.models = Object.fromEntries(site.workflows.map((w) => [w.id, buildModel(w, statuses, { screenHasResolution: new Set(site.screenHasResolution) })]));
  report.projects = site.projects;
  return report;
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
  return f
    ? { holds: false, answer: `No. Work can reach ${payload.target} without passing ${payload.through}.`, counterexample: brief(f).route }
    : { holds: true, answer: `Yes. Every route that reaches ${payload.target} passes ${payload.through}; Interlock checked all ${r.states} reachable states.` };
}
