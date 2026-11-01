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
  // once someone picks a workflow the list stops reordering, so counts arriving never move a lever away
  // from under the pointer; a new check unfreezes it
  const [frozen, setFrozen] = useState(null);

  const run = (fresh = false) => {
    setReport(null); setError(null); setFrozen(null); setTouched(false); setRankedWithCounts(false);
    invoke('checkSite', { fresh }).then((r) => {
      setReport(r);
      setMeasuring(true);
      invoke('measureSite', {}).then((m) => setReport((cur) => cur && withCounts(cur, m))).catch(() => {}).finally(() => setMeasuring(false));
      const live = (x) => Object.values(x.observed || {}).reduce((b, o) => b + o.bad, 0);
      const worst = [...r.results].sort((a, b) => live(b) - live(a) || b.findings.length - a.findings.length)[0];
      setSelId((id) => id || worst?.workflow.id);
    }).catch((e) => setError(e.message || String(e)));
  };
  useEffect(() => run(), []);

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
  const [intended, setIntended] = useState({});
  useEffect(() => { if (report?.intended) setIntended(report.intended); }, [report]);
  // rules come from app storage with the proof, and every change is saved back
  useEffect(() => { if (report?.rules) setRules(report.rules); }, [report]);
  const results = useMemo(() => {
    if (!report) return [];
    return report.results.map((r) => {
      const wfRules = rules[r.workflow.id];
      const model = { ...report.models[r.workflow.id], teamManaged: r.teamManaged };
      const all = wfRules?.length || report.rules?.[r.workflow.id]?.length ? check(model, { mustPass: wfRules || [] }) : r.findings;
      const isIntended = (f) => intended[`${r.workflow.id}|${f.property}|${f.subject || ''}`];
      return { ...r, findings: all.filter((f) => !isIntended(f)), intended: all.filter(isIntended).map((f) => ({ ...f, record: isIntended(f) })) };
    });
  }, [report, rules, intended]);
  const markIntended = async (r, f, reason, undo = false) => {
    const out = await invoke('markIntended', { workflowId: r.workflow.id, property: f.property, subject: f.subject, reason, undo });
    setIntended(out.intended || {});
  };

  // the lever order is set once, when the proof arrives (most findings first); counts that arrive later
  // add their badges without moving anything under the pointer
  // until someone picks a workflow, the order follows the evidence: once the live counts arrive, the
  // workflows with work items already wrong move to the top (once); after a pick it holds still
  const [touched, setTouched] = useState(false);
  const counted = results.some((r) => r.observed);
  const [rankedWithCounts, setRankedWithCounts] = useState(false);
  useEffect(() => {
    const live = (r) => Object.values(r.observed || {}).reduce((b, o) => b + o.bad, 0);
    const order = () => [...results].sort((a, b) => live(b) - live(a) || b.findings.length - a.findings.length || a.workflow.name.localeCompare(b.workflow.name)).map((x) => x.workflow.id);
    if (results.length && !frozen) setFrozen(order());
    else if (counted && !rankedWithCounts && !touched) { setFrozen(order()); setRankedWithCounts(true); }
  }, [results, frozen, counted, touched, rankedWithCounts]);

  if (error) return <div className="il-empty"><h1>Interlock could not read this site's workflows</h1><p>{error}</p><p>Interlock needs a Jira administrator to open it, because workflows are site configuration.</p><button className="il-btn" onClick={() => run(true)}>Check again</button></div>;
  if (!report) return <Boot />;

  const sel = results.find((r) => r.workflow.id === selId) || results[0];
  const model = { ...report.models[sel.workflow.id], teamManaged: sel.teamManaged };
  const totals = summarise(results);
  const liveOf = (r) => Object.values(r.observed || {}).reduce((b, o) => b + o.bad, 0);
  const ranked = [...results].sort((a, b) => liveOf(b) - liveOf(a) || b.findings.length - a.findings.length || a.workflow.name.localeCompare(b.workflow.name));
  const list = (frozen ? [...results].sort((a, b) => (frozen.indexOf(a.workflow.id) + 1 || 1e9) - (frozen.indexOf(b.workflow.id) + 1 || 1e9)) : ranked)
    .filter((r) => filter === 'all' || r.findings.length);

  return (
    <div className="il-app">
      <header className="il-head">
        <div className="il-brand"><Lamp state="green" /><h1 className="sr">Interlock</h1></div>
        <p className="il-summary">
          Checked {plural(results.length, 'workflow', 'workflows')} and {totals.transitions.toLocaleString()} transitions, every reachable state, in {report.ms} ms.{' '}
          <b>{plural(totals.withFindings, 'workflow has', 'workflows have')} routes that go wrong</b>{totals.live ? <>, and <b className="il-live">{totals.live.toLocaleString()} work items are already in a wrong state</b>.</> : measuring ? '. Counting the work items already affected…' : '.'}
        </p>
        <button className="il-btn" onClick={() => run(true)}>Check again</button>
      </header>
      {notice && (
        <div className="il-notice" role="status"><Lamp state="green" />{notice.msg}
          {notice.undo && <button className="il-link" onClick={async () => {
            const u = notice.undo; setNotice({ msg: 'Taking the fix back and proving the site again…' });
            try { await invoke('fix', { ...u, mode: 'undo' }); await recheck(`Undone: ${u.transitions.join(', ')} in ${u.name} no longer ${u.transitions.length === 1 ? 'changes' : 'change'} the resolution.`); }
            catch (e) { setNotice({ msg: 'Could not undo the fix: ' + (e.message || e) }); }
          }}>Undo</button>}
          <button className="il-link" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      <Watch stamp={report.checkedAt} />
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
                <button className={`il-lever ${r.workflow.id === sel.workflow.id ? 'pulled' : ''}`} onClick={() => { setSelId(r.workflow.id); setFocus(null); setTouched(true); if (!frozen) setFrozen(ranked.map((x) => x.workflow.id)); }}>
                  <span className="handle" aria-hidden="true" />
                  <span className="name" title={r.workflow.name}>{r.workflow.name}</span>
                  <span className="count">{liveOf(r) ? <span className="live" title={`${liveOf(r)} work items already in a wrong state`}>{liveOf(r)}</span> : null}{r.findings.length ? <span title={`${r.findings.length} ${r.findings.length === 1 ? 'finding' : 'findings'}`}><Lamp state="red" />{r.findings.length}</span> : <Lamp state="green" />}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <main className="il-main">
          <Diagram key={sel.workflow.id} model={model} result={sel} focus={focus} />
        </main>
        <Table result={sel} model={model} focus={focus} setFocus={setFocus} replays={replays} setReplays={setReplays} onFixed={recheck} onIntended={markIntended}
          lastFix={report.fixes?.[sel.workflow.id]} onUndoFix={async (fx) => {
            setNotice({ msg: 'Taking the fix back and proving the site again…' });
            try { await invoke('fix', { workflowId: sel.workflow.id, property: fx.property, status: fx.status, before: fx.before, mode: 'undo' }); await recheck(`Undone: ${fx.transitions.join(', ')} in ${fx.name} are back as they were.`); }
            catch (e) { setNotice({ msg: 'Could not undo the fix: ' + (e.message || e) }); }
          }}
          rules={rules[sel.workflow.id] || []} setRules={(r) => { setRules((x) => ({ ...x, [sel.workflow.id]: r })); invoke('saveRules', { workflowId: sel.workflow.id, rules: r }).catch(() => {}); }} />
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
  const onRoute = new Set(route.length ? [model.initial, ...route.flatMap((h) => [h.from, h.to])] : []);
  const trainRef = useRef(null), pathRefs = useRef({});
  // the whole workflow fits the frame by default; zooming in lets the frame scroll
  const [zoom, setZoom] = useState(1);

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
    <div className={`il-diagram-wrap ${zoom > 1 ? 'zoomed' : 'fit'}`}>
      <div className="il-zoom" role="group" aria-label="Zoom the track diagram">
        <button onClick={() => setZoom((z) => Math.max(1, z - 0.5))} disabled={zoom <= 1} aria-label="Zoom out">−</button>
        <button onClick={() => setZoom(1)} disabled={zoom === 1}>Fit</button>
        <button onClick={() => setZoom((z) => Math.min(4, z + 0.5))} aria-label="Zoom in">+</button>
      </div>
      <svg className={`il-diagram ${route.length ? 'focused' : ''}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet"
        style={zoom > 1 ? { width: width * zoom * 0.6, height: height * zoom * 0.6 } : { maxHeight: height * 1.7, maxWidth: width * 1.7 }} role="img" aria-label={`Track diagram of ${result.workflow.name}`}>
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
            <g key={s.id} className={`il-block ${s.category.toLowerCase()} ${state} ${onRoute.has(s.id) ? 'onroute' : ''}`} transform={`translate(${p.x},${p.y})`} style={{ '--t': `${i * 90}ms` }}>
              <rect width={BLOCK_W} height={BLOCK_H} rx="5" />
              <circle className="lamp" cx="16" cy={BLOCK_H / 2} r="6" />
              <StatusLabel name={s.name} />
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

// A status name on its block: one line when it fits, two lines split at a space when it does not
function StatusLabel({ name }) {
  if (name.length <= 19) return <text x="30" y={BLOCK_H / 2 + 5}>{name}</text>;
  const cut = name.lastIndexOf(' ', 19) > 6 ? name.lastIndexOf(' ', 19) : 19;
  const a = name.slice(0, cut).trim(), rest = name.slice(cut).trim();
  const b = rest.length > 19 ? rest.slice(0, 18) + '…' : rest;
  return <text x="30" y={BLOCK_H / 2 - 2} className="two"><tspan x="30">{a}</tspan><tspan x="30" dy="13">{b}</tspan><title>{name}</title></text>;
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
function Table({ result, model, focus, setFocus, replays, setReplays, rules, setRules, onFixed, onIntended, lastFix, onUndoFix }) {
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
    <aside className="il-table" aria-label="Interlocking table" ref={(el) => { if (el && el.dataset.wf !== result.workflow.id) { el.scrollTop = 0; el.dataset.wf = result.workflow.id; } }}>
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
              <Evidence obs={result.observed?.[property]} property={property} flagged={list.map((x) => x.subject)} fixAt={lastFix?.at} />
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
                  {f.property !== 'mustPass' && <Intend key={`i${f.id}`} onSave={(reason) => onIntended(result, f, reason)} />}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {lastFix && (
        <p className="il-lastfix">Interlock changed this workflow on {new Date(lastFix.at).toLocaleDateString()}: {lastFix.transitions.join(', ')}. <button className="il-link" onClick={() => onUndoFix(lastFix)}>Undo that fix</button></p>
      )}
      {result.intended?.length > 0 && (
        <section className="il-intended">
          <h3>Recorded as intended</h3>
          <ul>
            {result.intended.map((f) => (
              <li key={f.id}>
                <span><b>{f.title}</b>{f.subject ? `, ${f.subject}` : ''}</span>
                <span className="il-note">{f.record.by}, {new Date(f.record.at).toLocaleDateString()}{f.record.reason ? `: ${f.record.reason}` : ''}</span>
                <button className="il-link" onClick={() => onIntended(result, f, '', true)}>Undo</button>
              </li>
            ))}
          </ul>
        </section>
      )}
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
function Evidence({ obs, property, flagged, fixAt }) {
  const [trace, setTrace] = useState(null);
  if (!obs) return null;
  const noun = property === 'doneUnresolved' ? ['done work item is unresolved', 'done work items are unresolved'] : ['open work item still has a resolution', 'open work items still have a resolution'];
  const link = `/issues/?jql=${encodeURIComponent(obs.jql)}`;
  const byStatus = Object.entries(obs.byStatus || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const elsewhere = obs.byStatus ? obs.bad - byStatus.reduce((t, [, n]) => t + n, 0) : 0;
  if (obs.bad > 0) {
    return (
      <div className="il-evidence now">
        <p>Happening now: {obs.bad.toLocaleString()} of {obs.of.toLocaleString()} {obs.bad === 1 ? noun[0] : noun[1]}. <button className="il-link" onClick={() => openPath(link)}>Show them</button>
          {' '}{!trace && <button className="il-link" onClick={async () => { setTrace('loading'); try { setTrace(await invoke('traceItems', { jql: obs.jql, flagged, since: fixAt })); } catch (e) { setTrace({ error: e.message }); } }}>How did they get there?</button>}</p>
        {(byStatus.length > 0 || elsewhere > 0) && (
          <p className="il-bystatus">
            {byStatus.map(([s, n]) => <span key={s}><b>{n.toLocaleString()}</b> in {s}</span>)}
            {elsewhere > 0 && <span className="other"><b>{elsewhere.toLocaleString()}</b> in statuses no route reaches today{fixAt ? ', so they got there before the fix' : ': the workflow changed since, or something else put them there'}. Read their history to see which.</span>}
          </p>
        )}
        {trace === 'loading' && <p className="il-trace">Reading their history…</p>}
        {trace?.error && <p className="il-trace">{trace.error}</p>}
        {trace?.ways && (
          <ul className="il-trace">
            {trace.ways.map((w) => (
              <li key={`${w.from}${w.to}${w.effect}`} className={w.flagged ? 'on' : ''}><b>{w.count} of {trace.read}</b> came {w.from} → {w.to}, {w.effect}{w.flagged ? ', the step the proof flagged' : ''} <button className="il-link" onClick={() => openIssue(w.example)}>{w.example}</button></li>
            ))}
          </ul>
        )}
        {trace?.beforeSince > 0 && (
          <p className="il-trace"><b>{trace.beforeSince} of {trace.read}</b> got there before Interlock's fix on {new Date(fixAt).toLocaleDateString()}: the fix stops new ones, these are left to clean up with a bulk edit. <button className="il-link" onClick={() => openPath(link)}>Show them</button></p>
        )}
        {(trace?.noStep > 0 || trace?.system > 0) && (
          <p className="il-trace">{[trace.noStep > 0 && `${trace.noStep} were created or imported in this state`, trace.system > 0 && `${trace.system} got there through a system change with no author, such as a migration`].filter(Boolean).join('; ')}: no route is to blame for those.</p>
        )}
      </div>
    );
  }
  if (!obs.of) return <p className="il-evidence none">No {property === 'doneUnresolved' ? 'done' : 'open'} work items use this workflow yet.</p>;
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
      {state ? <p>{state}</p> : <><p>Want a software example with a review rule to prove?</p><button className="il-btn" onClick={go}>Add the Ship demo project</button></>}
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
          { workflowId: result.workflow.id, property: f.property, status: f.status, transitions: r.changed, before: r.before, name: result.workflow.name });
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
      {obs?.bad > 0 && <p className="il-note">The fix stops new cases. {obs.bad === 1 ? 'The 1 work item already affected needs' : `The ${obs.bad} work items already affected need`} a bulk change: <button className="il-link" onClick={() => openPath(`/issues/?jql=${encodeURIComponent(obs.jql)}`)}>open them</button>.</p>}
    </div>
  );
}

// One row per property, worst first; each affected status becomes a chip with its own route.
const SEVERITY = ['approvalSkipped', 'stranded', 'mustPass', 'doneUnresolved', 'openResolved', 'nobody', 'unreachable'];
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

// A route that is there on purpose (a pre-approved standard change, an admin-only shortcut) can be recorded
// as intended, with a reason, so it stops counting as a problem without being hidden.
function Intend({ onSave }) {
  const [open, setOpen] = useState(false), [reason, setReason] = useState(''), [busy, setBusy] = useState(false);
  if (!open) return <p className="il-intend"><button className="il-link" onClick={() => setOpen(true)}>This route is intended…</button></p>;
  return (
    <div className="il-intend">
      <label>Why is it intended? <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Standard changes are pre-approved by the CAB" /></label>
      <button className="il-btn" disabled={busy} onClick={async () => { setBusy(true); try { await onSave(reason); } finally { setBusy(false); } }}>Record as intended</button>
      <button className="il-link" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
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

// What the watch has seen: when the last proof ran, and the findings that appeared or cleared since the one
// before. A new finding means someone's workflow edit opened a bad route; a cleared one was fixed.
function Watch({ stamp }) {
  const [w, setW] = useState(null);
  useEffect(() => { invoke('watchStatus', {}).then(setW).catch(() => setW(null)); }, [stamp]);
  if (!w?.last) return null;
  const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const latest = w.history?.[0];
  const fresh = latest && latest.at === w.last.at;
  const count = (h, kind) => h.changes.filter((c) => c.kind.startsWith(kind)).length;
  return (
    <details className="il-watch">
      <summary>
        <Lamp state={fresh && count(latest, 'new') ? 'red' : 'green'} />
        <span>
          Watched daily. Last proof {when(w.last.at)}{w.last.by === 'daily watch' ? ' by the daily watch' : ''}:{' '}
          {w.last.unreadableScreens ? `${w.last.unreadableScreens} transition screens could not be read, so this proof was not compared with the one before.` : fresh ? <>{count(latest, 'new') ? <b>{plural(count(latest, 'new'), 'new finding', 'new findings')}</b> : null}{count(latest, 'new') && count(latest, 'fixed') ? ', ' : ''}{count(latest, 'fixed') ? plural(count(latest, 'fixed'), 'finding fixed', 'findings fixed') : ''} since the last proof.</> : 'nothing changed since the last proof.'}
        </span>
        {w.history?.length > 0 && <span className="il-watch-more">Show history</span>}
      </summary>
      {w.history?.length > 0 && (
        <ol>
          {w.history.map((h) => (
            <li key={h.at}>
              <time>{when(h.at)}</time>
              <ul>
                {h.changes.map((c, k) => (
                  <li key={k} className={c.kind.startsWith('new') ? 'new' : 'fixed'}>
                    <Lamp state={c.kind.startsWith('new') ? 'red' : 'green'} />
                    <span><b>{c.kind.startsWith('new') ? 'New' : 'Fixed'}:</b> {c.title}{c.subject ? `, ${c.subject}` : ''} in {c.workflow}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
