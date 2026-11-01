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
  await pool(screenIds, 6, async (id) => {
    const tabs = await jira(route`/rest/api/3/screens/${id}/tabs`).catch(() => []);
    for (const tab of tabs) {
      const fields = await jira(route`/rest/api/3/screens/${id}/tabs/${tab.id}/fields`).catch(() => []);
      if (fields.some((f) => f.id === 'resolution')) { screenHasResolution.push(String(id)); return; }
    }
  });
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

resolver.define('checkSite', async (req) => {
  const site = await loadSite();
  const report = checkSite(site, req.payload?.rules || {});
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
