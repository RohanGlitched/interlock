// Interlock: every workflow on the site checked like a railway interlocking. The lever frame lists the
// workflows, the track diagram shows one of them, and the interlocking table lists what can go wrong,
// each with the exact route, which can be replayed on a real work item to prove it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, openIssue, openPath } from './bridge.js';
import { check, explore, PROPERTIES, ruleVerdict } from '../../../engine/interlock.mjs';
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
  const [countFailed, setCountFailed] = useState(false);
  // once someone picks a workflow the list stops reordering, so counts arriving never move a lever away
  // from under the pointer; a new check unfreezes it
  const [frozen, setFrozen] = useState(null);
  const [openGroups, setOpenGroups] = useState({});
  const [touched, setTouched] = useState(false);

  // a large site is read in parts: each call reads screens for up to 15 seconds and caches them, and the page asks
  // again until the proof is complete
  const [progress, setProgress] = useState(null);
  const prove = async (payload) => {
    for (let k = 0; k < 20; k++) {
      const r = await invoke('checkSite', k ? {} : payload);
      if (!r?.partial) { setProgress(null); return r; }
      setProgress(r);
    }
    throw new Error('This site has more transition screens than Interlock could read in five minutes.');
  };
  const run = (fresh = false) => {
    setReport(null); setError(null); setFrozen(null); setTouched(false); setRankedWithCounts(false); setFocus(null); setNotice(null);
    prove({ fresh }).then((r) => {
      setReport(r);
      setMeasuring(true);
      setCountFailed(false);
      invoke('measureSite', {}).then((m) => setReport((cur) => (cur && cur.checkedAt === r.checkedAt ? withCounts(cur, m) : cur))).catch(() => setCountFailed(true)).finally(() => setMeasuring(false));
      const live = rankScore;
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
    if (!w) return;
    setSelId(w.workflow.id); setPendingSelect(null);
    // a workflow that was not there before (the Ship demo) goes to the top of the frame, in view
    setFrozen((f) => (f && !f.includes(w.workflow.id) ? [w.workflow.id, ...f] : f));
    requestAnimationFrame(() => document.querySelector('.il-lever.pulled')?.scrollIntoView({ block: 'nearest' }));
  }, [pendingSelect, report]);
  const recheck = async (msg, undo = null) => {
    // the notice comes first: a change already saved in Jira is reported even if proving the site again fails
    setNotice(msg ? { msg, undo } : null);
    let r;
    try { r = await prove({}); }
    catch (e) { setNotice({ msg: `${msg || ''} Proving the site again failed (${e.message || e}); select Check again.`, undo, error: true }); return; }
    setReport(r); setFocus(null);
    setMeasuring(true);
    invoke('measureSite', {}).then((m) => setReport((cur) => (cur && cur.checkedAt === r.checkedAt ? withCounts(cur, m) : cur))).catch(() => {}).finally(() => setMeasuring(false));
  };

  // re-check the selected workflow in the browser whenever its rules change
  const [intended, setIntended] = useState({});
  useEffect(() => { if (report?.intended) setIntended(report.intended); }, [report?.checkedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  // rules come from app storage with the proof, and every change is saved back
  useEffect(() => { if (report?.rules) setRules(report.rules); }, [report?.checkedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const results = useMemo(() => {
    if (!report) return [];
    return report.results.map((r) => {
      const wfRules = rules[r.workflow.id];
      const hasModel = !!report.models[r.workflow.id];
      const model = { ...report.models[r.workflow.id], teamManaged: r.teamManaged };
      const ruled = (f) => f.property === 'mustPass' || f.property === 'ruleStale';
      const all = hasModel && (wfRules?.length || report.rules?.[r.workflow.id]?.length)
        ? [...r.findings.filter((f) => !ruled(f)), ...check(model, { mustPass: wfRules || [] }).filter(ruled).map((f, i) => ({ ...f, id: `rule${i + 1}` }))]
        : r.findings;
      const isIntended = (f) => intended[`${r.workflow.id}|${f.property}|${f.subject || ''}`];
      return { ...r, findings: all.filter((f) => !isIntended(f)), intended: all.filter(isIntended).map((f) => ({ ...f, record: isIntended(f) })) };
    });
  }, [report, rules, intended]);
  const [autoStage, setAutoStage] = useState(null);
  useEffect(() => {
    if (!report || !results.length || touched) return;
    const stage = `${report.checkedAt}|${results.some((r) => r.observed)}`;
    if (autoStage === stage) return;
    setAutoStage(stage);
    const ship = results.find((r) => r.workflow.name === 'Ship: Software delivery workflow' && r.findings.length);
    const pick = ship || [...results].sort((a, b) => rankScore(b) - rankScore(a) || b.findings.length - a.findings.length || a.workflow.name.localeCompare(b.workflow.name))[0];
    if (!pick?.findings.length) return;
    setSelId(pick.workflow.id);
    setFocus(worstFinding(pick));
    requestAnimationFrame(() => document.querySelector('.il-lever.pulled')?.scrollIntoView({ block: 'nearest' }));
  }, [report, results, touched, autoStage]); // eslint-disable-line react-hooks/exhaustive-deps
  const markIntended = async (r, f, reason, undo = false) => {
    const out = await invoke('markIntended', { workflowId: r.workflow.id, property: f.property, subject: f.subject, reason, undo });
    setIntended(out.intended || {});
  };

  // the lever order is set once, when the proof arrives (most findings first); counts that arrive later
  // add their badges without moving anything under the pointer
  // until someone picks a workflow, the order follows the evidence: once the live counts arrive, the
  // workflows with work items already wrong move to the top (once); after a pick it holds still
  const counted = results.some((r) => r.observed);
  const [rankedWithCounts, setRankedWithCounts] = useState(false);
  useEffect(() => {
    const live = rankScore;
    const order = () => [...results].sort((a, b) => live(b) - live(a) || b.findings.length - a.findings.length || a.workflow.name.localeCompare(b.workflow.name)).map((x) => x.workflow.id);
    if (results.length && !frozen) setFrozen(order());
    else if (counted && !rankedWithCounts && !touched) { setFrozen(order()); setRankedWithCounts(true); }
  }, [results, frozen, counted, touched, rankedWithCounts]);

  if (error) return <div className="il-empty"><h1>Interlock could not read this site's workflows</h1><p>{error}</p>{/\b(401|403)\b|administrator/i.test(error) ? <p>Interlock needs a Jira administrator to open it, because workflows are site configuration.</p> : <p>Jira did not answer in time or reported an error. Check again in a minute: what was read is kept for ten minutes.</p>}<button className="il-btn" onClick={() => run(true)}>Check again</button></div>;
  if (!report) return <Boot progress={progress} />;

  if (!results.length) return <div className="il-empty"><h1>No workflows to check</h1><p>Jira returned no workflows for this site. Interlock checks company-managed and team-managed workflows that a Jira administrator can read.</p><button className="il-btn" onClick={() => run(true)}>Check again</button></div>;
  const sel = results.find((r) => r.workflow.id === selId) || results[0];
  const model = { ...report.models[sel.workflow.id], teamManaged: sel.teamManaged };
  const totals = summarise(results);
  // the red badge counts work items in a status a proved route leads to (the finding's own); items left over in
  // statuses no route reaches today get a quieter amber badge
  const countsOf = (r) => Object.entries(r.observed || {}).filter(([p]) => r.findings.some((f) => f.property === p)).reduce((acc, [p, o]) => {
    const own = o.byStatus ? r.findings.filter((f) => f.property === p).reduce((t, f) => t + (o.byStatus[f.subject] || 0), 0) : o.bad;
    return { own: acc.own + own, left: acc.left + Math.max(0, o.bad - own - intendedCount(r, p, o)) };
  }, { own: 0, left: 0 });
  const liveOf = (r) => countsOf(r).own * 1e6 + countsOf(r).left; // ranks by explained items first
  const ranked = [...results].sort((a, b) => liveOf(b) - liveOf(a) || b.findings.length - a.findings.length || a.workflow.name.localeCompare(b.workflow.name));
  const list = (frozen ? [...results].sort((a, b) => (frozen.indexOf(a.workflow.id) + 1 || 1e9) - (frozen.indexOf(b.workflow.id) + 1 || 1e9)) : ranked)
    .filter((r) => filter === 'all' || !totals.withFindings || r.findings.length);

  return (
    <div className="il-app" onPointerDownCapture={() => { if (!touched) setTouched(true); }} onKeyDownCapture={() => { if (!touched) setTouched(true); }}>
      <header className="il-head">
        <div className="il-brand"><Lamp state={totals.withFindings ? 'red' : results.some((r) => r.undecided?.length || r.noInitial) ? 'amber' : 'green'} /><h1>Interlock</h1></div>
        <dl className="il-board">
          <div><dt>workflows proved</dt><dd>{results.length.toLocaleString()}</dd></div>
          <div className={totals.withFindings ? 'bad' : 'good'}><dt>{totals.withFindings === 1 ? 'has routes that go wrong' : 'have routes that go wrong'}</dt><dd>{totals.withFindings.toLocaleString()}</dd></div>
          <div className={totals.live ? 'bad' : ''}><dt>{countFailed && !totals.live ? 'work items: Jira could not count them' : 'work items already wrong'}</dt><dd>{totals.live ? totals.live.toLocaleString() : measuring ? '…' : countFailed ? '–' : '0'}</dd></div>
        </dl>
        <p className="il-summary">
          {totals.transitions.toLocaleString()} transitions, every reachable state, in {report.ms} ms.
          {totals.live > 0 && totals.onRoute < totals.live ? <> <b>{totals.onRoute.toLocaleString()}</b> of the work items sit where a proved route still leads today.</> : measuring ? ' Counting the work items already affected…' : ''}
        </p>
        <button className="il-btn" onClick={() => run(true)}>Check again</button>
      </header>
      {notice && (
        <div className={`il-notice ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}><Lamp state={notice.error ? 'red' : 'green'} />{notice.msg}
          {notice.undo && <button className="il-link" onClick={async () => {
            const u = notice.undo; setNotice({ msg: 'Taking the fix back and proving the site again…' });
            try { const out = await invoke('fix', { ...u, mode: 'undo' }); if (!out?.applied) throw new Error((out?.errors || []).join(' ') || out?.note || 'Jira did not accept the change'); await recheck(`Undone: ${u.transitions.join(', ')} in ${u.name} no longer ${u.transitions.length === 1 ? 'changes' : 'change'} the resolution.`); }
            catch (e) { setNotice({ msg: 'Could not undo the fix: ' + (e.message || e), error: true }); }
          }}>Undo</button>}
          <button className="il-link" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      <Watch stamp={report.checkedAt} />
      <div className="il-body">
        <nav className="il-levers" aria-label="Workflows">
          <div className="il-filter" role="group" aria-label="Show">
            <button aria-pressed={filter === 'findings'} className={filter === 'findings' ? 'on' : ''} onClick={() => setFilter('findings')}>With findings <span>{totals.withFindings}</span></button>
            <button aria-pressed={filter === 'all'} className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All <span>{results.length}</span></button>
          </div>
          {totals.withFindings > 0 && !results.some((r) => r.workflow.name === 'Ship: Software delivery workflow') && <Demo onDone={async (msg) => { setTouched(true); await recheck(msg); setSelId((id) => id); setPendingSelect('Ship: Software delivery workflow'); }} />}
          <p className="il-lever-key" aria-hidden="true"><span className="live">n</span> work items already wrong <span><Lamp state="red" />n</span> findings</p>
          <ul>
            {copyGroups(list).map((g) => {
              const lever = (r, member = false) => (
                <button aria-current={r.workflow.id === sel.workflow.id ? 'true' : undefined} className={`il-lever ${member ? 'member' : ''} ${r.workflow.id === sel.workflow.id ? 'pulled' : ''}`} onClick={() => { setSelId(r.workflow.id); setFocus(null); setTouched(true); if (!frozen) setFrozen(ranked.map((x) => x.workflow.id)); }}>
                  <span className="handle" aria-hidden="true" />
                  <LeverName name={r.workflow.name} usage={member ? r.usage : g.members.flatMap((x) => x.usage)} copies={member ? 0 : g.members.length} />
                  <span className="count">{(() => { const m = countsOf(r); return m.own ? <span className="live" title={`${m.own} work items already in the state a proved route leads to`}>{m.own}<span className="sr"> work items already wrong,</span></span>
                    : m.left ? <span className="live left" title={`${m.left} work items left over in statuses no route reaches today`}>{m.left}<span className="sr"> work items left over,</span></span> : null; })()}{r.findings.length ? <span title={`${r.findings.length} ${r.findings.length === 1 ? 'finding' : 'findings'}${!member && g.members.length > 1 ? ' in each copy' : ''}`}><Lamp state="red" />{r.findings.length}<span className="sr"> {r.findings.length === 1 ? 'finding' : 'findings'}</span></span> : <><Lamp state="green" /><span className="sr">no findings</span></>}</span>
                </button>
              );
              const open = openGroups[g.key] ?? g.members.some((x, i) => i > 0 && x.workflow.id === sel.workflow.id);
              return (
                <li key={g.key}>
                  {lever(g.members[0])}
                  {g.members.length > 1 && <button className="il-copies" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} the ${g.members.length} copies with the same findings`} onClick={() => setOpenGroups((o) => ({ ...o, [g.key]: !open }))}>{open ? '▾' : '▸'} {g.members.length} copies</button>}
                  {g.members.length > 1 && open && <ul className="il-members">{g.members.map((x) => <li key={x.workflow.id}>{lever(x, true)}</li>)}</ul>}
                </li>
              );
            })}
          </ul>
        </nav>
        <main className="il-main">
          {!totals.withFindings && !results.some((r) => r.workflow.name === 'Ship: Software delivery workflow') ? (
            <div className="il-clear">
              <Lamp state="green" />
              <h2>{results.some((r) => r.undecided?.length || r.noInitial)
                ? `No workflow has a route that goes wrong; ${results.filter((r) => r.undecided?.length || r.noInitial).length} could not be fully decided`
                : `All ${results.length.toLocaleString()} workflows hold, in every reachable state`}</h2>
              <p>{results.some((r) => r.undecided?.length || r.noInitial) ? 'Some properties depend on a transition screen Interlock cannot read, or a workflow has no create transition; those are named on each workflow. ' : ''}{results.some((r) => r.intended?.length) ? 'Routes recorded as intended are listed on their workflows. ' : ''}{results.some((r) => r.undecided?.length || r.noInitial || r.intended?.length) ? 'Apart from those, no' : 'No'} route leaves work done but unresolved, reopened but still resolved, stranded, or past an approval. To see what Interlock does when one does, add a small software project whose workflow has the shortcuts teams add over time.</p>
              <Demo primary onDone={async (msg) => { setTouched(true); await recheck(msg); setPendingSelect('Ship: Software delivery workflow'); }} />
            </div>
          ) : report.models[sel.workflow.id]
            ? <Diagram key={sel.workflow.id} model={model} result={sel} focus={focus} />
            : <div className="il-empty small"><p>This site has so many workflows that Interlock sends diagrams only for the ones with findings. {sel.workflow.name} has none{sel.undecided?.length || sel.noInitial ? '; some of its properties could not be decided (see the table)' : ': every property holds for every reachable state'}.</p></div>}
        </main>
        <Table key={sel.workflow.id} result={sel} model={model} focus={focus} setFocus={(f) => { setTouched(true); setFocus(f); }} replays={replays} setReplays={setReplays} onFixed={recheck} onIntended={markIntended}
          fixes={Object.values(report.fixes || {}).filter((x) => x.workflowId === sel.workflow.id)} onUndoFix={async (fx) => {
            setNotice({ msg: 'Taking the fix back and proving the site again…' });
            try { const out = await invoke('fix', { workflowId: sel.workflow.id, property: fx.property, status: fx.status, mode: 'undo' }); if (!out?.applied) throw new Error((out?.errors || []).join(' ') || out?.note || 'Jira did not accept the change'); await recheck(out.note ? `Undone: ${out.note}` : `Undone: ${fx.transitions.join(', ')} in ${fx.name} are back as they were.`); }
            catch (e) { setNotice({ msg: 'Could not undo the fix: ' + (e.message || e), error: true }); }
          }}
          rules={rules[sel.workflow.id] || []} setRules={(r) => { setRules((x) => ({ ...x, [sel.workflow.id]: r })); invoke('saveRules', { workflowId: sel.workflow.id, rules: r }).catch((e) => setNotice({ msg: 'The rule is proved here but was not saved: ' + (e.message || e), error: true })); }} />
      </div>
    </div>
  );
}

// Copies of one workflow (the same name after the project key) with the same findings are one lever, in list order.
function copyGroups(list) {
  const base = (r) => r.workflow.name.replace(/^[A-Z][A-Z0-9_]{1,11}: /, '');
  const sig = (r) => `${base(r)}|${r.findings.map((f) => `${f.property}:${f.subject}`).sort().join(',')}`;
  const groups = new Map();
  for (const r of list) { const k = r.findings.length ? sig(r) : r.workflow.id; if (!groups.has(k)) groups.set(k, { key: k, members: [] }); groups.get(k).members.push(r); }
  return [...groups.values()];
}

// The finding to light first: the one with the most work items already in its status, else the most severe.
function worstFinding(r) {
  const own = (f) => r.observed?.[f.property]?.byStatus?.[f.subject] || 0;
  const all = groupFindings(r.findings).flatMap((g) => g.list);
  return [...all].filter((f) => own(f) > 0).sort((a, b) => own(b) - own(a))[0] || all.find((f) => f.route?.hops?.length) || all[0] || null;
}

// Work items in statuses whose finding an admin recorded as intended: kept out of every count.
function intendedCount(r, p, o) {
  if (!o?.byStatus) return 0;
  return (r.intended || []).filter((f) => f.property === p).reduce((t, f) => t + (o.byStatus[f.subject] || 0), 0);
}

// Workflows are ranked by work items a proved route explains, then by items left over, then by findings.
function rankScore(r) {
  return Object.entries(r.observed || {}).filter(([p]) => r.findings.some((f) => f.property === p)).reduce((acc, [p, o]) => {
    const own = o.byStatus ? r.findings.filter((f) => f.property === p).reduce((t, f) => t + (o.byStatus[f.subject] || 0), 0) : o.bad;
    return acc + own * 1e6 + Math.max(0, o.bad - own - intendedCount(r, p, o));
  }, 0);
}

function withCounts(report, counts) {
  return { ...report, results: report.results.map((r) => (counts[r.workflow.id] ? { ...r, ...counts[r.workflow.id] } : r)) };
}

function summarise(results) {
  const live = results.reduce((a, r) => a + Object.entries(r.observed || {}).filter(([p]) => r.findings.some((f) => f.property === p)).reduce((b, [p, o]) => b + Math.max(0, o.bad - intendedCount(r, p, o)), 0), 0);
  // of those, the ones in a status a proved route reaches in that bad state today
  const onRoute = results.reduce((a, r) => a + Object.entries(r.observed || {}).filter(([p]) => r.findings.some((f) => f.property === p)).reduce((b, [p, o]) => {
    if (!o.byStatus) return b + o.bad;
    const statuses = new Set(r.findings.filter((f) => f.property === p).map((f) => f.subject));
    return b + Object.entries(o.byStatus).filter(([s]) => statuses.has(s)).reduce((t, [, n]) => t + n, 0);
  }, 0), 0);
  return {
    live, onRoute,
    transitions: results.reduce((a, r) => a + r.transitions, 0),
    withFindings: results.filter((r) => r.findings.length).length,
  };
}

function Boot({ progress = null }) {
  return (
    <div className="il-boot" role="status">
      <div className="il-boot-track">{[0, 1, 2, 3, 4].map((i) => <Lamp key={i} state="amber" style={{ animationDelay: `${i * 0.18}s` }} />)}</div>
      <p>{progress ? `A large site: ${progress.screensRead} of ${progress.screensTotal} transition screens read so far…` : 'Reading every workflow, status and transition screen on this site…'}</p>
    </div>
  );
}

// "PROC: Procurement Workflow v2" reads as the project key over the workflow's own name, two lines at most
const JSM = / workflow for Jira Service Management$/i;
function LeverName({ name, usage = [], copies = 0 }) {
  const m = /^([A-Z][A-Z0-9_]{1,11}): (.+)$/.exec(name);
  const projects = [...new Set(usage.map((u) => u.project).filter(Boolean))];
  const plate = projects[0] || m?.[1];
  let rest = m ? m[2] : name;
  const jsm = JSM.test(rest);
  if (jsm) rest = rest.replace(JSM, '');
  return (
    <span className="name" title={`${name}${projects.length ? ` (used in ${projects.join(', ')})` : ''}`}>
      {plate && <b className="proj">{plate}{projects.length > 1 ? ` +${projects.length - 1}` : ''}</b>}
      {rest}{jsm && <i className="tag">JSM</i>}
    </span>
  );
}

export function Lamp({ state, style }) { return <span className={`il-lamp ${state}`} style={style} aria-hidden="true" />; }

// ---------- the track diagram ----------
function Diagram({ model, result, focus }) {
  // measure the frame, then draw the workflow left to right or top to bottom, whichever comes out larger
  const [frame, setFrame] = useState(null);
  const observer = useRef(null);
  // the whole workflow fits the frame by default; zooming in lets the frame scroll
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  // a callback ref, so the frame is measured whenever the wrapper is (re)attached
  const wrapRef = useCallback((el) => {
    observer.current?.disconnect();
    if (!el || typeof ResizeObserver === 'undefined') return;
    // (only measured at fit: zooming in grows the frame, and must not turn the diagram round)
    observer.current = new ResizeObserver(([e]) => zoomRef.current === 1 && setFrame((f) => {
      const w = Math.round(e.contentRect.width), h = Math.round(e.contentRect.height);
      return f && f.w === w && f.h === h ? f : { w, h };
    }));
    observer.current.observe(el);
  }, []);
  const { pos, width, height, vertical } = useMemo(() => {
    const h = layout(model), v = layout(model, true);
    if (!frame || frame.w < 50 || frame.h < 50) return h;
    const fit = (l) => Math.min(frame.w / l.width, (frame.h - 60) / l.height);
    return fit(v) > fit(h) * 1.15 ? v : h;
  }, [model, frame]);
  // the scale the diagram has when it fits the frame; zoom multiplies it
  const fitScale = frame ? Math.max(0.55, Math.min(1.7, frame.w / width, (frame.h - 60) / height)) : 0.8;
  const order = useMemo(() => { // the order in which the explorer first reaches each status
    const seen = explore(model), first = new Map(); let i = 0;
    for (const n of seen.values()) if (!first.has(n.s)) first.set(n.s, i++);
    return first;
  }, [model]);
  const bad = new Set(result.findings.filter((f) => f.status && f.property !== 'unreachable').map((f) => f.status));
  // with a finding in focus, its own statuses are the red ones (all the statuses that finding is about)
  // (a rule finding is about its target and the status it skips; one nobody can use, about the transition's ends)
  const focusSet = focus ? new Set(focus.property === 'mustPass' ? [focus.rule?.target, focus.rule?.via].filter(Boolean)
    : focus.property === 'nobody' ? model.transitions.filter((t) => String(t.id) === String(focus.transition)).flatMap((t) => [...t.from, t.to])
    : focus.property === 'ruleStale' ? [focus.rule?.target, focus.rule?.via].filter((id) => model.statuses.some((x) => x.id === id))
    : result.findings.filter((f) => f.property === focus.property && f.status).map((f) => f.status)) : null;
  const unreachable = new Set(result.findings.filter((f) => f.property === 'unreachable').map((f) => f.status));
  const route = focus?.route?.hops || [];
  const routeKey = new Set(route.map((h) => `${h.transitionId}:${h.from}`));
  const onRoute = new Set(route.length ? [model.initial, ...route.flatMap((h) => [h.from, h.to])] : []);
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

  // each step of the focused route is named on its track, at about 12 px on screen
  const [hopLabels, setHopLabels] = useState([]);
  useEffect(() => {
    if (!route.length) { setHopLabels([]); return; }
    const out = [];
    route.forEach((h, i) => {
      const el = pathRefs.current[`${h.transitionId}:${h.from}`] || pathRefs.current[`${h.transitionId}:*`];
      if (!el) return;
      const len = el.getTotalLength(), p = el.getPointAtLength(len * (el.classList.contains('global') ? 0.85 : 0.5));
      out.push({ key: `${h.transitionId}:${h.from}:${i}`, x: p.x, y: p.y, text: h.transition });
    });
    setHopLabels(out);
  }, [focus, width, height, vertical]); // eslint-disable-line react-hooks/exhaustive-deps
  const labelSize = Math.min(18, Math.max(11, 12 / (fitScale * zoom)));
  // status names at about 11 px on screen or more, whatever the scale (wrapped to fit their block)
  const statusSize = Math.min(20, Math.max(13, 12 / (fitScale * zoom)));
  const globals = model.transitions.filter((t) => t.type === 'GLOBAL');
  const floorY = Math.max(...[...pos.values()].map((p) => p.y)) + BLOCK_H;
  return (
    <div ref={wrapRef} className={`il-diagram-wrap ${zoom > 1 ? 'zoomed' : 'fit'} ${vertical ? 'vertical' : ''}`}>
      <div className="il-zoom" role="group" aria-label="Zoom the track diagram">
        <button onClick={() => setZoom((z) => Math.max(1, z - 0.5))} disabled={zoom <= 1} aria-label="Zoom out">−</button>
        <button onClick={() => setZoom(1)} disabled={zoom === 1}>Fit</button>
        <button onClick={() => setZoom((z) => Math.min(4, z + 0.5))} aria-label="Zoom in">+</button>
      </div>
      <svg className={`il-diagram ${route.length ? 'focused' : ''}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet"
        style={zoom > 1 ? { width: width * fitScale * zoom, height: height * fitScale * zoom } : { maxHeight: height * 1.7, maxWidth: width * 1.7, minWidth: width * 0.55 }} role="img" aria-label={`Track diagram of ${result.workflow.name}`}>
        <defs>
          <filter id="il-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        {globals.length > 0 && (vertical
          ? <line className="il-rail" x1="16" x2="16" y1="34" y2={height - 20} />
          : <line className="il-rail" x1="16" x2={width - 16} y1="34" y2="34" />)}
        {globals.length > 0 && <text className="il-rail-label" x="18" y="24" style={{ fontSize: Math.min(15, Math.max(11, 11 / (fitScale * zoom))) }}>From any status</text>}
        {globals.map((t, k) => {
          const b = pos.get(t.to); if (!b) return null;
          const d = globalPath(b, k, vertical), on = routeKey.has(`${t.id}:${route.find((h) => h.transitionId === t.id)?.from}`);
          return <path key={t.id} id={on ? `il-lit-g${t.id}` : undefined} ref={(el) => { if (el) pathRefs.current[`${t.id}:*`] = el; }} d={d} className={`il-track global ${on ? 'route' : ''}`} />;
        })}
        {tracks(model).map((tr, k) => {
          const a = pos.get(tr.from), b = pos.get(tr.to); if (!a || !b) return null;
          const ids = tr.transitions.map((t) => `${t.id}:${tr.from}`);
          const on = ids.some((id) => routeKey.has(id));
          return (
            <path key={`${tr.from}>${tr.to}`} id={on ? `il-lit-t${k}` : undefined} d={trackPath(a, b, k % 4, vertical, floorY)} className={`il-track ${(vertical ? b.y <= a.y : b.x <= a.x) ? 'back' : ''} ${on ? 'route' : ''}`}
              ref={(el) => { if (el) for (const id of ids) pathRefs.current[id] = el; }}>
              <title>{tr.transitions.map((t) => t.name).join(', ')}</title>
            </path>
          );
        })}
        {model.statuses.map((s) => {
          const p = pos.get(s.id), state = unreachable.has(s.id) && !(focusSet && focus?.property === 'unreachable' && focusSet.has(s.id)) ? 'amber' : focusSet ? (focusSet.has(s.id) ? 'red' : s.id === model.initial ? 'green' : 'off') : bad.has(s.id) ? 'red' : 'green';
          const i = order.get(s.id) ?? 30;
          return (
            <g key={s.id} className={`il-block ${s.category.toLowerCase()} ${state} ${onRoute.has(s.id) ? 'onroute' : ''}`} transform={`translate(${p.x},${p.y})`} style={{ '--t': `${i * 90}ms` }}>
              <rect width={BLOCK_W} height={BLOCK_H} rx="5" />
              <circle className="lamp" cx="16" cy={BLOCK_H / 2} r="6" />
              <StatusLabel name={s.name} size={statusSize} />
              {s.id === model.initial && <text className="start" x="0" y="-8" style={{ fontSize: Math.min(15, Math.max(11, 11 / (fitScale * zoom))) }}>Created here</text>}
            </g>
          );
        })}
        {route.length > 0 && (
          <g className="il-route-top" aria-hidden="true">
            {globals.filter((t) => routeKey.has(`${t.id}:${route.find((h) => h.transitionId === t.id)?.from}`)).map((t) => <use key={`g${t.id}`} href={`#il-lit-g${t.id}`} />)}
            {tracks(model).map((tr, k) => (tr.transitions.some((t) => routeKey.has(`${t.id}:${tr.from}`)) ? <use key={`t${k}`} href={`#il-lit-t${k}`} /> : null))}
          </g>
        )}
        {route.length > 0 && !reduceMotion && <g ref={trainRef} className="il-train"><circle r="9" /><circle r="4" className="core" /></g>}
        {hopLabels.map((l) => {
          const w = l.text.length * labelSize * 0.56 + labelSize;
          return (
            <g key={l.key} className="il-hop" transform={`translate(${l.x},${l.y})`} aria-hidden="true">
              <rect x={-w / 2} y={-labelSize * 0.95} width={w} height={labelSize * 1.9} rx={labelSize * 0.95} />
              <text textAnchor="middle" y={labelSize * 0.36} style={{ fontSize: labelSize }}>{l.text}</text>
            </g>
          );
        })}
      </svg>
      {route.length > 0 && (
        <p className="il-route-strip">
          <span className="il-sr">The lit route: </span><b>{focus?.route?.startName}</b>{route.map((h, i) => <span key={i}> <i>{h.transition}</i> → <b>{h.toName}</b></span>)}
          {focus?.title ? <em>{' · '}{focus.title.toLowerCase()}</em> : null}
        </p>
      )}
      <Legend teamManaged={result.teamManaged} focused={!!focusSet} />
    </div>
  );
}

// A status name on its block: one line when it fits, two lines split at a space when it does not
function StatusLabel({ name, size = 13 }) {
  const per = Math.max(10, Math.floor(19 * 13 / size)); // characters a line holds at this size
  if (name.length <= per) return <text x="30" y={BLOCK_H / 2 + size * 0.38} style={{ fontSize: size }}>{name}</text>;
  const cut = name.lastIndexOf(' ', per) > 4 ? name.lastIndexOf(' ', per) : per;
  const a = name.slice(0, cut).trim(), rest = name.slice(cut).trim();
  const b = rest.length > per ? rest.slice(0, per - 1) + '…' : rest;
  const fs = size * 0.9;
  return <text x="30" y={BLOCK_H / 2 - fs * 0.2} className="two" style={{ fontSize: fs }}><tspan x="30">{a}</tspan><tspan x="30" dy={fs * 1.05}>{b}</tspan><title>{name}</title></text>;
}

function Legend({ teamManaged, focused }) {
  return (
    <p className="il-legend">
      {focused ? <>
        <span><Lamp state="red" />The statuses this finding is about</span>
        <span><span className="il-lamp off" />Not part of it</span>
        <span><Lamp state="green" />Where work is created</span>
      </> : <>
        <span><Lamp state="green" />Every route from here is sound</span>
        <span><Lamp state="red" />A route reaches this status in a bad state</span>
      </>}
      <span><Lamp state="amber" />No route reaches this status</span>
      {teamManaged && <span className="tm">Team-managed: Jira keeps the resolution in step with done statuses itself.</span>}
    </p>
  );
}

// ---------- the interlocking table ----------
function Table({ result, model, focus, setFocus, replays, setReplays, rules, setRules, onFixed, onIntended, fixes = [], onUndoFix }) {
  // the fix (if any) Interlock applied for one of these findings' statuses
  const fixFor = (property) => fixes.filter((x) => x.property === property).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  const usage = result.usage.find((u) => u.project);
  async function replay(f) {
    const k = `${result.workflow.id}|${f.property}|${f.subject}`;
    setReplays((r) => ({ ...r, [k]: { status: 'running' } }));
    try {
      const out = await invoke('replay', { project: usage.project, projectId: usage.projectId, issueType: usage.issueType, workflow: result.workflow.name, hops: f.route.hops, label: `${f.title}, ${result.workflow.name}`, startName: f.route.startName });
      setReplays((r) => ({ ...r, [k]: { status: 'done', ...out } }));
    } catch (e) { setReplays((r) => ({ ...r, [k]: { status: 'error', error: e.message } })); }
  }
  return (
    <aside className="il-table" aria-label="Interlocking table" ref={(el) => { if (el && el.dataset.wf !== result.workflow.id) { el.scrollTop = 0; el.dataset.wf = result.workflow.id; } }}>
      <h2 title={result.workflow.name}>{(() => { const m = /^([A-Z][A-Z0-9_]{1,11}): (.+)$/.exec(result.workflow.name); const rest = m ? m[2] : result.workflow.name;
        return JSM.test(rest) ? <>{rest.replace(JSM, '')} <i className="il-tag">Jira Service Management</i></> : rest; })()}</h2>
      <p className="il-meta">{plural(result.statuses, 'status', 'statuses')}, {plural(result.transitions, 'transition', 'transitions')}, {plural(result.states, 'reachable state', 'reachable states')}{usage ? `, used in ${[...new Set(result.usage.map((u) => u.project))].join(', ')}` : ''}.</p>
      {!result.findings.length && !result.undecided?.length && !result.noInitial && <p className="il-held"><Lamp state="green" />Every property holds for every reachable state.</p>}
      {result.noInitial && <p className="il-note">This workflow has no create transition, so there is no route to prove.</p>}
      {result.undecided?.length > 0 && <p className="il-note"><Lamp state="amber" /> Could not decide {result.undecided.map((p) => PROPERTIES[p]?.title.toLowerCase()).join(' or ')}: {result.undecided.includes('stranded') && result.undecided.length === 1
        ? 'this workflow has no done status, so there is nowhere work could finish.' : 'it depends on a transition screen Interlock cannot read. Check that screen\'s Resolution field by hand.'}</p>}
      <ol className="il-findings">
        {groupFindings(result.findings).map(({ property, list }) => {
          const active = list.find((f) => f.id === focus?.id);
          const f = active || list[0];
          const k = `${result.workflow.id}|${f.property}|${f.subject}`, rp = replays[k];
          const verdict = rp?.status === 'done' ? verdictOf(f, rp) : null;
          return (
            <li key={property} className={`il-finding ${active ? 'on' : ''} ${verdict?.confirmed ? 'confirmed' : ''}`}>
              <button className="il-finding-main" aria-expanded={!!active} onClick={() => setFocus(active ? null : list[0])}>
                <Lamp state={property === 'unreachable' ? 'amber' : 'red'} />
                <span><b>{f.title}</b>{list.length === 1 ? f.subject : `${list.length} statuses`}</span>
              </button>
              <Tiers f={f} obs={result.observed?.[property]} statuses={list.map((x) => x.subject)} verdict={verdict} />
              {result.observedError && (property === 'doneUnresolved' || property === 'openResolved') && <p className="il-evidence none">Jira could not count the work items: {result.observedError}</p>}
              <Evidence obs={result.observed?.[property]} property={property} flagged={list.map((x) => x.subject)} fixAt={fixFor(property)?.at}
                intended={(result.intended || []).filter((x) => x.property === property).map((x) => x.subject)} />
              {list.length > 1 && (
                <div className="il-chips" role="group" aria-label={f.title}>
                  {list.map((x) => <button key={x.id} aria-pressed={focus?.id === x.id} className={focus?.id === x.id ? 'on' : ''} onClick={() => setFocus(focus?.id === x.id ? null : x)}>{x.subject}</button>)}
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
                    <ReplayButton project={usage.project} onGo={() => replay(f)} />
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
                  {f.property !== 'mustPass' && f.property !== 'ruleStale' && <Intend key={`i${f.id}`} onSave={(reason) => onIntended(result, f, reason)} />}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {fixes.map((fx) => (
        <p key={`${fx.property}${fx.status}`} className="il-lastfix">Interlock changed this workflow on {new Date(fx.at).toLocaleDateString()} ({fx.statusName || 'one status'}): {fx.transitions.join(', ')}. <button className="il-link" onClick={() => onUndoFix(fx)}>Undo that fix</button></p>
      ))}
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
      {model.statuses && <Rules key={result.workflow.id} model={model} rules={rules} setRules={setRules} findings={result.findings} onShow={setFocus} />}
    </aside>
  );
}

// How far a finding has been taken, like a signal with three aspects: the proof says the route exists,
// Jira's data says work items are already there, and a replay walked a real work item down the route.
function Tiers({ f, obs, statuses, verdict }) {
  const counted = f.property === 'doneUnresolved' || f.property === 'openResolved';
  // lit only for items in this finding's own statuses (when Jira's count per status is known)
  const own = obs?.byStatus ? statuses.reduce((n, s) => n + (obs.byStatus[s] || 0), 0) : obs?.bad || 0;
  const tiers = [
    { label: 'Proved', aspect: 'white', on: true, why: f.route ? 'The model checker found this route among every reachable state.' : 'The model checker proved this over every reachable state.' },
    { label: 'In your data', aspect: 'amber', on: own > 0, na: !counted, why: counted ? 'Work items in the statuses this finding is about are already in this state.' : 'Jira data cannot show this kind of finding; replay the route instead.' },
    { label: 'Replayed', aspect: 'red', on: !!verdict?.confirmed, na: !f.route, why: 'A new work item followed the route through Jira itself.' },
  ];
  return (
    <ol className="il-tiers" aria-label="Evidence">
      {tiers.map((t) => (
        <li key={t.label} className={t.on ? 'on' : t.na ? 'na' : ''} title={t.why}>
          <span className={`il-lamp aspect ${t.on ? t.aspect : ''}`} aria-hidden="true" />
          {t.label}<span className="sr">{t.on ? ': yes' : t.na ? ': not applicable' : ': not yet'}</span>
        </li>
      ))}
    </ol>
  );
}

// What Jira's own data says: how many work items in the projects using this workflow are already in
// the state the proof says is reachable.
function Evidence({ obs, property, flagged, fixAt, intended = [] }) {
  const [trace, setTrace] = useState(null);
  if (!obs) return null;
  const noun = property === 'doneUnresolved' ? ['done work item is unresolved', 'done work items are unresolved'] : ['open work item still has a resolution', 'open work items still have a resolution'];
  const link = `/issues/?jql=${encodeURIComponent(obs.jql)}`;
  const byStatus = Object.entries(obs.byStatus || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  // items in a status recorded as intended are named as such, never as left over
  const onPurpose = byStatus.filter(([s]) => intended.includes(s));
  const elsewhere = obs.byStatus ? obs.bad - byStatus.filter(([s]) => flagged.includes(s) || intended.includes(s)).reduce((t, [, n]) => t + n, 0) : 0;
  // the finding's own statuses come first; the rest of the workflow's items are context, not this finding's evidence
  const own = obs.byStatus ? byStatus.filter(([s]) => flagged.includes(s)).reduce((t, [, n]) => t + n, 0) : obs.bad;
  if (obs.bad > 0) {
    return (
      <div className={`il-evidence ${own ? 'now' : 'other-only'}`}>
        <p>{own
          ? <>Happening now: {own.toLocaleString()} {own === 1 ? noun[0] : noun[1]} in {flagged.join(', ')}{obs.byStatus ? ` (${obs.bad.toLocaleString()} of ${obs.of.toLocaleString()} across this workflow)` : ` of ${obs.of.toLocaleString()}`}.</>
          : <>None in {flagged.join(', ')}. Elsewhere in this workflow, {obs.bad.toLocaleString()} of {obs.of.toLocaleString()} {obs.bad === 1 ? noun[0] : noun[1]}.</>}
          {' '}<button className="il-link" onClick={() => openPath(link)}>Show them</button>
          {' '}{!trace && <button className="il-link trace" onClick={async () => { setTrace('loading'); try { setTrace(await invoke('traceItems', { jql: obs.jql, flagged, since: fixAt })); } catch (e) { setTrace({ error: e.message }); } }}>How did they get there?</button>}</p>
        {(byStatus.length > 0 || elsewhere > 0 || onPurpose.length > 0) && (
          <p className="il-bystatus">
            {own > 0 && byStatus.filter(([s]) => flagged.includes(s)).map(([s, n]) => <span key={s}><b>{n.toLocaleString()}</b> in {s}</span>)}
            {onPurpose.map(([s, n]) => <span key={`i${s}`} className="other"><b>{n.toLocaleString()}</b> in {s} (recorded as intended)</span>)}
            {elsewhere > 0 && <span className="other"><b>{elsewhere.toLocaleString()}</b> in statuses no route leaves {property === 'doneUnresolved' ? 'unresolved' : 'resolved'} today: the workflow has changed since{fixAt ? ` (Interlock fixed it on ${new Date(fixAt).toLocaleDateString()})` : ', or something else put them there'}. Their history says which.</span>}
          </p>
        )}
        {trace === 'loading' && <p className="il-trace">Reading their history…</p>}
        {trace?.error && <p className="il-trace">{trace.error}</p>}
        {trace?.ways && obs.bad > 50 && <p className="il-trace">From the history of 50 of the {obs.bad.toLocaleString()} (the most recently changed):</p>}
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

// One click builds a realistic software project on an empty site, so the proof has real work items to count.
function Demo({ onDone, primary = false }) {
  const [state, setState] = useState(null);
  const go = async () => {
    try {
      setState('Creating the Ship workflow, scheme and project…');
      const { project, moves } = await invoke('demoSetup', {});
      for (let i = 0; i < moves.length; i += 4) {
        setState(`Moving work items along real routes: ${Math.min(i + 4, moves.length)} of ${moves.length}…`);
        await invoke('demoMove', { moves: moves.slice(i, i + 4) });
      }
      setState(null);
      await onDone(`Added the ${project} demo project: ${moves.length} work items moved along real routes of the Ship workflow.`);
    } catch (e) { setState('Could not build the demo: ' + (e.message || e)); }
  };
  return (
    <div className="il-demo">
      {state ? <p role="status">{state}</p> : primary ? <button className="il-btn primary" onClick={go}>Add the Ship demo project</button>
        : <><p>Want a software example with a review rule to prove?</p><button className="il-btn" onClick={go}>Add the Ship demo project</button></>}
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
        // the change is saved in Jira now; if proving the site again fails, say so without calling the fix failed
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
      {state.step === 'idle' && <><p>{f.property === 'doneUnresolved'
        ? <>Make every transition into {f.subject} set the resolution, except ones whose screen already asks the person for one.</>
        : <>Make every transition that takes work from a done status back to {f.subject} clear the resolution.</>} Jira checks the change before anything is saved, and you can undo it.</p><button className="il-btn" onClick={() => ask('validate')}>Check the fix with Jira</button></>}
      {state.step === 'checking' && <p className="il-note">Asking Jira to validate the change…</p>}
      {state.step === 'checked' && (state.valid ? (
        <>
          <p>Interlock will add <b>{f.property === 'doneUnresolved' ? `Set resolution to ${state.resolutionName}` : 'Clear resolution'}</b> to {state.changed.length === 1 ? 'the transition' : 'the transitions'} <b>{state.changed.join(', ')}</b> in {result.workflow.name}. Jira validated it: no errors.</p>
          {(() => { const projects = [...new Set((result.usage || []).map((u) => u.project).filter(Boolean))]; return projects.length > 1 ? <p>The workflow is shared: the change applies in <b>{projects.join(', ')}</b>.</p> : null; })()}
          {state.caveats?.length > 0 && <p className="il-err">{state.caveats.join('. ')}.</p>}
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
const SEVERITY = ['approvalSkipped', 'stranded', 'mustPass', 'doneUnresolved', 'openResolved', 'nobody', 'unreachable', 'ruleStale'];
function groupFindings(findings) {
  const by = new Map();
  for (const f of findings) { if (!by.has(f.property)) by.set(f.property, []); by.get(f.property).push(f); }
  return [...by.entries()].sort((a, b) => SEVERITY.indexOf(a[0]) - SEVERITY.indexOf(b[0])).map(([property, list]) => ({ property, list }));
}

function verdictOf(f, rp) {
  const last = rp.steps[rp.steps.length - 1];
  if (last.error) return { confirmed: false, text: ` Jira refused "${last.step}": ${last.error}` };
  const end = f.route?.hops?.[f.route.hops.length - 1]?.toName;
  if (end && last.status !== end) return { confirmed: false, text: ` ${rp.key} ended in ${last.status}, not ${end}: Jira took another way, so this replay proves nothing either way.` };
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

// Replay creates a real work item and moves it through Jira: one more click, with what that means said first.
function ReplayButton({ project, onGo }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <button className="il-btn primary" onClick={() => setAsking(true)}>Replay on a new work item in {project}</button>;
  return (
    <div className="il-confirm" role="group" aria-label="Confirm the replay">
      <p>This creates a real work item in <b>{project}</b> and moves it along the route. Notifications and automation in {project} may run on it. You can delete it here afterwards.</p>
      <button className="il-btn primary" onClick={() => { setAsking(false); onGo(); }}>Create it and replay</button>{' '}
      <button className="il-link" onClick={() => setAsking(false)}>Cancel</button>
    </div>
  );
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
function Rules({ model, rules, setRules, findings = [], onShow }) {
  const [target, setTarget] = useState(''), [via, setVia] = useState('');
  // each rule's verdict, from the proof; a rule just added lights its broken route at once
  const brokenBy = (r) => findings.find((f) => f.property === 'mustPass' && String(f.rule?.target) === String(r.target) && String(f.rule?.via) === String(r.via));
  const [justAdded, setJustAdded] = useState(null);
  useEffect(() => { if (!justAdded) return; const f = brokenBy(justAdded); if (f) onShow?.(f); setJustAdded(null); }, [findings, justAdded]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = model.statuses.filter((s) => s.category === 'DONE');
  return (
    <section className="il-rules">
      <h3>Rules for this workflow</h3>
      <p className="il-note">Interlock checks a rule against every route, not a sample of them.</p>
      {!rules.length && (() => {
        const open = model.statuses.filter((x) => x.category !== 'DONE' && x.id !== model.initial);
        const review = open.find((x) => /code review/i.test(x.name)) || open.find((x) => /review/i.test(x.name)) || open.find((x) => /qa|test/i.test(x.name));
        const done = model.statuses.find((x) => x.category === 'DONE' && !/cancel|declin|reject|won.?t|duplicate|abandon|obsolete|invalid/i.test(x.name));
        return review && done && (
          <p className="il-suggest">Try a rule teams rely on: <button className="il-link" onClick={() => { const r = { target: done.id, via: review.id }; setRules([r]); setJustAdded(r); }}>work reaches {done.name} only through {review.name}</button></p>
        );
      })()}
      {rules.map((r, i) => {
        const f = brokenBy(r), v = ruleVerdict(model, r);
        return (
          <p key={i} className="il-rule"><Lamp state={f || v.verdict === 'broken' ? 'red' : v.verdict === 'undecided' ? 'amber' : 'green'} /> Work reaches <b>{name(model, r.target)}</b> only through <b>{name(model, r.via)}</b>:{' '}
            {f ? <><b className="il-live">broken</b> <button className="il-link" onClick={() => onShow?.(f)}>Show the route</button></>
              : v.verdict === 'undecided' ? <b>cannot say: {v.reason}</b> : <b>holds on every route</b>}{' '}
            <button className="il-link" onClick={() => setRules(rules.filter((_, j) => j !== i))}>Remove</button></p>
        );
      })}
      <div className="il-rule-form">
        <span>Work reaches</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Target status">
          <option value="">a status…</option>
          {[...done, ...model.statuses.filter((s) => s.category !== 'DONE')].filter((s) => s.id !== model.initial).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <span>only through</span>
        <select value={via} onChange={(e) => setVia(e.target.value)} aria-label="Required status">
          <option value="">a status…</option>
          {model.statuses.filter((s) => s.id !== target && s.id !== model.initial).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button className="il-btn" disabled={!target || !via} onClick={() => { const r = { target, via }; setRules([...rules, r]); setJustAdded(r); setTarget(''); setVia(''); }}>Prove it</button>
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
