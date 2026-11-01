// One door to Forge. Inside Jira this is @forge/bridge; under `vite dev` a stand-in runs the same engine
// on a saved copy of a site's workflows, so the panel can be built and tested in a plain browser.
import { verify, buildModel } from '../../../engine/interlock.mjs';

const DEV = import.meta.env.DEV;
const forgeP = DEV ? null : import('@forge/bridge'); // the bridge throws as soon as it loads outside Jira

async function devInvoke(fn, payload = {}) {
  if (fn === 'checkSite') {
    const d = await (await fetch('/dev/site.json')).json();
    const statuses = new Map(d.statuses.values.map((s) => [s.id, { name: s.name, category: s.statusCategory }]));
    const t0 = performance.now();
    const results = d.workflows.map((w) => ({ ...verify(w, statuses, { mustPass: payload.rules?.[w.id] || [] }), teamManaged: false, usage: [{ project: 'DESIGN', issueType: null }], scope: w.scope }));
    return {
      checkedAt: new Date().toISOString(), ms: Math.round(performance.now() - t0), results,
      models: Object.fromEntries(d.workflows.map((w) => [w.id, buildModel(w, statuses)])), projects: [],
      intended: JSON.parse(localStorage.getItem('il-intended') || '{}'),
    };
  }
  if (fn === 'replay') {
    await new Promise((r) => setTimeout(r, 600));
    const steps = [{ step: 'Created', status: payload.startName, category: 'new', resolution: null }];
    for (const h of payload.hops) { await new Promise((r) => setTimeout(r, 500)); steps.push({ step: h.transition, status: h.toName, category: 'done', resolution: null }); }
    return { key: 'DESIGN-41', steps };
  }
  if (fn === 'saveRules') return { rules: {} };
  if (fn === 'markIntended') {
    const all = JSON.parse(localStorage.getItem('il-intended') || '{}');
    const k = `${payload.workflowId}|${payload.property}|${payload.subject || ''}`;
    if (payload.undo) delete all[k]; else all[k] = { by: 'You', at: new Date().toISOString(), reason: payload.reason };
    localStorage.setItem('il-intended', JSON.stringify(all));
    return { intended: all };
  }
  if (fn === 'watchStatus') {
    const at = new Date(Date.now() - 3 * 3600e3).toISOString();
    return { last: { at, by: 'daily watch', workflows: 97, withFindings: 29 }, history: [
      { at, by: 'daily watch', changes: [{ kind: 'new', workflow: 'ITS: Change Management workflow for Jira Service Management', title: 'Done but unresolved', subject: 'Completed' }] },
      { at: new Date(Date.now() - 27 * 3600e3).toISOString(), by: 'admin', changes: [{ kind: 'fixed', workflow: 'PROC: Procurement Workflow', title: 'Done but unresolved', subject: 'Purchased' }] },
    ] };
  }
  throw new Error('no dev handler for ' + fn);
}

export const invoke = DEV ? devInvoke : async (fn, payload) => (await forgeP).invoke(fn, payload);
export async function enableTheme() { if (!DEV) await (await forgeP).view.theme.enable(); }
export async function openPath(path) {
  if (DEV) { window.open(path, '_blank'); return; }
  const { router } = await forgeP;
  router.open(path);
}

export async function openIssue(key) {
  if (DEV) return;
  const { router } = await forgeP;
  router.open(`/browse/${key}`);
}
