// Interlock: a model checker for Jira workflows. It explores every state a work item can reach,
// as (status, resolution set or empty), and proves or refutes properties about them. Each refuted
// property comes back with the shortest route that breaks it, so it can be shown and replayed.
// Pure JS, no dependencies: runs in Forge functions, in the browser, and in the CLI.

export const PROPERTIES = {
  stranded: { title: 'Work can get stuck', why: 'A work item can reach a status from which no route leads to a done status.' },
  doneUnresolved: { title: 'Done but unresolved', why: 'A route reaches a done status without setting a resolution, so the item still counts as unresolved in filters, dashboards and reports.' },
  openResolved: { title: 'Reopened but still resolved', why: 'A route leaves a done status without clearing the resolution, so open work counts as resolved and keeps its old resolved date.' },
  unreachable: { title: 'Status nobody can reach', why: 'No route from creation leads to this status.' },
  nobody: { title: 'Transition nobody can use', why: 'Its conditions allow no user, role, group or permission, so the button never appears.' },
  mustPass: { title: 'Route skips a required status', why: 'Work can reach the target without passing the status your rule requires.' },
  approvalSkipped: { title: 'Done without approval', why: 'This workflow asks for an approval, but a route reaches a successful done status without passing any approval step, so work can be completed without anyone approving it.' },
};

const RES_FIELD = 'resolution';

// Turn the REST shape (GET /rest/api/3/workflows/search?expand=values.transitions) into a small model.
// statuses: Map id -> { name, category: 'TODO' | 'IN_PROGRESS' | 'DONE' }
// screenHasResolution: Set of transition screen ids whose tabs include the Resolution field.
export function buildModel(workflow, statuses, { screenHasResolution = new Set(), teamManaged = false } = {}) {
  const ids = workflow.statuses.map((s) => s.statusReference);
  const props = new Map(workflow.statuses.map((s) => [s.statusReference, s.properties || {}]));
  // Jira Service Management marks an approval step with approval.* properties on the status
  const st = ids.map((id) => ({ id, name: statuses.get(id)?.name || id, category: statuses.get(id)?.category || 'IN_PROGRESS',
    approval: Object.keys(props.get(id) || {}).some((k) => k.startsWith('approval.')) }));
  let initial = null;
  const transitions = [];
  for (const t of workflow.transitions) {
    if (t.type === 'INITIAL') { initial = t.toStatusReference; continue; }
    const from = t.type === 'GLOBAL' ? ids : (t.links || []).map((l) => l.fromStatusReference).filter(Boolean);
    let resolution = null; // 'set' | 'clear' | null (unchanged)
    for (const a of t.actions || []) {
      if (a.ruleKey === 'system:update-field' && a.parameters?.field === RES_FIELD) resolution = a.parameters.value ? 'set' : 'clear';
    }
    const screenId = t.transitionScreen?.parameters?.screenId || null;
    if (!resolution && screenId && screenHasResolution.has(String(screenId))) resolution = 'set';
    transitions.push({
      id: t.id, name: t.name, type: t.type, from, to: t.toStatusReference, resolution, screenId,
      conditions: flattenConditions(t.conditions), conditionTree: treeOf(t.conditions), validators: (t.validators || []).map((v) => ({ key: v.ruleKey, params: v.parameters || {} })),
    });
  }
  return { id: workflow.id, name: workflow.name, statuses: st, transitions, initial, teamManaged };
}

// Jira's condition groups: { operation: 'ALL' | 'ANY', conditions: [rules], conditionGroups: [groups] }
function treeOf(c) {
  if (!c) return null;
  return {
    op: c.operation === 'ANY' ? 'ANY' : 'ALL',
    rules: (c.conditions || []).map((r) => ({ key: r.ruleKey, params: r.parameters || {} })),
    groups: (c.conditionGroups || []).map(treeOf).filter(Boolean),
  };
}

// Does one rule let at least one person through? A restrict-transition rule that names nobody does not;
// every other rule is assumed to let someone through (Interlock does not claim more than it can see).
const ruleAllows = (r) => r.key !== 'system:restrict-issue-transition'
  || ['accountIds', 'roleIds', 'groupIds', 'permissionKeys', 'groupCustomFields', 'allowUserCustomFields'].some((k) => r.params[k]);

function treeAllows(tree) {
  if (!tree) return true;
  const parts = [...tree.rules.map(ruleAllows), ...tree.groups.map(treeAllows)];
  if (!parts.length) return true;
  return tree.op === 'ANY' ? parts.some(Boolean) : parts.every(Boolean);
}

function flattenConditions(c) {
  if (!c) return [];
  const out = (c.conditions || []).map((r) => ({ key: r.ruleKey, params: r.parameters || {} }));
  for (const g of c.conditionGroups || []) out.push(...flattenConditions(g));
  return out;
}

// A transition is usable by nobody when its conditions, read as ALL/ANY groups, let no one through.
export function usableBySomeone(t) {
  if (t.conditionTree !== undefined) return treeAllows(t.conditionTree);
  return t.conditions.every(ruleAllows); // models built before condition trees were kept
}

const key = (s, r) => `${s}|${r ? 1 : 0}`;
const NEGATIVE = /cancel|declin|reject|withdr|won.?t|duplicate|abandon|obsolete|invalid|refused|denied|fail/i;

// Breadth-first over (status, resolution set). In team-managed projects Jira keeps resolution in step
// with the status category itself, so resolution is not modelled there.
export function explore(model, { skip = null } = {}) {
  const cat = new Map(model.statuses.map((s) => [s.id, s.category]));
  const usable = model.transitions.filter(usableBySomeone);
  const start = { s: model.initial, r: false };
  const seen = new Map([[key(start.s, start.r), { ...start, prev: null, via: null }]]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    for (const t of usable) {
      if (!t.from.includes(cur.s)) continue;
      if (t.type === 'GLOBAL' && t.to === cur.s) continue;
      if (skip && (skip instanceof Set ? skip.has(t.to) : t.to === skip)) continue;
      let r = cur.r;
      if (model.teamManaged) r = cat.get(t.to) === 'DONE';
      else if (t.resolution === 'set') r = true;
      else if (t.resolution === 'clear') r = false;
      const k = key(t.to, r);
      if (seen.has(k)) continue;
      seen.set(k, { s: t.to, r, prev: key(cur.s, cur.r), via: t });
      queue.push({ s: t.to, r });
    }
  }
  return seen;
}

function routeTo(seen, k, model) {
  const name = new Map(model.statuses.map((s) => [s.id, s.name]));
  const hops = [];
  for (let n = seen.get(k); n && n.via; n = seen.get(n.prev)) {
    const p = seen.get(n.prev);
    hops.unshift({ transition: n.via.name, transitionId: n.via.id, global: n.via.type === 'GLOBAL', from: p.s, fromName: name.get(p.s), to: n.s, toName: name.get(n.s), resolution: n.r, effect: n.via.resolution });
  }
  return { start: model.initial, startName: name.get(model.initial), hops };
}

export function check(model, { mustPass = [] } = {}) {
  const findings = [];
  if (!model.initial) return findings;
  const cat = new Map(model.statuses.map((s) => [s.id, s.category]));
  const name = new Map(model.statuses.map((s) => [s.id, s.name]));
  const seen = explore(model);
  const states = [...seen.entries()];
  const hasDone = model.statuses.some((s) => s.category === 'DONE');

  for (const s of model.statuses) {
    if (!states.some(([, n]) => n.s === s.id)) findings.push({ property: 'unreachable', status: s.id, subject: s.name });
  }
  if (hasDone) {
    // which states can still reach a done status? (reverse reachability over the explored graph)
    const canFinish = new Set(states.filter(([, n]) => cat.get(n.s) === 'DONE').map(([k]) => k));
    for (let grew = true; grew;) {
      grew = false;
      for (const [k, n] of states) {
        if (canFinish.has(k)) continue;
        const next = model.transitions.filter(usableBySomeone).filter((t) => t.from.includes(n.s) && !(t.type === 'GLOBAL' && t.to === n.s));
        for (const t of next) {
          let r = n.r;
          if (model.teamManaged) r = cat.get(t.to) === 'DONE'; else if (t.resolution === 'set') r = true; else if (t.resolution === 'clear') r = false;
          if (canFinish.has(key(t.to, r))) { canFinish.add(k); grew = true; break; }
        }
      }
    }
    const stuck = states.filter(([k]) => !canFinish.has(k));
    const byStatus = new Map();
    for (const [k, n] of stuck) if (!byStatus.has(n.s)) byStatus.set(n.s, k);
    for (const [s, k] of byStatus) findings.push({ property: 'stranded', status: s, subject: name.get(s), route: routeTo(seen, k, model) });
  }
  if (!model.teamManaged) {
    const firstDoneUnres = states.find(([, n]) => cat.get(n.s) === 'DONE' && !n.r);
    if (firstDoneUnres) {
      // report every done status it happens in, each with its own shortest route
      const done = new Map();
      for (const [k, n] of states) if (cat.get(n.s) === 'DONE' && !n.r && !done.has(n.s)) done.set(n.s, k);
      for (const [s, k] of done) findings.push({ property: 'doneUnresolved', status: s, subject: name.get(s), route: routeTo(seen, k, model) });
    }
    const open = new Map();
    for (const [k, n] of states) if (cat.get(n.s) !== 'DONE' && n.r && !open.has(n.s)) open.set(n.s, k);
    for (const [s, k] of open) findings.push({ property: 'openResolved', status: s, subject: name.get(s), route: routeTo(seen, k, model) });
  }
  for (const t of model.transitions) if (!usableBySomeone(t)) findings.push({ property: 'nobody', transition: t.id, subject: t.name });
  // Approvals: when a workflow has approval steps, every route to a successful outcome must pass one.
  // Done statuses that name a negative outcome (cancelled, declined, rejected...) may be reached without one.
  const approvals = new Set(model.statuses.filter((s) => s.approval).map((s) => s.id));
  if (approvals.size && !approvals.has(model.initial)) {
    const unapproved = explore(model, { skip: approvals });
    for (const s of model.statuses) {
      if (s.category !== 'DONE' || NEGATIVE.test(s.name)) continue;
      const hit = [...unapproved.entries()].find(([, n]) => n.s === s.id);
      if (hit) findings.push({ property: 'approvalSkipped', status: s.id, subject: s.name, route: routeTo(unapproved, hit[0], model) });
    }
  }
  // user rules: every route from creation to `target` passes through `via`
  for (const rule of mustPass) {
    if (rule.via === model.initial) continue; // every route starts there, so the rule holds
    const skipped = explore(model, { skip: rule.via });
    const hit = [...skipped.entries()].find(([, n]) => n.s === rule.target);
    if (hit) findings.push({ property: 'mustPass', rule, subject: `${name.get(rule.target)} without ${name.get(rule.via)}`, route: routeTo(skipped, hit[0], model) });
  }
  return findings.map((f, i) => ({ id: `f${i + 1}`, ...PROPERTIES[f.property], ...f }));
}

// Summary used by the UI, MCP tools and CLI.
export function verify(workflow, statuses, opts = {}) {
  const model = buildModel(workflow, statuses, opts);
  const states = explore(model).size;
  const findings = check(model, opts);
  const held = Object.keys(PROPERTIES).filter((p) => p !== 'mustPass' && !findings.some((f) => f.property === p));
  return { workflow: { id: model.id, name: model.name }, statuses: model.statuses.length, transitions: model.transitions.length, states, findings, held };
}
