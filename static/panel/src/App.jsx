// Interlock: every workflow on the site checked like a railway interlocking. The lever frame lists the
// workflows, the track diagram shows one of them, and the interlocking table lists what can go wrong,
// each with the exact route, which can be replayed on a real work item to prove it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke, openIssue } from './bridge.js';
import { check, explore, PROPERTIES } from '../../../engine/interlock.mjs';
import { layout, trackPath, globalPath, BLOCK_W, BLOCK_H } from './layout.js';

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

  const run = () => {
    setReport(null); setError(null);
    invoke('checkSite', {}).then((r) => {
      setReport(r);
      const worst = [...r.results].sort((a, b) => b.findings.length - a.findings.length)[0];
      setSelId((id) => id || worst?.workflow.id);
    }).catch((e) => setError(e.message || String(e)));
  };
  useEffect(run, []);

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
  const list = [...results].filter((r) => filter === 'all' || r.findings.length).sort((a, b) => b.findings.length - a.findings.length || a.workflow.name.localeCompare(b.workflow.name));

  return (
    <div className="il-app">
      <header className="il-head">
        <div className="il-brand"><Lamp state="green" /><h1>Interlock</h1></div>
        <p className="il-summary">
          Checked {plural(results.length, 'workflow', 'workflows')} and {totals.transitions.toLocaleString()} transitions, every reachable state, in {report.ms} ms.{' '}
          <b>{plural(totals.withFindings, 'workflow has', 'workflows have')} routes that go wrong.</b>
        </p>
        <button className="il-btn" onClick={run}>Check again</button>
      </header>
      <div className="il-body">
        <nav className="il-levers" aria-label="Workflows">
          <div className="il-filter" role="tablist">
            <button role="tab" aria-selected={filter === 'findings'} className={filter === 'findings' ? 'on' : ''} onClick={() => setFilter('findings')}>With findings <span>{totals.withFindings}</span></button>
            <button role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All <span>{results.length}</span></button>
          </div>
          <ul>
            {list.map((r) => (
              <li key={r.workflow.id}>
                <button className={`il-lever ${r.workflow.id === sel.workflow.id ? 'pulled' : ''}`} onClick={() => { setSelId(r.workflow.id); setFocus(null); }}>
                  <span className="handle" aria-hidden="true" />
                  <span className="name">{r.workflow.name}</span>
                  <span className="count">{r.findings.length ? <><Lamp state="red" />{r.findings.length}</> : <Lamp state="green" />}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <main className="il-main">
          <Diagram key={sel.workflow.id} model={model} result={sel} focus={focus} />
        </main>
        <Table result={sel} model={model} focus={focus} setFocus={setFocus} replays={replays} setReplays={setReplays}
          rules={rules[sel.workflow.id] || []} setRules={(r) => setRules((x) => ({ ...x, [sel.workflow.id]: r }))} />
      </div>
    </div>
  );
}

function summarise(results) {
  return {
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
      <svg className="il-diagram" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={`Track diagram of ${result.workflow.name}`}>
        <line className="il-rail" x1="16" x2={width - 16} y1="34" y2="34" />
        <text className="il-rail-label" x="18" y="24">From any status</text>
        {globals.map((t, k) => {
          const b = pos.get(t.to); if (!b) return null;
          const d = globalPath(b, k), on = routeKey.has(`${t.id}:${route.find((h) => h.transitionId === t.id)?.from}`);
          return <path key={t.id} ref={(el) => { if (el) pathRefs.current[`${t.id}:*`] = el; }} d={d} className={`il-track global ${on ? 'route' : ''}`} />;
        })}
        {model.transitions.filter((t) => t.type !== 'GLOBAL').flatMap((t, k) => t.from.map((f) => {
          const a = pos.get(f), b = pos.get(t.to); if (!a || !b) return null;
          const id = `${t.id}:${f}`;
          return <path key={id} ref={(el) => { if (el) pathRefs.current[id] = el; }} d={trackPath(a, b, k % 4)} className={`il-track ${routeKey.has(id) ? 'route' : ''}`} />;
        }))}
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
function Table({ result, model, focus, setFocus, replays, setReplays, rules, setRules }) {
  const usage = result.usage.find((u) => u.project);
  async function replay(f) {
    const k = `${result.workflow.id}:${f.id}`;
    setReplays((r) => ({ ...r, [k]: { status: 'running' } }));
    try {
      const out = await invoke('replay', { project: usage.project, issueType: usage.issueType, hops: f.route.hops, label: `${f.title}, ${result.workflow.name}`, startName: f.route.startName });
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
                      <button className="il-link" onClick={() => openIssue(rp.key)}>Open {rp.key}</button>
                    </div>
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
