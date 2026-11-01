// Interlock: every workflow on the site checked like a railway interlocking. The lever frame lists the
// workflows, the track diagram shows one of them, and the interlocking table lists what can go wrong,
// each with the exact route, which can be replayed on a real work item to prove it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke, openIssue, openPath } from './bridge.js';
import { check, explore, PROPERTIES } from '../../../engine/interlock.mjs';
import { layout, tracks, trackPath, globalPath, BLOCK_W, BLOCK_H } from './layout.js';

const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default function App() {
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [selId, setSelId] = useState(null);
  const [filter, setFilter] = useState('findings');
  const [focus, setFocus] = useState(null);
  const [rules, setRules] = useState({});
  const [replays, setReplays] = useState({});
  const [measuring, setMeasuring] = useState(false);

  const run = () => {
    setReport(null); setError(null);
    invoke('checkSite', {}).then((r) => {
      setReport(r);
      setMeasuring(true);
      invoke('measureSite', {}).then((m) => setReport((cur) => cur && withCounts(cur, m))).catch(() => {}).finally(() => setMeasuring(false));
      const live = (x) => Object.values(x.observed || {}).reduce((b, o) => b + o.bad, 0);
      const worst = [...r.results].sort((a, b) => live(b) - live(a) || b.findings.length - a.findings.length)[0];
      setSelId((id) => id || worst?.workflow.id);
    }).catch((e) => setError(e.message || String(e)));
  };
  useEffect(run, []);

  // after a fix: prove the whole site again, stay on the same workflow, and say what changed
  const [notice, setNotice] = useState(null);
  const [pendingSelect, setPendingSelect] = useState(null);
  useEffect(() => {
    if (!pendingSelect || !report) return;
    const w = report.results.find((r) => r.workflow.name === pendingSelect);
    if (w) { setSelId(w.workflow.id); setPendingSelect(null); }
  }, [pendingSelect, report]);
  const recheck = async (msg, undo = null) => {
    const r = await invoke('checkSite', {});
    setReport(r); setFocus(null); setNotice(msg ? { msg, undo } : null);
    setMeasuring(true);
    invoke('measureSite', {}).then((m) => setReport((cur) => cur && withCounts(cur, m))).catch(() => {}).finally(() => setMeasuring(false));
  };

  // re-check the selected workflow in the browser whenever its rules change
  const results = useMemo(() => {
    if (!report) return [];
    return report.results.map((r) => {
      const wfRules = rules[r.workflow.id];
      if (!wfRules?.length) return r;
      const model = { ...report.models[r.workflow.id], teamManaged: r.teamManaged };
      return { ...r, findings: check(model, { mustPass: wfRules }) };
    });
  }, [report, rules]);

  if (error) return <div className="il-empty"><h1>Interlock could not read this site's workflows</h1><p>{error}</p><p>Interlock needs a Jira administrator to open it, because workflows are site configuration.</p><button className="il-btn" onClick={run}>Check again</button></div>;
  if (!report) return <Boot />;

  const sel = results.find((r) => r.workflow.id === selId) || results[0];
  const model = { ...report.models[sel.workflow.id], teamManaged: sel.teamManaged };
  const totals = summarise(results);
  const liveOf = (r) => Object.values(r.observed || {}).reduce((b, o) => b + o.bad, 0);
  const list = [...results].filter((r) => filter === 'all' || r.findings.length).sort((a, b) => liveOf(b) - liveOf(a) || b.findings.length - a.findings.length || a.workflow.name.localeCompare(b.workflow.name));

  return (
    <div className="il-app">
      <header className="il-head">
        <div className="il-brand"><Lamp state="green" /><h1>Interlock</h1></div>
        <p className="il-summary">
          Checked {plural(results.length, 'workflow', 'workflows')} and {totals.transitions.toLocaleString()} transitions, every reachable state, in {report.ms} ms.{' '}
          <b>{plural(totals.withFindings, 'workflow has', 'workflows have')} routes that go wrong</b>{totals.live ? <>, and <b className="il-live">{totals.live.toLocaleString()} work items are already in a wrong state</b>.</> : measuring ? '. Counting the work items already affected…' : '.'}
        </p>
        <button className="il-btn" onClick={run}>Check again</button>
      </header>
      {notice && (
        <div className="il-notice" role="status"><Lamp state="green" />{notice.msg}
          {notice.undo && <button className="il-link" onClick={async () => {
            const u = notice.undo; setNotice({ msg: 'Taking the fix back and proving the site again…' });
            try { await invoke('fix', { ...u, mode: 'undo' }); await recheck(`Undone: ${u.transitions.join(', ')} in ${u.name} no longer change the resolution.`); }
            catch (e) { setNotice({ msg: 'Could not undo the fix: ' + (e.message || e) }); }
          }}>Undo</button>}
          <button className="il-link" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      <div className="il-body">
        <nav className="il-levers" aria-label="Workflows">
          <div className="il-filter" role="tablist">
            <button role="tab" aria-selected={filter === 'findings'} className={filter === 'findings' ? 'on' : ''} onClick={() => setFilter('findings')}>With findings <span>{totals.withFindings}</span></button>
            <button role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All <span>{results.length}</span></button>
          </div>
          {!results.some((r) => r.workflow.name === 'Ship: Software delivery workflow') && <Demo onDone={async (msg) => { await recheck(msg); setSelId((id) => id); setPendingSelect('Ship: Software delivery workflow'); }} />}
          <ul>
            {list.map((r) => (
              <li key={r.workflow.id}>
                <button className={`il-lever ${r.workflow.id === sel.workflow.id ? 'pulled' : ''}`} onClick={() => { setSelId(r.workflow.id); setFocus(null); }}>
                  <span className="handle" aria-hidden="true" />
                  <span className="name">{r.workflow.name}</span>
                  <span className="count">{liveOf(r) ? <span className="live" title="Work items already in a wrong state">{liveOf(r)}</span> : null}{r.findings.length ? <><Lamp state="red" />{r.findings.length}</> : <Lamp state="green" />}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <main className="il-main">
          <Diagram key={sel.workflow.id} model={model} result={sel} focus={focus} />
        </main>
        <Table result={sel} model={model} focus={focus} setFocus={setFocus} replays={replays} setReplays={setReplays} onFixed={recheck}
          rules={rules[sel.workflow.id] || []} setRules={(r) => setRules((x) => ({ ...x, [sel.workflow.id]: r }))} />
      </div>
    </div>
  );
}

function withCounts(report, counts) {
  return { ...report, results: report.results.map((r) => (counts[r.workflow.id] ? { ...r, ...counts[r.workflow.id] } : r)) };
}

function summarise(results) {
  const live = results.reduce((a, r) => a + Object.values(r.observed || {}).reduce((b, o) => b + o.bad, 0), 0);
  return {
    live,
    transitions: results.reduce((a, r) => a + r.transitions, 0),
    withFindings: results.filter((r) => r.findings.length).length,
  };
}

function Boot() {
  return (
    <div className="il-boot" role="status">
      <div className="il-boot-track">{[0, 1, 2, 3, 4].map((i) => <Lamp key={i} state="amber" style={{ animationDelay: `${i * 0.18}s` }} />)}</div>
      <p>Reading every workflow, status and transition screen on this site…</p>
    </div>
  );
}

export function Lamp({ state, style }) { return <span className={`il-lamp ${state}`} style={style} aria-hidden="true" />; }

// ---------- the track diagram ----------
function Diagram({ model, result, focus }) {
  const { pos, width, height } = useMemo(() => layout(model), [model]);
  const order = useMemo(() => { // the order in which the explorer first reaches each status
    const seen = explore(model), first = new Map(); let i = 0;
    for (const n of seen.values()) if (!first.has(n.s)) first.set(n.s, i++);
    return first;
  }, [model]);
  const bad = new Set(result.findings.filter((f) => f.status).map((f) => f.status));
  const unreachable = new Set(result.findings.filter((f) => f.property === 'unreachable').map((f) => f.status));
  const route = focus?.route?.hops || [];
  const routeKey = new Set(route.map((h) => `${h.transitionId}:${h.from}`));
  const trainRef = useRef(null), pathRefs = useRef({});

  // run a lit train along the focused route, hop by hop
  useEffect(() => {
    if (!route.length || !trainRef.current) return;
    if (reduceMotion) return;
    let cancel = false;
    (async () => {
      for (let loop = 0; loop < 3 && !cancel; loop++) {
        for (const h of route) {
          const el = pathRefs.current[`${h.transitionId}:${h.from}`] || pathRefs.current[`${h.transitionId}:*`];
          if (!el || cancel) break;
          const len = el.getTotalLength(), t0 = performance.now(), dur = Math.max(500, len * 2.2);
          await new Promise((ok) => {
            const step = (now) => {
              if (cancel) return ok();
              const t = Math.min(1, (now - t0) / dur), p = el.getPointAtLength(len * t);
              trainRef.current?.setAttribute('transform', `translate(${p.x},${p.y})`);
              if (t < 1) requestAnimationFrame(step); else ok();
            };
            requestAnimationFrame(step);
          });
          await new Promise((ok) => setTimeout(ok, 160));
        }
        await new Promise((ok) => setTimeout(ok, 700));
      }
    })();
    return () => { cancel = true; };
  }, [focus]);

  const globals = model.transitions.filter((t) => t.type === 'GLOBAL');
  return (
    <div className="il-diagram-wrap">
      <svg className="il-diagram" viewBox={`0 0 ${width} ${height}`} style={{ maxWidth: width * (width < 900 ? 1.7 : 1), minWidth: Math.min(width, 380) }} role="img" aria-label={`Track diagram of ${result.workflow.name}`}>
        <defs>
          <filter id="il-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        <line className="il-rail" x1="16" x2={width - 16} y1="34" y2="34" />
        <text className="il-rail-label" x="18" y="24">From any status</text>
        {globals.map((t, k) => {
          const b = pos.get(t.to); if (!b) return null;
          const d = globalPath(b, k), on = routeKey.has(`${t.id}:${route.find((h) => h.transitionId === t.id)?.from}`);
          return <path key={t.id} ref={(el) => { if (el) pathRefs.current[`${t.id}:*`] = el; }} d={d} className={`il-track global ${on ? 'route' : ''}`} />;
        })}
        {tracks(model).map((tr, k) => {
          const a = pos.get(tr.from), b = pos.get(tr.to); if (!a || !b) return null;
          const ids = tr.transitions.map((t) => `${t.id}:${tr.from}`);
          const on = ids.some((id) => routeKey.has(id));
          return (
            <path key={`${tr.from}>${tr.to}`} d={trackPath(a, b, k % 4)} className={`il-track ${b.x <= a.x ? 'back' : ''} ${on ? 'route' : ''}`}
              ref={(el) => { if (el) for (const id of ids) pathRefs.current[id] = el; }}>
              <title>{tr.transitions.map((t) => t.name).join(', ')}</title>
            </path>
          );
        })}
        {model.statuses.map((s) => {
          const p = pos.get(s.id), state = bad.has(s.id) ? 'red' : unreachable.has(s.id) ? 'amber' : 'green';
          const i = order.get(s.id) ?? 30;
          return (
            <g key={s.id} className={`il-block ${s.category.toLowerCase()} ${state}`} transform={`translate(${p.x},${p.y})`} style={{ '--t': `${i * 90}ms` }}>
              <rect width={BLOCK_W} height={BLOCK_H} rx="5" />
              <circle className="lamp" cx="16" cy={BLOCK_H / 2} r="6" />
              <text x="30" y={BLOCK_H / 2 + 5}>{s.name.length > 19 ? s.name.slice(0, 18) + '…' : s.name}</text>
              {s.id === model.initial && <text className="start" x="0" y="-8">Created here</text>}
            </g>
          );
        })}
        {route.length > 0 && <g ref={trainRef} className="il-train"><circle r="9" /><circle r="4" className="core" /></g>}
      </svg>
      <Legend teamManaged={result.teamManaged} />
    </div>
  );
}

function Legend({ teamManaged }) {
  return (
    <p className="il-legend">
      <span><Lamp state="green" />Every route from here is sound</span>
      <span><Lamp state="red" />A route reaches this status in a bad state</span>
      <span><Lamp state="amber" />No route reaches this status</span>
      {teamManaged && <span className="tm">Team-managed: Jira keeps the resolution in step with done statuses itself.</span>}
    </p>
  );
}

// ---------- the interlocking table ----------
function Table({ result, model, focus, setFocus, replays, setReplays, rules, setRules, onFixed }) {
  const usage = result.usage.find((u) => u.project);
  async function replay(f) {
    const k = `${result.workflow.id}:${f.id}`;
    setReplays((r) => ({ ...r, [k]: { status: 'running' } }));
    try {
      const out = await invoke('replay', { project: usage.project, projectId: usage.projectId, issueType: usage.issueType, workflow: result.workflow.name, hops: f.route.hops, label: `${f.title}, ${result.workflow.name}`, startName: f.route.startName });
      setReplays((r) => ({ ...r, [k]: { status: 'done', ...out } }));
    } catch (e) { setReplays((r) => ({ ...r, [k]: { status: 'error', error: e.message } })); }
  }
  return (
    <aside className="il-table" aria-label="Interlocking table">
      <h2>{result.workflow.name}</h2>
      <p className="il-meta">{plural(result.statuses, 'status', 'statuses')}, {plural(result.transitions, 'transition', 'transitions')}, {plural(result.states, 'reachable state', 'reachable states')}{usage ? `, used in ${[...new Set(result.usage.map((u) => u.project))].join(', ')}` : ''}.</p>
      {!result.findings.length && <p className="il-held"><Lamp state="green" />Every property holds for every reachable state.</p>}
      <ol className="il-findings">
        {groupFindings(result.findings).map(({ property, list }) => {
          const active = list.find((f) => f.id === focus?.id);
          const f = active || list[0];
          const k = `${result.workflow.id}:${f.id}`, rp = replays[k];
          const verdict = rp?.status === 'done' ? verdictOf(f, rp) : null;
          return (
            <li key={property} className={`il-finding ${active ? 'on' : ''} ${verdict?.confirmed ? 'confirmed' : ''}`}>
              <button className="il-finding-main" onClick={() => setFocus(active ? null : list[0])}>
                <Lamp state={property === 'unreachable' ? 'amber' : 'red'} />
                <span><b>{f.title}</b>{list.length === 1 ? f.subject : `${list.length} statuses`}</span>
              </button>
              <Tiers f={f} obs={result.observed?.[property]} verdict={verdict} />
              <Evidence obs={result.observed?.[property]} property={property} />
              {list.length > 1 && (
                <div className="il-chips" role="group" aria-label={f.title}>
                  {list.map((x) => <button key={x.id} className={focus?.id === x.id ? 'on' : ''} onClick={() => setFocus(focus?.id === x.id ? null : x)}>{x.subject}</button>)}
                </div>
              )}
              {active && (
                <div className="il-finding-body">
                  <p>{f.why}</p>
                  {f.route && (
                    <ol className="il-route">
                      <li><span className="st">{f.route.startName}</span><em>created</em></li>
                      {f.route.hops.map((h, i) => (
                        <li key={i}><span className="via">{h.transition}{h.global ? ' (from any status)' : ''}</span><span className="st">{h.toName}</span><em>resolution {h.resolution ? 'set' : 'empty'}</em></li>
                      ))}
                    </ol>
                  )}
                  {f.route && usage && (!rp || rp.status === 'error') && (
                    <button className="il-btn primary" onClick={() => replay(f)}>Replay on a new work item in {usage.project}</button>
                  )}
                  {f.route && !usage && <p className="il-note">No company-managed project uses this workflow, so there is nowhere to replay it.</p>}
                  {rp?.status === 'running' && <p className="il-note">Replaying through Jira…</p>}
                  {rp?.status === 'error' && <p className="il-err">{rp.error}</p>}
                  {rp?.status === 'done' && (
                    <div className={`il-replay ${verdict.confirmed ? 'confirmed' : 'cleared'}`}>
                      <p><b>{verdict.confirmed ? 'Confirmed on a real work item' : 'Not reproduced'}</b>{verdict.text}</p>
                      <ol>{rp.steps.map((s, i) => <li key={i}><span>{s.step}</span><span>{s.error || `${s.status}, resolution ${s.resolution || 'empty'}`}</span></li>)}</ol>
                      <p className="il-replay-act">
                        <button className="il-link" onClick={() => openIssue(rp.key)}>Open {rp.key}</button>
                        <button className="il-link" onClick={async () => {
                          try { await invoke('deleteReplay', { key: rp.key }); setReplays((r) => ({ ...r, [k]: undefined })); }
                          catch (e) { setReplays((r) => ({ ...r, [k]: { ...rp, deleteError: e.message } })); }
                        }}>Delete {rp.key}</button>
                      </p>
                      {rp.deleteError && <p className="il-err">{rp.deleteError}</p>}
                    </div>
                  )}
                  {(f.property === 'doneUnresolved' || f.property === 'openResolved') && (
                    <Fix key={f.id} f={f} result={result} onFixed={onFixed} />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <Rules model={model} rules={rules} setRules={setRules} />
    </aside>
  );
}

// How far a finding has been taken, like a signal with three aspects: the proof says the route exists,
// Jira's data says work items are already there, and a replay walked a real work item down the route.
function Tiers({ f, obs, verdict }) {
  const counted = f.property === 'doneUnresolved' || f.property === 'openResolved';
  const tiers = [
    { label: 'Proved', on: true, why: 'The model checker found this route among every reachable state.' },
    { label: 'In your data', on: obs?.bad > 0, na: !counted, why: counted ? 'Work items in the projects using this workflow are already in this state.' : 'Jira data cannot show this kind of finding; replay the route instead.' },
    { label: 'Replayed', on: !!verdict?.confirmed, na: !f.route, why: 'A new work item followed the route through Jira itself.' },
  ];
  return (
    <ol className="il-tiers" aria-label="Evidence">
      {tiers.map((t) => (
        <li key={t.label} className={t.on ? 'on' : t.na ? 'na' : ''} title={t.why}>
          <span className={`il-lamp ${t.on ? 'white' : ''}`} aria-hidden="true" />
          {t.label}<span className="sr">{t.on ? ': yes' : t.na ? ': not applicable' : ': not yet'}</span>
        </li>
      ))}
    </ol>
  );
}

// What Jira's own data says: how many work items in the projects using this workflow are already in
// the state the proof says is reachable.
function Evidence({ obs, property }) {
  if (!obs) return null;
  const noun = property === 'doneUnresolved' ? ['done work item is unresolved', 'done work items are unresolved'] : ['open work item still has a resolution', 'open work items still have a resolution'];
  const link = `/issues/?jql=${encodeURIComponent(obs.jql)}`;
  if (obs.bad > 0) {
    return <p className="il-evidence now">Happening now: {obs.bad.toLocaleString()} of {obs.of.toLocaleString()} {obs.bad === 1 ? noun[0] : noun[1]}. <button className="il-link" onClick={() => openPath(link)}>Show them</button></p>;
  }
  return <p className="il-evidence latent">None yet: 0 of {obs.of.toLocaleString()} {property === 'doneUnresolved' ? 'done' : 'open'} work items. Something else may be setting the resolution; replay the route to be sure.</p>;
}

// One click builds a realistic software project on an empty site, so the proof has real tickets to count.
function Demo({ onDone }) {
  const [state, setState] = useState(null);
  const go = async () => {
    try {
      setState('Creating the Ship workflow, scheme and project…');
      const { project, moves } = await invoke('demoSetup', {});
      for (let i = 0; i < moves.length; i += 4) {
        setState(`Moving tickets along real routes: ${Math.min(i + 4, moves.length)} of ${moves.length}…`);
        await invoke('demoMove', { moves: moves.slice(i, i + 4) });
      }
      setState(null);
      await onDone(`Added the ${project} demo project: ${moves.length} tickets moved along real routes of the Ship workflow.`);
    } catch (e) { setState('Could not build the demo: ' + (e.message || e)); }
  };
  return (
    <div className="il-demo">
      {state ? <p>{state}</p> : <><p>New site, nothing to prove yet?</p><button className="il-btn" onClick={go}>Add the Ship demo project</button></>}
    </div>
  );
}

// Repair at the cause: Interlock shows the exact change, has Jira validate it, and applies it only when
// an admin clicks Apply. Then the whole site is proved again.
function Fix({ f, result, onFixed }) {
  const [state, setState] = useState({ step: 'idle' });
  const fixText = f.property === 'doneUnresolved' ? 'set the resolution' : 'clear the resolution';
  const ask = async (mode) => {
    setState((s) => ({ ...s, step: mode === 'apply' ? 'applying' : 'checking' }));
    try {
      const r = await invoke('fix', { workflowId: result.workflow.id, property: f.property, status: f.status, mode });
      if (mode === 'apply' && r.applied) {
        await onFixed(`Fixed and proved again: ${result.workflow.name} now ${f.property === 'doneUnresolved' ? `sets a resolution on every route into ${f.subject}` : `clears the resolution on every route back to ${f.subject}`}.`,
          { workflowId: result.workflow.id, property: f.property, status: f.status, transitions: r.changed, name: result.workflow.name });
        return;
      }
      setState({ step: 'checked', ...r });
    } catch (e) { setState({ step: 'error', error: e.message }); }
  };
  const obs = result.observed?.[f.property];
  return (
    <div className="il-fix">
      <h4>Fix at the cause</h4>
      {state.step === 'idle' && <><p>Make every transition into {f.subject} {fixText}, except ones whose screen already asks the person for a resolution. Jira checks the change before anything is saved, and you can undo it.</p><button className="il-btn" onClick={() => ask('validate')}>Check the fix with Jira</button></>}
      {state.step === 'checking' && <p className="il-note">Asking Jira to validate the change…</p>}
      {state.step === 'checked' && (state.valid ? (
        <>
          <p>Interlock will add <b>{f.property === 'doneUnresolved' ? `Set resolution to ${state.resolutionName}` : 'Clear resolution'}</b> to {state.changed.length === 1 ? 'the transition' : 'the transitions'} <b>{state.changed.join(', ')}</b> in {result.workflow.name}. Jira validated it: no errors.</p>
          <button className="il-btn primary" onClick={() => ask('apply')}>Apply the fix to the workflow</button>
        </>
      ) : state.note ? <p className="il-note">{state.note}</p> : <p className="il-err">Jira rejected the change: {(state.errors || []).join('; ')}</p>)}
      {state.step === 'applying' && <p className="il-note">Saving the workflow and proving the site again…</p>}
      {state.step === 'error' && <p className="il-err">{state.error}</p>}
      {obs?.bad > 0 && <p className="il-note">The fix stops new cases. The {obs.bad} work items already affected need a bulk change: <button className="il-link" onClick={() => openPath(`/issues/?jql=${encodeURIComponent(obs.jql)}`)}>open them</button>.</p>}
    </div>
  );
}

// One row per property, worst first; each affected status becomes a chip with its own route.
const SEVERITY = ['stranded', 'mustPass', 'doneUnresolved', 'openResolved', 'nobody', 'unreachable'];
function groupFindings(findings) {
  const by = new Map();
  for (const f of findings) { if (!by.has(f.property)) by.set(f.property, []); by.get(f.property).push(f); }
  return [...by.entries()].sort((a, b) => SEVERITY.indexOf(a[0]) - SEVERITY.indexOf(b[0])).map(([property, list]) => ({ property, list }));
}

function verdictOf(f, rp) {
  const last = rp.steps[rp.steps.length - 1];
  if (last.error) return { confirmed: false, text: ` Jira refused "${last.step}": ${last.error}` };
  if (f.property === 'doneUnresolved') {
    const ok = last.category === 'done' && !last.resolution;
    return { confirmed: ok, text: ok ? ` ${rp.key} is in ${last.status} with no resolution.` : ` Jira set the resolution on the way (a board column or automation does it), so this route is safe.` };
  }
  if (f.property === 'openResolved') {
    const ok = last.category !== 'done' && !!last.resolution;
    return { confirmed: ok, text: ok ? ` ${rp.key} is open in ${last.status} but still resolved as ${last.resolution}.` : ' Jira cleared the resolution, so this route is safe.' };
  }
  return { confirmed: true, text: ` ${rp.key} followed the route to ${last.status}.` };
}

// ---------- rules you can prove ----------
function Rules({ model, rules, setRules }) {
  const [target, setTarget] = useState(''), [via, setVia] = useState('');
  const done = model.statuses.filter((s) => s.category === 'DONE');
  return (
    <section className="il-rules">
      <h3>Rules for this workflow</h3>
      <p className="il-note">Interlock checks a rule against every route, not a sample of them.</p>
      {!rules.length && (() => {
        const open = model.statuses.filter((x) => x.category !== 'DONE' && x.id !== model.initial);
        const review = open.find((x) => /code review/i.test(x.name)) || open.find((x) => /review/i.test(x.name)) || open.find((x) => /qa|test/i.test(x.name));
        const done = model.statuses.find((x) => x.category === 'DONE');
        return review && done && (
          <p className="il-suggest">Try a rule teams rely on: <button className="il-link" onClick={() => setRules([{ target: done.id, via: review.id }])}>work reaches {done.name} only through {review.name}</button></p>
        );
      })()}
      {rules.map((r, i) => (
        <p key={i} className="il-rule">Work reaches <b>{name(model, r.target)}</b> only through <b>{name(model, r.via)}</b> <button className="il-link" onClick={() => setRules(rules.filter((_, j) => j !== i))}>Remove</button></p>
      ))}
      <div className="il-rule-form">
        <span>Work reaches</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Target status">
          <option value="">a status…</option>
          {[...done, ...model.statuses.filter((s) => s.category !== 'DONE')].map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <span>only through</span>
        <select value={via} onChange={(e) => setVia(e.target.value)} aria-label="Required status">
          <option value="">a status…</option>
          {model.statuses.filter((s) => s.id !== target && s.id !== model.initial).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button className="il-btn" disabled={!target || !via} onClick={() => { setRules([...rules, { target, via }]); setTarget(''); setVia(''); }}>Prove it</button>
      </div>
    </section>
  );
}
const name = (m, id) => m.statuses.find((s) => s.id === id)?.name || id;
