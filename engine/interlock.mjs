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
  mustPass: { title: 'Route skips a required status', why: 'Work can reach the target without passing the status your rule requires (for a done target, also after finished work is reopened and finished again).' },
  ruleStale: { title: 'Rule names a status this workflow no longer has', why: 'The rule was saved for a status that has since been removed from the workflow, so it proves nothing. Remove it or save it again.' },
  approvalSkipped: { title: 'Done without approval', why: 'This workflow asks for an approval, but a route reaches a successful done status without passing any approval step, so work can be completed without anyone approving it.' },
};

const RES_FIELD = 'resolution';

// Turn the REST shape (GET /rest/api/3/workflows/search?expand=values.transitions) into a small model.
// statuses: Map id -> { name, category: 'TODO' | 'IN_PROGRESS' | 'DONE' }
// screenHasResolution: Set of transition screen ids whose tabs include the Resolution field.
export function buildModel(workflow, statuses, { screenHasResolution = new Set(), unreadableScreens = new Set(), teamManaged = false } = {}) {
  const ids = workflow.statuses.map((s) => s.statusReference);
  const props = new Map(workflow.statuses.map((s) => [s.statusReference, s.properties || {}]));
  // Jira Service Management marks an approval step with approval.* properties on the status
  const st = ids.map((id) => ({ id, name: statuses.get(id)?.name || id, category: statuses.get(id)?.category || 'IN_PROGRESS',
    approval: Object.keys(props.get(id) || {}).some((k) => k.startsWith('approval.')),
    approvedVia: props.get(id)?.['approval.transition.approved'] || null }));
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
    // a screen Interlock could not read is assumed to ask for a resolution into a done status (so it never
    // invents a "done but unresolved"), and to leave the resolution alone elsewhere (so it never invents a
    // "reopened but still resolved")
    if (!resolution && screenId && unreadableScreens.has(String(screenId)) && statuses.get(t.toStatusReference)?.category === 'DONE') resolution = 'set';
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
const NEGATIVE = /cancel|declin|reject|withdr|won.?t|duplicate|abandon|obsolete|invalid|refused|denied|fail|disapprov|unapprov|not.?approv/i;

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

// A team rule "work reaches `target` only through `via`", checked on every arrival at the target, not
// only the first: breadth-first over (status, resolution set, passed `via` since work last left the target).
// Reopening work and closing it again without passing `via` breaks the rule.
function exploreRule(model, target, via) {
  const cat = new Map(model.statuses.map((s) => [s.id, s.category]));
  const usable = model.transitions.filter(usableBySomeone);
  const k3 = (s, r, p) => `${s}|${r ? 1 : 0}|${p ? 1 : 0}`;
  const start = { s: model.initial, r: false, p: model.initial === via };
  const seen = new Map([[k3(start.s, start.r, start.p), { ...start, prev: null, via: null }]]);
  const queue = [start];
  // work created straight into the target has not passed the required status
  let hit = start.s === target && !start.p ? k3(start.s, start.r, start.p) : null;
  while (queue.length && !hit) {
    const cur = queue.shift();
    for (const t of usable) {
      if (!t.from.includes(cur.s) || (t.type === 'GLOBAL' && t.to === cur.s)) continue;
      let r = cur.r;
      if (model.teamManaged) r = cat.get(t.to) === 'DONE';
      else if (t.resolution === 'set') r = true;
      else if (t.resolution === 'clear') r = false;
      // passing the required status counts from then on, through loops and moves between done statuses; for a
      // done target, finished work that is reopened (done to open) has to pass it again before it finishes again
      const reopened = cat.get(target) === 'DONE' && cat.get(cur.s) === 'DONE' && cat.get(t.to) !== 'DONE';
      const p = t.to === via ? true : reopened ? false : cur.p;
      const k = k3(t.to, r, p);
      if (seen.has(k)) continue;
      seen.set(k, { s: t.to, r, p, prev: k3(cur.s, cur.r, cur.p), via: t });
      if (t.to === target && !p) { hit = k; break; }
      queue.push({ s: t.to, r, p });
    }
  }
  return { seen, hit };
}

// Breadth-first over (status, resolution set, approved). Work counts as approved only when it leaves an
// approval step for an outcome that is not negative (declining and coming back later is not an approval).
function exploreApproval(model, approvals) {
  const name = new Map(model.statuses.map((s) => [s.id, s.name]));
  const cat = new Map(model.statuses.map((s) => [s.id, s.category]));
  const usable = model.transitions.filter(usableBySomeone);
  const k3 = (s, r, a) => `${s}|${r ? 1 : 0}|${a || 0}`;
  const seen = new Map([[k3(model.initial, false, 0), { s: model.initial, r: false, a: 0, prev: null, via: null }]]);
  const queue = [{ s: model.initial, r: false, a: 0 }];
  // when the workflow does not name the approve transition: one named like an approval, if the step has one;
  // otherwise a move forward (not back to a to-do status, nor to a status the approval step is reached from)
  const approveIds = new Map(), before = new Map();
  for (const s of approvals) {
    const out = usable.filter((t) => t.type !== 'GLOBAL' && t.from.includes(s));
    approveIds.set(s, new Set(out.filter((t) => /approv|authori[sz]|accept/i.test(t.name) && !NEGATIVE.test(t.name)).map((t) => String(t.id))));
    before.set(s, new Set(usable.filter((t) => t.to === s && t.type !== 'GLOBAL').flatMap((t) => t.from)));
  }
  const approves = (from, t) => {
    if (from.approvedVia) return String(t.id) === String(from.approvedVia);
    if (t.type === 'GLOBAL' || NEGATIVE.test(t.name || '') || NEGATIVE.test(name.get(t.to) || '')) return false;
    const named = approveIds.get(from.id);
    if (named?.size) return named.has(String(t.id));
    return cat.get(t.to) !== 'TODO' && !before.get(from.id)?.has(t.to);
  };
  while (queue.length) {
    const cur = queue.shift();
    for (const t of usable) {
      if (!t.from.includes(cur.s) || (t.type === 'GLOBAL' && t.to === cur.s)) continue;
      let r = cur.r;
      if (model.teamManaged) r = cat.get(t.to) === 'DONE';
      else if (t.resolution === 'set') r = true;
      else if (t.resolution === 'clear') r = false;
      const from = approvals.has(cur.s) ? model.statuses.find((x) => x.id === cur.s) : null;
      // approved by leaving the approval step through its approve transition (or, when the workflow does not name
      // one, a directed transition to a positive outcome; a "from any status" transition never approves);
      // work that leaves a done status for an open one needs approving again
      const reopened = cat.get(cur.s) === 'DONE' && cat.get(t.to) !== 'DONE';
      // a: 0 not approved, 1 approved, 2 settled. Work closed as cancelled, declined... needs no approval (settled),
      // and filing it away (Canceled to Closed or Archived) keeps it settled; moving it on to any other done status
      // (Completed, Done) is a success that still needs the approval, and reopening it needs one too
      const negativeDone = cat.get(t.to) === 'DONE' && NEGATIVE.test(name.get(t.to) || '');
      const filed = cat.get(t.to) === 'DONE' && /clos|archiv/i.test(name.get(t.to) || '');
      const a = from && approves(from, t) ? 1
        : cur.a === 1 && !reopened ? 1
        : negativeDone || (cur.a === 2 && filed) ? 2 : 0;
      const k = k3(t.to, r, a);
      if (seen.has(k)) continue;
      seen.set(k, { s: t.to, r, a, prev: k3(cur.s, cur.r, cur.a), via: t });
      queue.push({ s: t.to, r, a });
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
  // (an approval step can be where work starts: leaving it by anything but its approve transition is still a skip)
  if (approvals.size) {
    const unapproved = exploreApproval(model, approvals);
    for (const s of model.statuses) {
      if (s.category !== 'DONE' || NEGATIVE.test(s.name)) continue;
      const hit = [...unapproved.entries()].find(([, n]) => n.s === s.id && !n.a);
      if (hit) findings.push({ property: 'approvalSkipped', status: s.id, subject: s.name, route: routeTo(unapproved, hit[0], model) });
    }
  }
  // user rules: every route from creation to `target` passes through `via`
  for (const rule of mustPass) {
    if (!name.has(rule.target) || !name.has(rule.via)) { findings.push({ property: 'ruleStale', rule, subject: `${name.get(rule.target) || 'a removed status'} only through ${name.get(rule.via) || 'a removed status'}` }); continue; }
    const { seen: ruled, hit } = exploreRule(model, rule.target, rule.via);
    if (hit) findings.push({ property: 'mustPass', rule, subject: `${name.get(rule.target)} without ${name.get(rule.via)}`, route: routeTo(ruled, hit, model) });
  }
  return findings.map((f, i) => ({ id: `f${i + 1}`, ...PROPERTIES[f.property], ...f }));
}

// Summary used by the UI, MCP tools and CLI.
export function verify(workflow, statuses, opts = {}) {
  const model = buildModel(workflow, statuses, opts);
  const states = explore(model).size;
  let findings = check(model, opts);
  // a transition screen Interlock could not read may or may not ask for a resolution. "Done but unresolved" is
  // reported only if it holds even when every such screen asks; "reopened but still resolved" only if it holds
  // when none does. A resolution property that depends on the screen is undecided: neither found nor held.
  const unreadable = opts.unreadableScreens || new Set();
  const undecided = [];
  if (!model.statuses.some((s) => s.category === 'DONE')) undecided.push('stranded');
  if (unreadable.size && workflow.transitions.some((t) => unreadable.has(String(t.transitionScreen?.parameters?.screenId || '')))) {
    const asks = check(buildModel(workflow, statuses, { ...opts, screenHasResolution: new Set([...(opts.screenHasResolution || []), ...unreadable]), unreadableScreens: new Set() }), opts);
    const never = check(buildModel(workflow, statuses, { ...opts, unreadableScreens: new Set() }), opts);
    const kept = [...asks.filter((f) => f.property === 'doneUnresolved'), ...never.filter((f) => f.property === 'openResolved')];
    for (const p of ['doneUnresolved', 'openResolved']) {
      if (!kept.some((f) => f.property === p) && [...findings, ...asks, ...never].some((f) => f.property === p)) undecided.push(p);
    }
    findings = [...findings.filter((f) => f.property !== 'doneUnresolved' && f.property !== 'openResolved'), ...kept].map((f, i) => ({ ...f, id: `f${i + 1}` }));
  }
  // a property only "holds" where it applies: approval coverage needs an approval step to cover
  const hasApproval = model.statuses.some((s) => s.approval);
  const held = !model.initial ? [] : Object.keys(PROPERTIES).filter((p) => p !== 'mustPass' && (p !== 'ruleStale' || (opts.mustPass || []).length) && (p !== 'approvalSkipped' || hasApproval) && !findings.some((f) => f.property === p) && !undecided.includes(p));
  return { workflow: { id: model.id, name: model.name }, statuses: model.statuses.length, transitions: model.transitions.length, states, findings, held, undecided, ...(model.initial ? {} : { noInitial: true }) };
}

// The transitions to fix for a "reopened but still resolved" finding on status `target`: on every route that
// brings finished work to it with the resolution kept, the step where the work first leaves a done status.
// transitions: Jira's workflow transitions; cat: status id -> category; all: every status id in the workflow.
export function reopenSteps(transitions, cat, target, all) {
  const clears = (t) => (t.actions || []).some((a) => a.ruleKey === 'system:update-field' && a.parameters?.field === 'resolution' && !a.parameters.value);
  const fromOf = (t) => (t.type === 'GLOBAL' ? all : (t.links || []).map((l) => l.fromStatusReference));
  // the open statuses from which work still resolved walks on to the target without the resolution being cleared
  const feeds = new Set([target]);
  for (let grew = true; grew;) {
    grew = false;
    for (const t of transitions) {
      if (t.type === 'INITIAL' || !feeds.has(t.toStatusReference) || clears(t)) continue;
      for (const f of fromOf(t)) if (cat[f] !== 'DONE' && !feeds.has(f)) { feeds.add(f); grew = true; }
    }
  }
  return transitions.filter((t) => t.type !== 'INITIAL' && feeds.has(t.toStatusReference) && cat[t.toStatusReference] !== 'DONE'
    && fromOf(t).some((f) => cat[f] === 'DONE') && !clears(t)
    && !(t.actions || []).some((a) => a.ruleKey === 'system:update-field' && a.parameters?.field === 'resolution' && a.parameters.value));
}

// The verdict on one rule, "work reaches target only through via": holds, broken (with the route), or undecided (with
// the reason: no create transition, a status the rule names is gone, or nothing reaches the target at all).
export function ruleVerdict(model, { target, via }) {
  const name = new Map(model.statuses.map((s) => [s.id, s.name]));
  if (!model.initial) return { verdict: 'undecided', reason: 'the workflow has no create transition, so there is no route to search' };
  if (!name.has(target) || !name.has(via)) return { verdict: 'undecided', reason: 'a status this rule names is no longer in the workflow' };
  if (String(target) === String(via)) return { verdict: 'undecided', reason: 'the rule names the same status twice' };
  if (![...explore(model).values()].some((n) => n.s === target)) return { verdict: 'undecided', reason: `no route reaches ${name.get(target)} at all` };
  const { seen, hit } = exploreRule(model, target, via);
  return hit ? { verdict: 'broken', route: routeTo(seen, hit, model) } : { verdict: 'holds' };
}

// The smallest change that makes a broken rule hold, proved: each single transition link is taken away in turn (a
// "from any status" transition is also tried as one from the required status only), and the rule is checked again
// over every route. A repair that leaves a status unreachable is listed after those that keep every status reachable.
// Interlock suggests, it does not apply: restricting who can move work is the team's call.
export function ruleRepairs(model, rule, max = 3) {
  if (ruleVerdict(model, rule).verdict !== 'broken') return [];
  const name = new Map(model.statuses.map((s) => [s.id, s.name]));
  const reached = (m) => new Set([...explore(m).values()].map((n) => n.s));
  const before = reached(model);
  const tries = [];
  for (const t of model.transitions.filter(usableBySomeone)) {
    if (t.type === 'GLOBAL') {
      tries.push({ text: `remove "${t.name}" (from any status)`, change: (x) => x.id !== t.id ? x : null });
      tries.push({ text: `let "${t.name}" run only from ${name.get(rule.via)}, not from any status`, change: (x) => x.id !== t.id ? x : { ...x, type: 'DIRECTED', from: [rule.via] } });
    } else for (const f of t.from) {
      tries.push({ text: `remove "${t.name}" from ${name.get(f)} to ${name.get(t.to)}`, change: (x) => x.id !== t.id ? x : (x.from.length > 1 ? { ...x, from: x.from.filter((y) => y !== f) } : null) });
    }
  }
  const out = [];
  for (const c of tries) {
    const m = { ...model, transitions: model.transitions.map(c.change).filter(Boolean) };
    if (ruleVerdict(m, rule).verdict !== 'holds') continue;
    const lost = [...before].filter((s) => !reached(m).has(s)).map((s) => name.get(s));
    out.push({ change: c.text, lost });
  }
  return out.sort((a, b) => a.lost.length - b.lost.length).slice(0, max);
}
