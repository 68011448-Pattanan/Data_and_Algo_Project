/* A* search lab: replays the backend expansion trace with playback controls, separate from the report tab. */
let algorithmTab = (() => { try { return localStorage.getItem('parkside-algorithm-tab') || 'report'; } catch (e) { return 'report'; } })();
const astarLab = {
  config: { destination: '0', leg: 'driving', mode: 'astar', slot: '' },
  graph: null, trace: null, model: null, summary: {},
  step: -1, timer: null, speed: 8, floor: 0, renderedFloor: -1, selected: null,
  follow: true, pauseOnFloor: false, labels: false, heuristic: true, tree: true,
  loading: false, error: '',
};
const AL_SPEEDS = [1, 2, 4, 8, 16, 32, 64, 128];
const AL_W = 1000, AL_H = 460;
const AL_Y = { 0: 45, 1: 84, 2: 143, 3: 184, 4: 225, 5: 248, 6: 271, 7: 312, 8: 371, 9: 412 };
const alKey = n => n.join(',');
const alSx = x => 36 + x * (928 / ((astarLab.graph?.columns || 25) + 1));
const alSy = y => AL_Y[y];
const alPlayIcons = {
  first: 'M6 5v14M19 5 9 12l10 7z', prev: 'M17 5 7 12l10 7z', next: 'M7 5l10 7-10 7z',
  last: 'M18 5v14M5 5l10 7-10 7z', play: 'M7 4.5v15l12-7.5z', pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
};
const alIcon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${alPlayIcons[name]}" fill="currentColor" stroke="none"/></svg>`;

function setAlgorithmTab(tab) {
  algorithmTab = tab === 'astar' ? 'astar' : 'report';
  try { localStorage.setItem('parkside-algorithm-tab', algorithmTab); } catch (e) { /* storage unavailable */ }
  if (algorithmTab !== 'astar') alPause();
}
function algorithmTabs() {
  const tab = (id, label, sub) => `<button role="tab" id="algo-tab-${id}" aria-selected="${algorithmTab === id}" aria-controls="algo-panel" class="${algorithmTab === id ? 'active' : ''}" data-action="algorithm-tab" data-tab="${id}"><strong>${label}</strong><span>${sub}</span></button>`;
  return `<div class="algo-tabs" role="tablist" aria-label="Algorithm views">${tab('report', 'Analysis report', 'Design, method, results')}${tab('astar', 'A* search lab', 'Step through the search')}</div>`;
}
function algorithmsView() {
  return `${algorithmTabs()}<div id="algo-panel" role="tabpanel" aria-labelledby="algo-tab-${algorithmTab}">${algorithmTab === 'astar' ? astarLabPage() : academicAlgorithmPage()}</div>`;
}

/* ---------- data ---------- */
function alHeuristic(a, b) {
  if (astarLab.trace?.mode === 'dijkstra') return 0;
  return (40 * Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) * 5;
}
function alBuildModel(trace) {
  const closedAt = new Map(), events = new Map(), openSizes = [], open = new Set();
  let seq = 0;
  const push = (node, e) => { const k = alKey(node); if (!events.has(k)) events.set(k, []); events.get(k).push({ ...e, seq: seq++ }); };
  push(trace.start, { step: -1, g: 0, h: alHeuristic(trace.start, trace.goal), parent: null, weight: 0 });
  open.add(alKey(trace.start));
  trace.steps.forEach((s, i) => {
    const k = alKey(s.node);
    closedAt.set(k, i); open.delete(k);
    s.relaxed.forEach(r => { push(r.node, { step: i, g: r.g, h: r.h, parent: s.node, weight: r.weight }); open.add(alKey(r.node)); });
    openSizes.push(open.size);
  });
  const fMax = Math.max(1, ...trace.steps.map(s => s.f));
  return { closedAt, events, openSizes, fMax, openMax: Math.max(1, ...openSizes), path: new Set(trace.path.map(alKey)) };
}
function alGraphIndex(graph) {
  const floors = new Map(), add = n => { const f = n[0]; if (!floors.has(f)) floors.set(f, new Map()); floors.get(f).set(alKey(n), n); };
  const local = new Map(), ramps = [];
  graph.edges.forEach(([a, b, w]) => {
    add(a); add(b);
    if (a[0] === b[0]) { if (!local.has(a[0])) local.set(a[0], []); local.get(a[0]).push([a, b, w]); } else ramps.push([a, b, w]);
  });
  const slots = new Map();
  state.floors.forEach(f => f.slots.forEach(s => slots.set(alKey(s.node), s)));
  const landmarks = new Map([[alKey([0, 0, 4]), 'Entrance']]);
  state.destinations.forEach(d => landmarks.set(alKey(d.node), d.name));
  return { ...graph, floors, local, ramps, slots, landmarks, floorCount: floors.size };
}
function alNodeName(n) {
  const k = alKey(n), g = astarLab.graph, fl = state.floors[n[0]]?.name ?? n[0];
  if (g?.slots.has(k)) return `Bay ${g.slots.get(k).id}`;
  if (g?.landmarks.has(k)) return `${g.landmarks.get(k)} · ${fl}`;
  if (n[1] === 0 && n[2] === 4) return `Ramp · floor ${fl}`;
  return `Aisle ${fl} (${n[1]}, ${n[2]})`;
}
/* Node state after expanding steps[k] (k = -1 means only the start is open). */
function alNodeState(k, step = astarLab.step) {
  const m = astarLab.model; if (!m) return null;
  const evs = m.events.get(k); if (!evs) return { status: 'unseen' };
  let last = null; for (const e of evs) { if (e.step <= step) last = e; else break; }
  if (!last) return { status: 'unseen' };
  const c = m.closedAt.get(k);
  return { status: c !== undefined && c <= step ? 'closed' : 'open', closedAt: c, ...last, f: last.g + last.h };
}
function alOpenList(step = astarLab.step) {
  const m = astarLab.model, list = [];
  m.events.forEach((evs, k) => {
    const c = m.closedAt.get(k); if (c !== undefined && c <= step) return;
    let last = null; for (const e of evs) { if (e.step <= step) last = e; else break; }
    if (last) list.push({ key: k, node: k.split(',').map(Number), g: last.g, h: last.h, f: last.g + last.h, seq: last.seq, parent: last.parent });
  });
  return list.sort((a, b) => a.f - b.f || a.seq - b.seq);
}
function alParentChain(node, step = astarLab.step) {
  const chain = [node]; let cur = node, guard = 0;
  while (guard++ < 5000) { const s = alNodeState(alKey(cur), step); if (!s?.parent) break; cur = s.parent; chain.push(cur); }
  return chain.reverse();
}

/* ---------- loading ---------- */
async function alEnsure() {
  if (astarLab.loading) return;
  if (!astarLab.graph) {
    astarLab.loading = true;
    try { astarLab.graph = alGraphIndex(await api('/api/algorithms/graph')); }
    catch (e) { astarLab.error = e.message; astarLab.loading = false; render(); return; }
    astarLab.loading = false;
  }
  if (!astarLab.trace) { astarLab.config.destination = String(draft.destination ?? '0'); await alBuild(); }
  else render();
}
function alReadConfig() {
  const v = id => document.getElementById(id)?.value;
  const c = astarLab.config;
  c.destination = v('al-destination') ?? c.destination; c.leg = v('al-leg') ?? c.leg;
  c.mode = v('al-mode') ?? c.mode; c.slot = (v('al-slot') ?? c.slot).trim().toUpperCase();
}
async function alBuild() {
  alPause(); alReadConfig();
  const c = astarLab.config;
  astarLab.loading = true; astarLab.error = ''; render();
  try {
    const q = new URLSearchParams({ destination: c.destination, leg: c.leg, mode: c.mode });
    if (c.slot) q.set('slot', c.slot);
    const trace = await api(`/api/algorithms/astar/trace?${q}`);
    astarLab.trace = trace; astarLab.model = alBuildModel(trace);
    astarLab.step = -1; astarLab.selected = null; astarLab.floor = trace.start[0]; astarLab.renderedFloor = -1;
    const sk = `${trace.destination}|${trace.leg}|${trace.slot}`;
    astarLab.summary[sk] = { ...(astarLab.summary[sk] || {}), [trace.mode]: { expanded: trace.expanded, distance: trace.distance } };
  } catch (e) { astarLab.error = e.message; toast(e.message, true); }
  finally { astarLab.loading = false; render(); }
}

/* ---------- playback ---------- */
function alLastStep() { return (astarLab.trace?.steps.length || 0) - 1; }
function alGo(step, { fromPlayback = false } = {}) {
  if (!astarLab.trace) return;
  const prev = astarLab.step;
  astarLab.step = Math.max(-1, Math.min(alLastStep(), step));
  const cur = astarLab.trace.steps[astarLab.step];
  const curFloor = cur ? cur.node[0] : astarLab.trace.start[0];
  if (fromPlayback && astarLab.pauseOnFloor && prev >= 0 && cur && astarLab.trace.steps[prev].node[0] !== curFloor) {
    alPause(); toast(`Search moved to floor ${state.floors[curFloor].name} · paused`);
  }
  if (astarLab.follow) astarLab.floor = curFloor;
  if (astarLab.step === alLastStep() && fromPlayback) {
    alPause(); astarLab.floor = astarLab.trace.goal[0];
    toast(`${astarLab.trace.mode === 'astar' ? 'A*' : 'Dijkstra'} reached the goal · ${astarLab.trace.expanded} expansions · ${astarLab.trace.distance} m`);
  }
  alUpdate();
}
function alPlay() {
  if (!astarLab.trace) return;
  if (astarLab.step >= alLastStep()) alGo(-1);
  clearInterval(astarLab.timer);
  const interval = 1000 / astarLab.speed, perTick = Math.max(1, Math.round(astarLab.speed / 60));
  astarLab.timer = setInterval(() => {
    for (let i = 0; i < perTick && astarLab.timer; i++) {
      if (astarLab.runTo !== undefined && astarLab.step + 1 >= astarLab.runTo) { const t = astarLab.runTo; astarLab.runTo = undefined; alPause(); alGo(t); return; }
      alGo(astarLab.step + 1, { fromPlayback: true });
    }
  }, Math.max(16, interval));
  alUpdateControls();
}
function alPause() { clearInterval(astarLab.timer); astarLab.timer = null; if (document.getElementById('al-controls')) alUpdateControls(); }
function alToggle() { astarLab.timer ? alPause() : alPlay(); }

/* ---------- rendering ---------- */
function astarLabPage() {
  if (!astarLab.graph || (!astarLab.trace && !astarLab.error)) {
    setTimeout(alEnsure, 0);
    return `<section class="astar-lab"><div class="al-loading" role="status">Loading the aisle graph and search trace…</div></section>`;
  }
  const c = astarLab.config, t = astarLab.trace;
  return `<section class="astar-lab" aria-label="A* search lab">
  <header class="al-head"><div><div class="eyebrow">Interactive simulation · ${astarLab.graph.floorCount} floors · ${num(astarLab.graph.edges.length)} edges</div><h1>A* search lab</h1><p>Replay every expansion of the real search. Each step pops the lowest f(n) = g(n) + h(n) from the open list, closes that node and relaxes its neighbours.</p></div></header>
  <form class="al-setup panel" data-form="astar-lab">
    <label class="field">Destination<select id="al-destination" name="destination">${destinationsOptions(c.destination)}</select></label>
    <label class="field">Route leg<select id="al-leg" name="leg"><option value="driving" ${c.leg === 'driving' ? 'selected' : ''}>Drive · entrance → bay</option><option value="walking" ${c.leg === 'walking' ? 'selected' : ''}>Walk · bay → destination</option></select></label>
    <label class="field">Algorithm<select id="al-mode" name="mode"><option value="astar" ${c.mode === 'astar' ? 'selected' : ''}>A* · Manhattan + ramp heuristic</option><option value="dijkstra" ${c.mode === 'dijkstra' ? 'selected' : ''}>Dijkstra · h(n) = 0</option></select></label>
    <label class="field">Target bay<input id="al-slot" name="slot" placeholder="Recommended" value="${esc(c.slot)}" maxlength="8" autocomplete="off" spellcheck="false"></label>
    <button type="submit" class="btn" ${astarLab.loading ? 'disabled' : ''}>${alIcon('play')}${astarLab.loading ? 'Building…' : 'Build search'}</button>
  </form>
  ${astarLab.error && !t ? `<div class="notice warning">${esc(astarLab.error)}</div>` : ''}
  ${t ? alWorkspace() : ''}
  </section>`;
}
function alWorkspace() {
  const t = astarLab.trace;
  return `<div class="al-route-line"><span class="al-pill start">S</span><span>${esc(alNodeName(t.start))}</span><span class="al-arrow">→</span><span class="al-pill goal">G</span><span>${esc(alNodeName(t.goal))}</span><span class="chip ${t.recommended ? '' : 'gray'}">${t.recommended ? 'Recommended bay ' + esc(t.slot) : 'Chosen bay ' + esc(t.slot)}</span><span class="chip gray">${t.mode === 'astar' ? 'A*' : 'Dijkstra'}</span></div>
  ${alControls()}
  <div class="al-grid">
    <section class="panel al-stage">
      <div class="al-floors" id="al-floors">${alFloorStrip()}</div>
      <div class="al-canvas" id="al-canvas">${alSvg()}</div>
      <div class="al-legend">${alLegend()}</div>
      <div class="al-toggles">
        ${alToggle_('al-follow', 'Follow the search across floors', astarLab.follow)}
        ${alToggle_('al-pause-floor', 'Pause on floor change', astarLab.pauseOnFloor)}
        ${alToggle_('al-tree', 'Show search tree', astarLab.tree)}
        ${alToggle_('al-heuristic', 'Show h(n) guide', astarLab.heuristic)}
        ${alToggle_('al-labels', 'Label open nodes with f(n)', astarLab.labels)}
      </div>
    </section>
    <aside class="al-side">
      <section class="panel"><div class="al-card-head"><h3>Current expansion</h3><span id="al-step-chip" class="chip"></span></div><div class="al-card-body" id="al-current"></div></section>
      <section class="panel"><div class="al-card-head"><h3>Open list · priority queue</h3><span id="al-open-chip" class="chip amber"></span></div><div class="al-card-body" id="al-open"></div></section>
      <section class="panel"><div class="al-card-head"><h3>Search progress</h3><span class="chip gray">click to seek</span></div><div class="al-card-body" id="al-chart"></div></section>
      <section class="panel" id="al-inspector-panel"><div class="al-card-head"><h3>Node inspector</h3><span class="chip gray">click any node</span></div><div class="al-card-body" id="al-inspector"></div></section>
      <section class="panel"><div class="al-card-head"><h3>Result</h3></div><div class="al-card-body" id="al-result"></div></section>
    </aside>
  </div>`;
}
const alToggle_ = (id, label, on) => `<label class="al-switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span>${label}</label>`;
function alControls() {
  const last = alLastStep();
  return `<div class="al-controls panel" id="al-controls">
    <div class="al-buttons" role="group" aria-label="Playback">
      <button type="button" class="al-btn" data-action="al-first" title="Restart (Home)" aria-label="Restart">${alIcon('first')}</button>
      <button type="button" class="al-btn" data-action="al-prev" title="Step back (←, Shift+← for 10)" aria-label="Step back">${alIcon('prev')}</button>
      <button type="button" class="al-btn primary" id="al-play" data-action="al-play" title="Play / pause (Space)" aria-label="Play">${alIcon('play')}</button>
      <button type="button" class="al-btn" data-action="al-next" title="Step forward (→, Shift+→ for 10)" aria-label="Step forward">${alIcon('next')}</button>
      <button type="button" class="al-btn" data-action="al-last" title="Jump to goal (End)" aria-label="Jump to goal">${alIcon('last')}</button>
    </div>
    <div class="al-scrub"><input type="range" id="al-scrub" min="-1" max="${last}" step="1" value="${astarLab.step}" aria-label="Search step"><div class="al-marks" id="al-floor-marks" aria-hidden="true">${alFloorMarks()}</div><div class="al-scrub-meta"><span id="al-step-text"></span><span>Ticks: first node on each floor</span></div></div>
    <label class="field al-speed">Speed<select id="al-speed">${AL_SPEEDS.map(s => `<option value="${s}" ${s === astarLab.speed ? 'selected' : ''}>${s} steps/s</option>`).join('')}</select></label>
  </div>`;
}
/* Ticks on the scrubber where the search first reaches each floor. */
function alFloorMarks() {
  const t = astarLab.trace, last = alLastStep(); if (!t || last < 1) return '';
  const seen = new Set([t.start[0]]), marks = [];
  let labelled = -100;
  t.steps.forEach((s, i) => {
    if (seen.has(s.node[0])) return;
    seen.add(s.node[0]);
    const left = ((i + 1) / (last + 1)) * 100, room = left - labelled >= 5;
    if (room) labelled = left;
    marks.push(`<i style="left:${left}%" title="Step ${i + 1}: first node on floor ${state.floors[s.node[0]].name}">${room ? `<b>${state.floors[s.node[0]].name}</b>` : ''}</i>`);
  });
  return marks.join('');
}
function alFloorStrip() {
  const t = astarLab.trace, m = astarLab.model, step = astarLab.step;
  const counts = new Array(astarLab.graph.floorCount).fill(0);
  for (let i = 0; i <= step; i++) counts[t.steps[i].node[0]]++;
  const max = Math.max(1, ...counts), cur = t.steps[step]?.node[0] ?? t.start[0];
  return `<span class="label">Floor</span><div class="al-floor-tabs">${counts.map((n, f) => `<button type="button" data-action="al-floor" data-floor="${f}" class="${f === astarLab.floor ? 'active' : ''} ${f === cur ? 'searching' : ''}" aria-pressed="${f === astarLab.floor}" aria-label="Floor ${state.floors[f].name}, ${n} nodes closed"><b>${state.floors[f].name}${f === t.start[0] ? '<em class="s">S</em>' : ''}${f === t.goal[0] ? '<em class="g">G</em>' : ''}</b><i style="height:${(n / max) * 100}%"></i><small>${n}</small></button>`).join('')}</div>`;
}
function alLegend() {
  return [['closed', 'Closed (expanded)'], ['open', 'Open (frontier)'], ['next', 'Next to pop'], ['current', 'Current node'], ['relax', 'Relaxed edge'], ['tree', 'Search tree'], ['path', 'Best path']].map(([c, l]) => `<span><i class="lg-${c}"></i>${l}</span>`).join('');
}
function alSvg() {
  return `<svg viewBox="0 0 ${AL_W} ${AL_H}" role="img" aria-label="Aisle graph for the selected floor with search state"><g id="al-static">${alStaticLayer()}</g><g id="al-dynamic">${alDynamicLayer()}</g></svg>`;
}
function alStaticLayer() {
  const g = astarLab.graph, f = astarLab.floor, nodes = g.floors.get(f) || new Map();
  astarLab.renderedFloor = f;
  const edges = (g.local.get(f) || []).map(([a, b]) => `<line class="al-edge" x1="${alSx(a[1])}" y1="${alSy(a[2])}" x2="${alSx(b[1])}" y2="${alSy(b[2])}"/>`).join('');
  const bw = Math.min(30, 928 / (g.columns + 1) - 8);
  let bays = '', points = '';
  nodes.forEach((n, k) => {
    const x = alSx(n[1]), y = alSy(n[2]), slot = g.slots.get(k), mark = g.landmarks.get(k);
    if (slot) bays += `<rect class="al-bay ${slot.status}" x="${x - bw / 2}" y="${y - 19}" width="${bw}" height="38" rx="4"/><text class="al-bay-label" x="${x}" y="${y + (n[2] < 5 ? -23 : 31)}">${String(slot.index + 1).padStart(2, '0')}</text>`;
    if (mark) points += `<text class="al-landmark" x="${x}" y="${y - 12}" text-anchor="${n[1] ? 'end' : 'start'}" dx="${n[1] ? -6 : 6}">${esc(mark)}</text>`;
    points += `<g class="al-node-hit" data-action="al-node" data-key="${k}" role="button" tabindex="-1" aria-label="${esc(alNodeName(n))}"><circle cx="${x}" cy="${y}" r="9" fill="transparent"/><circle class="al-node${slot ? ' bay' : ''}" cx="${x}" cy="${y}" r="${slot ? 3 : 3.2}"/><title>${esc(alNodeName(n))} · (${n.join(', ')})</title></g>`;
  });
  const ramp = nodes.get(alKey([f, 0, 4]));
  const rampMark = ramp && g.floorCount > 1 ? `<text class="al-ramp" x="${alSx(0) + 6}" y="${alSy(4) + 22}">ramp ↕ 200 m</text>` : '';
  return `<rect class="al-floor-bg" x="14" y="18" width="${AL_W - 28}" height="${AL_H - 34}" rx="12"/>${bays}${edges}${rampMark}${points}`;
}
function alDynamicLayer() {
  const t = astarLab.trace, m = astarLab.model, g = astarLab.graph, f = astarLab.floor, step = astarLab.step;
  const nodes = g.floors.get(f) || new Map(), cur = t.steps[step], finished = step === alLastStep();
  const open = alOpenList(step), next = finished ? null : open[0];
  let tree = '', closed = '', openMarks = '', labels = '';
  nodes.forEach((n, k) => {
    const s = alNodeState(k, step); if (!s || s.status === 'unseen') return;
    const x = alSx(n[1]), y = alSy(n[2]);
    if (s.status === 'closed') {
      const age = step > 0 ? s.closedAt / step : 1;
      closed += `<circle class="al-closed" cx="${x}" cy="${y}" r="5.2" style="fill:hsl(166 ${38 + age * 25}% ${74 - age * 40}%)"/>`;
      if (astarLab.tree && s.parent && s.parent[0] === f) tree += `<line class="al-tree" x1="${alSx(s.parent[1])}" y1="${alSy(s.parent[2])}" x2="${x}" y2="${y}"/>`;
    } else {
      openMarks += `<circle class="al-open" cx="${x}" cy="${y}" r="6"/>`;
      if (astarLab.labels) labels += `<text class="al-f" x="${x}" y="${y - 9}">${s.f}</text>`;
    }
  });
  const on = n => n && n[0] === f;
  let relax = '', path = '', heur = '', marks = '';
  if (cur && on(cur.node)) {
    relax = cur.relaxed.filter(r => on(r.node)).map(r => `<line class="al-relax" x1="${alSx(cur.node[1])}" y1="${alSy(cur.node[2])}" x2="${alSx(r.node[1])}" y2="${alSy(r.node[2])}"/>`).join('');
  }
  const chain = finished ? t.path : cur ? alParentChain(cur.node, step) : [t.start];
  const segs = []; let run = [];
  chain.forEach(n => { if (on(n)) run.push(n); else if (run.length) { segs.push(run); run = []; } });
  if (run.length) segs.push(run);
  path = segs.filter(s => s.length > 1).map(s => `<path class="al-path ${finished ? 'final' : ''}" d="${s.map((n, i) => `${i ? 'L' : 'M'}${alSx(n[1])},${alSy(n[2])}`).join(' ')}"/>`).join('');
  const focus = cur?.node || t.start;
  if (astarLab.heuristic && t.mode === 'astar' && on(focus) && !finished) {
    const goalSameFloor = t.goal[0] === f;
    const tx = goalSameFloor ? t.goal : [f, 0, 4];
    heur = `<path class="al-heur" d="M${alSx(focus[1])},${alSy(focus[2])} L${alSx(tx[1])},${alSy(focus[2])} L${alSx(tx[1])},${alSy(tx[2])}"/><text class="al-heur-label" x="${alSx(focus[1]) + (focus[1] > astarLab.graph.columns / 2 ? -12 : 12)}" y="${alSy(focus[2]) - 12}" text-anchor="${focus[1] > astarLab.graph.columns / 2 ? 'end' : 'start'}">h = ${alHeuristic(focus, t.goal)}${goalSameFloor ? '' : ' · goal on ' + state.floors[t.goal[0]].name}</text>`;
  }
  if (next && on(next.node)) marks += `<circle class="al-next" cx="${alSx(next.node[1])}" cy="${alSy(next.node[2])}" r="10"/>`;
  if (cur && on(cur.node)) marks += `<circle class="al-current-pulse" cx="${alSx(cur.node[1])}" cy="${alSy(cur.node[2])}" r="9"/><circle class="al-current" cx="${alSx(cur.node[1])}" cy="${alSy(cur.node[2])}" r="7"/>`;
  const pin = (n, cls, txt) => on(n) ? `<g class="al-pin ${cls}" transform="translate(${alSx(n[1])},${alSy(n[2])})"><path d="M0 -6 C-9 -14 -9 -28 0 -28 C9 -28 9 -14 0 -6Z"/><text y="-17">${txt}</text></g>` : '';
  if (astarLab.selected) { const n = astarLab.selected.split(',').map(Number); if (on(n)) marks += `<circle class="al-selected" cx="${alSx(n[1])}" cy="${alSy(n[2])}" r="12"/>`; }
  return `${tree}${path}${heur}${closed}${openMarks}${relax}${marks}${labels}${pin(t.start, 'start', 'S')}${pin(t.goal, 'goal', 'G')}`;
}
function alCurrentCard() {
  const t = astarLab.trace, step = astarLab.step, s = t.steps[step];
  if (!s) return `<p class="al-explain">Initialise: g(start) = 0, push <strong>${esc(alNodeName(t.start))}</strong> with f = h = ${alHeuristic(t.start, t.goal)}. Press play or → to pop the first node.</p>`;
  const rows = s.relaxed.map(r => `<tr><td>${esc(alNodeName(r.node))}</td><td class="n">${s.g} + ${r.weight}</td><td class="n">${r.g}</td><td class="n">${r.h}</td><td class="n"><strong>${r.g + r.h}</strong></td></tr>`).join('');
  const isGoal = step === alLastStep();
  return `<div class="al-node-title">${esc(alNodeName(s.node))}<small>(${s.node.join(', ')})</small></div>
  <div class="al-fgh"><div><span>g(n)</span><strong>${s.g}</strong><small>cost so far</small></div><div class="plus">+</div><div><span>h(n)</span><strong>${s.h}</strong><small>${t.mode === 'astar' ? 'estimate to goal' : 'Dijkstra: 0'}</small></div><div class="plus">=</div><div class="f"><span>f(n)</span><strong>${s.f}</strong><small>priority</small></div></div>
  <p class="al-explain">${isGoal ? `<strong>Goal popped.</strong> The search stops; following parent pointers gives the ${t.distance} m path.` : `Popped from the open list${s.parent ? ` via ${esc(alNodeName(s.parent))}` : ''}. ${s.relaxed.length ? `${s.relaxed.length} neighbour${s.relaxed.length > 1 ? 's' : ''} improved:` : 'No neighbour improved (all already reached as cheaply).'}`}${s.stale && (step === 0 || s.stale !== t.steps[step - 1].stale) ? ` <span class="al-stale">Skipped ${s.stale - (t.steps[step - 1]?.stale || 0)} stale heap entr${s.stale - (t.steps[step - 1]?.stale || 0) > 1 ? 'ies' : 'y'} (lazy deletion).</span>` : ''}</p>
  ${rows ? `<div class="al-table-wrap"><table class="al-table"><thead><tr><th>Neighbour</th><th>g + w</th><th>g</th><th>h</th><th>f</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;
}
function alOpenCard(open) {
  const finished = astarLab.step === alLastStep();
  if (!open.length) return '<p class="al-explain">The open list is empty.</p>';
  return `<ol class="al-open-list">${open.slice(0, 8).map((o, i) => `<li class="${i === 0 && !finished ? 'top' : ''}" data-action="al-node" data-key="${o.key}"><span class="rank">${i + 1}</span><span class="name">${esc(alNodeName(o.node))}</span><span class="fv"><small>${o.g}+${o.h}=</small>${o.f}</span></li>`).join('')}</ol>${open.length > 8 ? `<p class="al-more">+ ${num(open.length - 8)} more in the heap</p>` : ''}<p class="al-hint">${finished ? 'Remaining entries are never popped: the goal was reached first.' : 'Ties on f are broken by insertion order, exactly like the heap sequence counter.'}</p>`;
}
function alChart() {
  const t = astarLab.trace, m = astarLab.model, n = t.steps.length, W = 320, H = 110, P = 6;
  if (!n) return '';
  const x = i => P + (i / Math.max(1, n - 1)) * (W - 2 * P), yF = v => H - P - (v / m.fMax) * (H - 2 * P - 12), yO = v => H - P - (v / m.openMax) * (H - 2 * P - 12);
  const fLine = t.steps.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yF(s.f).toFixed(1)}`).join('');
  const oArea = `M${x(0)},${H - P}` + m.openSizes.map((v, i) => `L${x(i).toFixed(1)},${yO(v).toFixed(1)}`).join('') + `L${x(n - 1)},${H - P}Z`;
  const cx = astarLab.step < 0 ? P : x(astarLab.step);
  const s = t.steps[astarLab.step];
  return `<svg class="al-chart" id="al-chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="f value and open list size across the search"><path class="al-chart-open" d="${oArea}"/><path class="al-chart-f" d="${fLine}"/><line class="al-chart-cursor" x1="${cx}" x2="${cx}" y1="4" y2="${H - P}"/><text x="${P}" y="11" class="al-chart-key f">f(n) of popped node · max ${m.fMax}</text><text x="${W - P}" y="11" text-anchor="end" class="al-chart-key o">open size · max ${m.openMax}</text></svg>
  <div class="al-stats"><div><span>Closed</span><strong>${num(astarLab.step + 1)}</strong></div><div><span>Open</span><strong>${num(astarLab.step < 0 ? 1 : m.openSizes[astarLab.step])}</strong></div><div><span>Stale pops</span><strong>${num(s?.stale || 0)}</strong></div><div><span>Done</span><strong>${Math.round(((astarLab.step + 1) / n) * 100)}%</strong></div></div>
  <p class="al-hint">${t.mode === 'astar' ? 'With a consistent heuristic the popped f(n) never decreases.' : 'With h = 0, f equals g: nodes leave the queue in order of distance.'}</p>`;
}
function alInspector() {
  if (!astarLab.selected) return '<p class="al-explain">Select a node on the map or in the open list to see its g, h and f at the current step.</p>';
  const k = astarLab.selected, n = k.split(',').map(Number), s = alNodeState(k), t = astarLab.trace;
  const h = alHeuristic(n, t.goal), closedAt = astarLab.model.closedAt.get(k);
  const status = s.status === 'unseen' ? 'Not yet discovered' : s.status === 'closed' ? `Closed at step ${s.closedAt + 1}` : 'In the open list';
  return `<div class="al-node-title">${esc(alNodeName(n))}<small>(${n.join(', ')})</small></div><dl class="al-dl"><div><dt>Status</dt><dd>${status}</dd></div><div><dt>g (best known)</dt><dd>${s.status === 'unseen' ? '∞' : s.g}</dd></div><div><dt>h</dt><dd>${h}</dd></div><div><dt>f</dt><dd>${s.status === 'unseen' ? '∞' : s.g + h}</dd></div><div><dt>Parent</dt><dd>${s.parent ? esc(alNodeName(s.parent)) : '—'}</dd></div><div><dt>On final path</dt><dd>${astarLab.model.path.has(k) ? 'Yes' : 'No'}</dd></div></dl><div class="result-actions">${closedAt !== undefined && closedAt > astarLab.step ? btn(`Run until expanded (step ${closedAt + 1})`, 'al-run-to', 'play', 'secondary small') : ''}${closedAt !== undefined ? btn('Jump to its expansion', 'al-jump-node', 'arrow', 'secondary small') : '<small class="muted">This node is never expanded in this search.</small>'}</div>`;
}
function alResultCard() {
  const t = astarLab.trace, sk = `${t.destination}|${t.leg}|${t.slot}`, sum = astarLab.summary[sk] || {};
  const other = t.mode === 'astar' ? 'dijkstra' : 'astar', name = m => m === 'astar' ? 'A*' : 'Dijkstra';
  const total = [...astarLab.graph.floors.values()].reduce((a, f) => a + f.size, 0);
  const cmp = sum.astar && sum.dijkstra ? `<div class="al-compare">${['astar', 'dijkstra'].map(m => `<div class="${m === t.mode ? 'active' : ''}"><span>${name(m)}</span><strong>${num(sum[m].expanded)}</strong><small>expanded · ${sum[m].distance} m</small><i style="width:${(sum[m].expanded / Math.max(sum.astar.expanded, sum.dijkstra.expanded)) * 100}%"></i></div>`).join('')}</div><p class="al-hint">${sum.astar.distance === sum.dijkstra.distance ? 'Same shortest distance' : 'Distances differ: check the heuristic'}; A* expanded ${(100 * (1 - sum.astar.expanded / sum.dijkstra.expanded)).toFixed(0)}% fewer nodes.</p>` : `<div class="result-actions">${btn(`Run ${name(other)} on the same route`, 'al-other', 'chart', 'secondary small')}</div>`;
  return `<dl class="al-dl"><div><dt>Path cost</dt><dd>${t.distance} m</dd></div><div><dt>Path length</dt><dd>${t.path.length} nodes</dd></div><div><dt>Expanded</dt><dd>${num(t.expanded)} of ${num(total)}</dd></div><div><dt>Floors on path</dt><dd>${[...new Set(t.path.map(n => state.floors[n[0]].name))].join(' → ')}</dd></div></dl>${cmp}`;
}
function alUpdateControls() {
  const t = astarLab.trace; if (!t) return;
  const play = document.getElementById('al-play');
  if (play) { play.innerHTML = alIcon(astarLab.timer ? 'pause' : 'play'); play.setAttribute('aria-label', astarLab.timer ? 'Pause' : 'Play'); play.classList.toggle('playing', !!astarLab.timer); }
  const scrub = document.getElementById('al-scrub'); if (scrub && Number(scrub.value) !== astarLab.step) scrub.value = astarLab.step;
  const txt = document.getElementById('al-step-text');
  if (txt) txt.textContent = astarLab.step < 0 ? `Start · 0 / ${t.steps.length} expansions` : `Step ${astarLab.step + 1} / ${t.steps.length}${astarLab.step === alLastStep() ? ' · goal reached' : ''}`;
}
function alUpdate() {
  if (!document.getElementById('al-canvas') || !astarLab.trace) return;
  if (astarLab.renderedFloor !== astarLab.floor) document.getElementById('al-static').innerHTML = alStaticLayer();
  document.getElementById('al-dynamic').innerHTML = alDynamicLayer();
  document.getElementById('al-floors').innerHTML = alFloorStrip();
  const open = alOpenList();
  document.getElementById('al-current').innerHTML = alCurrentCard();
  document.getElementById('al-open').innerHTML = alOpenCard(open);
  document.getElementById('al-open-chip').textContent = `${num(open.length)} nodes`;
  document.getElementById('al-step-chip').textContent = astarLab.step < 0 ? 'initial' : `step ${astarLab.step + 1}`;
  document.getElementById('al-chart').innerHTML = alChart();
  document.getElementById('al-inspector').innerHTML = alInspector();
  document.getElementById('al-result').innerHTML = alResultCard();
  alUpdateControls();
}
/* Called after every full render so the sidebar is filled from the same state. */
function alAfterRender() { if (page === 'algorithms' && algorithmTab === 'astar') alUpdate(); }

/* ---------- events ---------- */
async function handleAstarLabAction(el) {
  const a = el.dataset.action;
  if (a === 'algorithm-tab') { setAlgorithmTab(el.dataset.tab); render(); document.getElementById(`algo-tab-${algorithmTab}`)?.focus(); return true; }
  if (!a.startsWith('al-')) return false;
  const t = astarLab.trace;
  if (a === 'al-play') alToggle();
  else if (a === 'al-first') { alPause(); alGo(-1); }
  else if (a === 'al-prev') { alPause(); alGo(astarLab.step - 1); }
  else if (a === 'al-next') { alPause(); alGo(astarLab.step + 1); }
  else if (a === 'al-last') { alPause(); alGo(alLastStep()); if (t) { astarLab.floor = t.goal[0]; alUpdate(); } }
  else if (a === 'al-floor') { astarLab.floor = Number(el.dataset.floor); astarLab.follow = false; const f = document.getElementById('al-follow'); if (f) f.checked = false; alUpdate(); }
  else if (a === 'al-node') { astarLab.selected = el.dataset.key; alUpdate(); }
  else if (a === 'al-jump-node') { alPause(); alGo(astarLab.model.closedAt.get(astarLab.selected)); }
  else if (a === 'al-run-to') { astarLab.runTo = astarLab.model.closedAt.get(astarLab.selected); alPlay(); }
  else if (a === 'al-other') { astarLab.config.mode = astarLab.config.mode === 'astar' ? 'dijkstra' : 'astar'; const m = document.getElementById('al-mode'); if (m) m.value = astarLab.config.mode; await alBuild(); }
  return true;
}
function alSeekFromChart(event) {
  const svg = event.target.closest('#al-chart-svg'); if (!svg || !astarLab.trace) return false;
  const r = svg.getBoundingClientRect(), ratio = Math.max(0, Math.min(1, (event.clientX - r.left) / r.width));
  alPause(); alGo(Math.round(ratio * alLastStep())); return true;
}
document.addEventListener('click', event => { if (event.target.closest('#al-chart-svg')) alSeekFromChart(event); }, true);
document.addEventListener('input', event => { if (event.target.id === 'al-scrub') { alPause(); alGo(Number(event.target.value)); } });
document.addEventListener('change', event => {
  const el = event.target, id = el.id;
  if (id === 'al-speed') { astarLab.speed = Number(el.value); if (astarLab.timer) alPlay(); }
  else if (id === 'al-follow') { astarLab.follow = el.checked; if (el.checked) alGo(astarLab.step); }
  else if (id === 'al-pause-floor') astarLab.pauseOnFloor = el.checked;
  else if (id === 'al-labels') { astarLab.labels = el.checked; alUpdate(); }
  else if (id === 'al-heuristic') { astarLab.heuristic = el.checked; alUpdate(); }
  else if (id === 'al-tree') { astarLab.tree = el.checked; alUpdate(); }
  else if (['al-destination', 'al-leg', 'al-mode'].includes(id)) alReadConfig();
});
document.addEventListener('submit', event => { if (event.target.dataset.form === 'astar-lab') { event.preventDefault(); event.stopImmediatePropagation(); alBuild(); } }, true);
document.addEventListener('keydown', event => {
  if (page !== 'algorithms' || algorithmTab !== 'astar' || !astarLab.trace || $('.modal')) return;
  const tag = event.target.tagName;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) && event.target.id !== 'al-scrub') return;
  const jump = event.shiftKey ? 10 : 1;
  if (event.key === ' ' || event.key === 'k') { if (tag === 'BUTTON' && event.key === ' ') return; event.preventDefault(); alToggle(); }
  else if (event.key === 'ArrowRight' && event.target.id !== 'al-scrub') { event.preventDefault(); alPause(); alGo(astarLab.step + jump); }
  else if (event.key === 'ArrowLeft' && event.target.id !== 'al-scrub') { event.preventDefault(); alPause(); alGo(astarLab.step - jump); }
  else if (event.key === 'Home' && event.target.id !== 'al-scrub') { event.preventDefault(); alPause(); alGo(-1); }
  else if (event.key === 'End' && event.target.id !== 'al-scrub') { event.preventDefault(); alPause(); alGo(alLastStep()); }
});
