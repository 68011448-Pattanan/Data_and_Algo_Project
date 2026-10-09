/* Report text and exports share the same definitions and measured result snapshot. */
const reportAbstract =
  "This study examines the data structures and algorithms used in a mall parking management prototype with 1,100 bays distributed across 11 floors. A plate-indexed hash table supports vehicle retrieval, A* searches a weighted aisle graph, a FIFO queue orders waiting arrivals, and stable Merge Sort orders visit history. Equivalent-task benchmarks compare these implementations with explicit baselines. The analysis distinguishes asymptotic complexity, measured execution time, and operational correctness.";
const reportModel =
  "The parking layout is represented by an undirected graph G = (V, E) with non-negative edge weights. Vertices represent aisle intersections, ramps and parking bays; bays are leaf vertices so a route cannot pass through a parked vehicle. Horizontal and vertical coordinate steps cost 5 m, and adjacent-floor ramps cost 200 m. A bay is eligible only when open, unoccupied and reachable. Candidate selection minimizes walking distance to the selected destination, then driving distance from the entrance; bay index and floor break remaining ties.";
const reportMethod =
  "Each implementation receives equivalent input for its task. One untimed warm-up precedes 3-15 timed repetitions. Input preparation occurs before each timer; perf_counter_ns measures the operation, including Python call and result-list construction overhead. Work counts and correctness checks run outside the timed interval. The primary method is measured first, followed by its baseline; order is not randomized. Median is the primary summary, with mean and minimum-maximum reported as descriptive statistics. No confidence interval or significance test is estimated.";
const reportLimitations =
  "The experiments measure this Python implementation on one runtime environment and one seeded input distribution. OS scheduling, CPU load, cache state, garbage collection and fixed measurement order can influence the results. Nanosecond-valued clock readings do not establish nanosecond accuracy. Graph layout and edge costs are illustrative mall data. One search is timed; full bay recommendation, database transactions, networking and rendering are excluded. Repetitions are not independent deployment trials. These measurements do not establish universal algorithm superiority or production throughput.";
const reportAlgorithms = [
  {
    id: "hash",
    name: "Plate-indexed hash table",
    purpose: "Vehicle retrieval",
    description:
      "A normalized license plate is used as a key in a native Python dictionary. Lookup retrieves an active visit directly; confirmation updates its status, and exit or cancellation removes it from the active registry. This avoids scanning every active visit.",
    correctness:
      "Each normalized plate identifies at most one active visit. Dictionary access returns the same visit as the equivalent linear scan.",
    time: "Average O(1) lookup; worst case O(n)",
    space: "O(n) registry storage",
    baseline: "Linear search: O(n) lookup",
    source: "app/store.py: active, enter, find, confirm, exit",
    pseudocode:
      "FIND_VEHICLE(plate)\n  key ← NORMALIZE(plate)\n  if key ∉ active_registry\n    return NOT_FOUND\n  return active_registry[key]",
  },
  {
    id: "astar",
    name: "A* shortest-path search",
    purpose: "Weighted parking routes",
    description:
      "A min-heap orders candidate vertices by f(v) = g(v) + h(v). Cost relaxation records cheaper routes and a predecessor map reconstructs the path. Dijkstra is implemented by the same search with h(v) = 0 [1, 2].",
    correctness:
      "The configured heuristic is consistent: every edge costs at least the corresponding coordinate lower bound. Therefore h(v) does not overestimate remaining cost and goal removal yields a shortest route on this graph. Closing a bay excludes it from assignment; it does not model an aisle obstruction.",
    time: "O((V + E) log V) for one search on this graph",
    space: "O(V + E) auxiliary heap/map storage",
    baseline: "Dijkstra: O((V + E) log V)",
    source: "app/algorithms.py: astar, heuristic, dijkstra",
    pseudocode:
      "A_STAR(graph, start, goal)\n  g[start] ← 0; push(start, h(start))\n  while frontier is not empty\n    u ← POP_MIN(frontier)\n    skip stale entries\n    if u = goal: return RECONSTRUCT_PATH(u)\n    for each edge (u, v) with cost w\n      if g[u] + w < g[v]\n        g[v] ← g[u] + w; parent[v] ← u\n        PUSH(frontier, v, g[v] + h(v))\n  return NO_ROUTE",
  },
  {
    id: "queue",
    name: "FIFO waiting queue",
    purpose: "Arrival-order allocation",
    description:
      "An explicit FIFOQueue wraps collections.deque. New waiters join at the rear and bay release serves the front. End operations are approximately constant time in the underlying deque [3]. A priority queue would change the service policy rather than provide an equivalent FIFO baseline.",
    correctness:
      "Among eligible waiting visits, relative arrival order is preserved. Cancelling a middle waiter leaves the remaining order unchanged. Assignment occurs inside a serialized transaction.",
    time: "O(1) enqueue/dequeue/front; O(n) cancellation",
    space: "O(n) queue storage",
    baseline: "List pop(0): O(n) per removal, O(n²) to drain",
    source: "app/algorithms.py: FIFOQueue; app/store.py: _promote",
    pseudocode:
      "WAIT_FOR_BAY(visit)\n  queue.APPEND_REAR(visit)\n\nON_BAY_RELEASE(slot)\n  if queue is not empty and slot is eligible\n    visit ← queue.POP_FRONT()\n    ASSIGN_ATOMICALLY(visit, slot)",
  },
  {
    id: "merge",
    name: "Stable Merge Sort",
    purpose: "Chronological visit history",
    description:
      "The explicit recursive implementation divides history into two halves, sorts each half, and merges by full entry timestamp. Choosing the left item when keys are equal preserves input order. Insertion Sort is a stable quadratic baseline on the same records [5].",
    correctness:
      "The output is nondecreasing by full timestamp and retains the original relative order of equal keys. The algorithm returns a new list without modifying the input.",
    time: "O(n log n), all input orders",
    space: "O(n) auxiliary storage",
    baseline: "Insertion Sort: O(n²) average/worst, O(n) best",
    source: "app/algorithms.py: merge_sort, insertion_sort",
    pseudocode:
      "MERGE_SORT(records)\n  if LENGTH(records) < 2: return COPY(records)\n  mid ← FLOOR(LENGTH(records) / 2)\n  left ← MERGE_SORT(records[0:mid])\n  right ← MERGE_SORT(records[mid:end])\n  return MERGE(left, right)\n    // Compare full timestamps.\n    // On equal keys, choose the left record.",
  },
];
const reportReferences = [
  {
    label:
      "Hart, P. E., Nilsson, N. J., & Raphael, B. (1968). A formal basis for the heuristic determination of minimum cost paths. IEEE Transactions on Systems Science and Cybernetics, 4(2), 100-107.",
    url: "https://doi.org/10.1109/TSSC.1968.300136",
  },
  {
    label:
      "Dijkstra, E. W. (1959). A note on two problems in connexion with graphs. Numerische Mathematik, 1, 269-271.",
    url: "https://doi.org/10.1007/BF01386390",
  },
  {
    label:
      "Python Software Foundation. Python 3.11 documentation: collections - deque objects.",
    url: "https://docs.python.org/3.11/library/collections.html#collections.deque",
  },
  {
    label:
      "Python Software Foundation. Python 3.11 documentation: time - perf_counter_ns and get_clock_info.",
    url: "https://docs.python.org/3.11/library/time.html#time.perf_counter_ns",
  },
  {
    label:
      "MIT OpenCourseWare (2011). 6.006 Introduction to Algorithms, Lecture 03: Insertion sort, merge sort.",
    url: "https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-fall-2011/resources/mit6_006f11_lec03/",
  },
];
function reportSection(number, title, content, id = "") {
  return `<section class="report-section" ${id ? `id="${id}"` : ""}><h2><span>${number}</span>${title}</h2>${content}</section>`;
}
function academicAlgorithmPage() {
  return `<article class="algorithm-report" aria-label="Algorithm analysis report"><div class="report-toolbar" data-report-interactive><span>Academic report · Version 2</span><div>${btn("Print / save PDF", "report-print", "book", "secondary")}${btn("Export report (.md)", "report-markdown", "exit", "secondary")}${btn("Export results (.csv)", "report-csv", "chart", "secondary")}</div></div><header class="report-title"><p class="report-kicker">01416206 · Data Structures & Algorithms</p><h1>Algorithm Design and <br>Experimental Evaluation</h1><p class="report-subtitle">A multi-floor mall parking management system</p><div class="report-byline"><span>Group Understaffed</span><span>1,100 bays · 11 floors · 100 bays per floor</span></div></header><section class="report-abstract"><h2>Abstract</h2><p>${reportAbstract}</p><p class="report-keywords"><strong>Keywords:</strong> A* search; hash table; FIFO queue; stable sorting; empirical benchmarking.</p></section><nav class="report-contents" aria-label="Report sections" data-report-interactive>${[
    ["report-model", "01 Model"],
    ["report-design", "02 Algorithm design"],
    ["report-method", "03 Methodology"],
    ["report-results", "04 Results"],
    ["report-discussion", "05 Discussion"],
    ["report-references", "06 References"],
  ]
    .map(
      ([id, label]) =>
        `<a href="#${id}" data-action="report-section" data-section="${id}">${label}</a>`,
    )
    .join(
      "",
    )}</nav>${reportSection("01", "Problem formulation and system model", `<p>${reportModel}</p><div class="report-equations"><div><span>Search priority</span><code>f(v) = g(v) + h(v)</code><small>g(v): accumulated route cost; h(v): lower bound to the goal.</small></div><div><span>Configured heuristic (metres)</span><code>h(a,b) = 200|a.floor − b.floor| + 5(|a.x − b.x| + |a.y − b.y|)</code><small>Coordinate distances give a lower bound on aisle and ramp travel.</small></div></div><p class="report-note">Notation: n denotes records or waiters; V and E denote graph vertices and edges. Bay recommendation may evaluate multiple candidate routes, so the bound for one A* search is not the complexity of the entire assignment operation.</p>`, "report-model")}${reportSection("02", "Algorithm design and theoretical analysis", `<div class="report-table-wrap"><table class="report-table"><caption>Table 1. Implemented methods, operation costs and equivalent baselines.</caption><thead><tr><th>Method / task</th><th>Time complexity</th><th>Space complexity</th><th>Baseline</th></tr></thead><tbody>${reportAlgorithms.map((a) => `<tr><td><strong>${a.name}</strong><small>${a.purpose}</small></td><td>${a.time}</td><td>${a.space}</td><td>${a.baseline}</td></tr>`).join("")}</tbody></table></div><p class="report-note">Hash-table bounds assume ordinary key distribution and fixed-size plate keys; Python insertion/deletion involve amortized resizing costs. Search bounds apply to this finite weighted graph with a consistent heuristic. Merge Sort follows T(n) = 2T(n/2) + O(n).</p>${reportAlgorithms.map((a, i) => `<section class="report-algorithm"><div><h3>2.${i + 1} ${a.name}</h3><p>${a.description}</p><p><strong>Correctness condition.</strong> ${a.correctness}</p><p class="report-source">Implementation: <code>${a.source}</code></p></div><figure><figcaption>Algorithm ${i + 1}. ${a.name} - schematic pseudocode.</figcaption><pre><code>${esc(a.pseudocode)}</code></pre></figure></section>`).join("")}`, "report-design")}${reportSection("03", "Experimental methodology", `<p>${reportMethod} Timer behavior follows Python’s clock documentation [4].</p><div class="report-table-wrap"><table class="report-table"><caption>Table 2. Controlled workload and validation protocol.</caption><thead><tr><th>Task</th><th>Input held constant within a pair</th><th>Output criterion</th></tr></thead><tbody><tr><td>Routing</td><td>Same entrance, target bay, graph and edge weights</td><td>Equal shortest-path distance</td></tr><tr><td>Vehicle lookup</td><td>n seeded records; 100 identical queries (75 hits, 25 misses)</td><td>Identical returned visit IDs or absent results</td></tr><tr><td>Waiting queue</td><td>A fresh n-item queue per repetition; drain all items</td><td>Identical FIFO sequence</td></tr><tr><td>History sorting</td><td>Same n records with seeded, unordered full timestamp keys</td><td>Equal stable order; nondecreasing timestamps</td></tr></tbody></table></div><p class="report-note">Dataset seed: 206. Record count affects lookup, queue and sorting only; routing uses the fixed physical layout and current availability. Recommendation and all setup, validation, instrumentation, database work, network transfer and animation are excluded from timing. The selected method and baseline are compared only within the same task.</p><div class="report-equations"><div><span>Relative runtime</span><code>R = median(T_baseline) / median(T_primary)</code><small>R &gt; 1: lower primary runtime. R &lt; 1: lower baseline runtime.</small></div><div><span>Average time per operation</span><code>t_operation = median(T_batch) / operation_count</code><small>A derived batch average; individual operations are not timed separately.</small></div></div>`, "report-method")}${academicBenchmarkPanel()}${reportSection("05", "Discussion and limitations", reportDiscussion(), "report-discussion")}${reportSection("06", "References", `<ol class="report-references">${reportReferences.map((r, i) => `<li id="reference-${i + 1}"><span>[${i + 1}]</span><div>${esc(r.label)} <a href="${r.url}" target="_blank" rel="noopener noreferrer">${esc(r.url)}</a></div></li>`).join("")}</ol><p class="report-note">Pseudocode and implementation analysis describe this project. References provide theoretical and runtime context; local experimental results are generated by the parking engine.</p>`, "report-references")}<section class="report-section report-demonstrations" data-report-interactive><h2><span>A</span>Interactive demonstrations</h2><p class="report-note">Use these controls to inspect actual operations. They are supplementary demonstrations and are omitted from the printed report.</p>${academicDemonstrations()}</section><div class="report-end">Parkside · Algorithm analysis · End of report</div></article>`;
}
function academicBenchmarkPanel() {
  const b = benchmarkResults;
  return reportSection(
    "04",
    "Experimental results",
    `<div class="report-experiment" data-report-interactive><h3>Configure an experiment</h3><form class="benchmark-form" data-form="benchmark"><label class="field">Record count (n)<select id="benchmark-size" name="size">${[100, 500, 1100, 5000].map((n) => `<option value="${n}" ${n === benchmarkConfig.size ? "selected" : ""}>${num(n)}</option>`).join("")}</select></label><label class="field">Timed repetitions<select id="benchmark-repeats" name="repeats">${[3, 5, 7, 15].map((n) => `<option value="${n}" ${n === benchmarkConfig.repeats ? "selected" : ""}>${n}</option>`).join("")}</select></label><label class="field">Routing destination<select id="benchmark-destination" name="destination">${destinationsOptions(benchmarkConfig.destination)}</select></label>${btn(benchmarkRunning ? "Measuring…" : "Run experiment", "submit-benchmark", "play")}</form><p class="report-note">The report uses the completed experiment snapshot below. Changing these controls does not relabel previous results.</p></div>${benchmarkRunning ? '<p class="report-status" role="status">Warm-up and repeated measurements in progress. The previous completed experiment remains visible until a new result is received.</p>' : ""}${b ? reportMeasuredResults(b) : '<div class="report-pending"><strong>No empirical results recorded.</strong><p>Run an experiment to populate Tables 3-5, Figure 1, environment details and the observation paragraph. No example timings are substituted for measurements.</p></div>'}`,
    "report-results",
  );
}
function reportMeasuredResults(b) {
  const env = b.environment || {},
    g = b.graph || {};
  return `<dl class="report-run-meta"><div><dt>Recorded (UTC)</dt><dd>${esc(b.measured_at || "Not recorded")}</dd></div><div><dt>Dataset / repetitions</dt><dd>n = ${num(b.size)} · r = ${b.repeats} · seed = ${b.seed}</dd></div><div><dt>Runtime environment</dt><dd>${esc(env.implementation || "Python")} ${esc(env.python || "not recorded")} · ${esc(env.system || "not recorded")} ${esc(env.machine || "")} · ${env.logical_cpus ?? "Unknown"} visible logical CPUs</dd></div><div><dt>Clock / graph</dt><dd>${esc(env.timer || "perf_counter_ns")} · reported resolution ${env.clock_resolution_ns !== undefined ? Number(env.clock_resolution_ns).toPrecision(3) + " ns" : "not recorded"} · ${num(g.vertices)} vertices / ${num(g.undirected_edges)} edges</dd></div></dl><p class="report-note">Environment details are reported by the backend process; Docker may expose a Linux guest and CPU count that differs from the host. This records visible CPUs, not a controlled allocation or CPU model.</p><div class="report-table-wrap"><table class="report-table"><caption>Table 3. Median elapsed time per task workload (ms) and relative runtime.</caption><thead><tr><th>Task / methods</th><th>Primary median (ms)</th><th>Baseline median (ms)</th><th>R = baseline / primary</th><th>Validation</th></tr></thead><tbody>${b.pairs.map((p) => `<tr><td><strong>${esc(p.task)}</strong><small>${esc(p.primary.name)} / ${esc(p.baseline.name)}</small></td><td class="numeric">${reportMs(p.primary.median_ms)}</td><td class="numeric">${reportMs(p.baseline.median_ms)}</td><td class="numeric">${p.speedup === null ? "Undefined" : p.speedup.toFixed(3)}</td><td>${p.verified ? "Matched" : "Mismatch"}</td></tr>`).join("")}</tbody></table></div><p class="report-note">Times are for one route search, a 100-query lookup batch, draining n queue items, or sorting n records. Six decimal places are a display convention, not a claim of measurement accuracy.</p><figure class="report-runtime-figure">${reportRuntimeFigure(b)}<figcaption>Figure 1. Median runtime by method. Each task panel uses its own linear scale starting at zero; bar lengths cannot be compared across panels. Values are milliseconds.</figcaption></figure><div class="report-table-wrap"><table class="report-table"><caption>Table 4. Descriptive timing statistics and derived per-operation averages (ms).</caption><thead><tr><th>Task / method</th><th>Mean</th><th>Minimum</th><th>Maximum</th><th>Operations / run</th><th>Median / operation</th></tr></thead><tbody>${b.pairs.flatMap((p) => [p.primary, p.baseline].map((m) => `<tr><td><strong>${esc(m.name)}</strong><small>${esc(p.task)}</small></td><td class="numeric">${reportMs(m.mean_ms)}</td><td class="numeric">${reportMs(m.min_ms)}</td><td class="numeric">${reportMs(m.max_ms)}</td><td class="numeric">${num(m.operation_count)}</td><td class="numeric">${reportMs(m.per_operation_ms)}</td></tr>`)).join("")}</tbody></table></div><div class="report-table-wrap"><table class="report-table"><caption>Table 5. Work counts obtained separately from runtime measurement.</caption><thead><tr><th>Task</th><th>Primary work</th><th>Baseline work</th></tr></thead><tbody>${b.pairs.map((p) => `<tr><td>${esc(p.task)}</td><td>${num(p.primary.work)} ${esc(p.primary.work_label)}</td><td>${num(p.baseline.work)} ${esc(p.baseline.work_label)}</td></tr>`).join("")}</tbody></table></div><p class="report-note">Queue reference shifts are theoretical: n(n − 1)/2 for a complete list-front drain. Dictionary lookups count calls, not collision probes. Routing counts expanded vertices; sorting counts key comparisons. Counts of different operations are not a shared unit of work.</p><p class="report-route-note">Routing snapshot: entrance (${(g.start || []).join(", ")}) → bay ${esc(b.pairs[0].slot)}, distance ${b.pairs[0].distance} m. ${b.pairs[0].assignment_available ? "Target selected from current eligible bays." : "No assignable bay was available; this comparison routes to a physical bay without assigning it."}</p><details class="report-samples"><summary>Inspect raw measurements (ms)</summary><div class="report-table-wrap"><table class="report-table"><caption>Appendix data. Individual timed samples; the warm-up is excluded.</caption><thead><tr><th>Method</th><th>Samples (ms)</th></tr></thead><tbody>${b.pairs.flatMap((p) => [p.primary, p.baseline].map((m) => `<tr><td>${esc(m.name)}</td><td>${m.samples_ms.map(reportMs).join(", ")}</td></tr>`)).join("")}</tbody></table></div></details>`;
}
function reportMs(value) {
  return Number(value).toFixed(6);
}
function reportRuntimeFigure(b) {
  return `<svg viewBox="0 0 760 340" role="img" aria-label="Four independently scaled panels comparing median runtime in milliseconds"><title>Median runtime for equivalent tasks</title>${b.pairs
    .map((p, i) => {
      const x = 22 + (i % 2) * 382,
        y = 20 + Math.floor(i / 2) * 170,
        max = Math.max(
          p.primary.median_ms,
          p.baseline.median_ms,
          Number.EPSILON,
        ),
        w = 325;
      return `<g transform="translate(${x} ${y})"><text class="figure-task" x="0" y="12">${esc(p.task)}</text>${[p.primary, p.baseline].map((m, j) => `<text class="figure-label" x="0" y="${37 + j * 49}">${esc(m.name)}</text><text class="figure-value" x="${w}" y="${37 + j * 49}" text-anchor="end">${reportMs(m.median_ms)}</text><rect x="0" y="${44 + j * 49}" width="${w}" height="13" fill="#edf0f2"/><rect x="0" y="${44 + j * 49}" width="${(m.median_ms / max) * w}" height="13" fill="${j ? "#9caeb8" : "#254b62"}"/>`).join("")}<text class="figure-axis" x="0" y="131">0</text><text class="figure-axis" x="${w}" y="131" text-anchor="end">${reportMs(max)} ms</text></g>`;
    })
    .join("")}</svg>`;
}
function reportObservations() {
  if (!benchmarkResults)
    return "No measured result is available. The complexity analysis describes expected growth; an empirical conclusion requires a completed experiment.";
  return benchmarkResults.pairs
    .map((p) => {
      if (!p.verified)
        return `${p.task}: outputs did not match; this pair cannot support a performance conclusion.`;
      const a = p.primary,
        b = p.baseline,
        ratio = p.speedup;
      if (ratio === null)
        return `${p.task}: a relative runtime could not be calculated.`;
      const lower = ratio >= 1 ? a : b,
        higher = ratio >= 1 ? b : a;
      return `${p.task}: ${lower.name} had the lower median (${reportMs(lower.median_ms)} ms versus ${reportMs(higher.median_ms)} ms), a ${(ratio >= 1 ? ratio : 1 / ratio).toFixed(3)}× runtime ratio in this experiment. Outputs matched the task-specific validation criterion.`;
    })
    .join(" ");
}
function reportDiscussion() {
  return `<p><strong>Observed result.</strong> ${esc(reportObservations())}</p><p><strong>Interpretation.</strong> Dictionary lookup avoids a full record scan; deque removes from the front without shifting a list; Merge Sort has a lower asymptotic growth rate than quadratic sorting on large unordered inputs. A* and Dijkstra share the search structure, while the heuristic can reduce explored vertices. These theoretical differences motivate the comparisons but do not prescribe the measured winner for every input size. Constant factors can dominate small workloads.</p><p><strong>Threats to validity.</strong> ${reportLimitations}</p><p><strong>Further evaluation.</strong> Repeat experiments at multiple input sizes and graph destinations; record hardware and runtime versions; test sorted, reversed and duplicate-heavy histories; alternate measurement order; and use a separate study for full request latency and multi-user throughput. Operational correctness scenarios are available under Simulation control.</p>`;
}
function academicDemonstrations() {
  return `<div class="report-demo-grid"><section class="panel"><div class="panel-head"><h3>Plate dictionary</h3></div><div class="panel-body"><div class="codebox">${
    state.vehicles
      .slice(0, 4)
      .map(
        (v) =>
          `${esc(v.plate)} → ${esc(v.slot || "waiting")} (${esc(v.status)})`,
      )
      .join("<br>") || "Registry is empty"
  }</div><div class="result-actions">${btn("Insert visit", "arrival", "plus", "secondary small")}${btn("Search plate", "nav", "search", "secondary small", 'data-page="find"')}${btn("Update / remove", "nav", "people", "secondary small", 'data-page="vehicles"')}</div></div></section><section class="panel"><div class="panel-head"><h3>FIFO service order</h3></div><div class="panel-body"><div class="codebox">FRONT → ${
    state.queue
      .slice(0, 4)
      .map((v) => esc(v.plate))
      .join(" → ") || "empty"
  } → REAR<br>front(): ${esc(state.queue[0]?.plate || "null")}<br>is_empty(): ${state.waiting_count === 0}</div><div class="result-actions">${btn("Enqueue demo vehicles", "simulate", "plus", "secondary small", 'data-sim="queue"')}${btn("Release bay / dequeue", "simulate", "exit", "secondary small", 'data-sim="exit"')}</div></div></section><section class="panel"><div class="panel-head"><h3>A* route inspection</h3></div><div class="panel-body"><label class="field">Destination<select id="lab-destination">${destinationsOptions(draft.destination)}</select></label><div class="result-actions">${btn("Run recommendation", "run-astar", "play", "secondary small")}${btn("Animate search", "animate-astar", "play", "small")}${btn("Compare A* vs Dijkstra", "compare", "chart", "secondary small")}</div><div id="astar-metrics">${astarMetrics()}</div><div id="compare-output" style="display:none"></div></div></section><section class="panel merge-panel"><div class="panel-head"><h3>Merge Sort tree</h3></div><div class="panel-body"><div id="merge-trace">${mergeTreeView()}</div>${btn("Animate Merge Sort", "animate-merge", "play", "secondary small")}</div></section></div>${mapPanel("Route and expanded-vertex visualization", false)}`;
}
function downloadReportFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function reportFileStem() {
  return (
    "Parkside-algorithm-report" +
    (benchmarkResults
      ? "-" + benchmarkResults.measured_at.replace(/[:.]/g, "-")
      : "")
  );
}
function reportMarkdown() {
  const b = benchmarkResults;
  let text = `# Algorithm Design and Experimental Evaluation\n\nA multi-floor mall parking management system\n\n01416206 Data Structures & Algorithms | Group Understaffed | Version 2\n\n## Abstract\n\n${reportAbstract}\n\n## 1. Problem formulation\n\n${reportModel}\n\nf(v) = g(v) + h(v)\n\nh(a,b) = 200|a.floor - b.floor| + 5(|a.x - b.x| + |a.y - b.y|)\n\nNotation: n = records/waiters; V = vertices; E = edges. One-search bounds exclude candidate recommendation.\n\n## 2. Algorithm design\n\n`;
  text +=
    "Table 1. Implemented methods and theoretical costs.\n\n| Method | Time complexity | Space | Equivalent baseline |\n| --- | --- | --- | --- |\n";
  reportAlgorithms.forEach(
    (a) => (text += `| ${a.name} | ${a.time} | ${a.space} | ${a.baseline} |\n`),
  );
  text += "\n";
  reportAlgorithms.forEach(
    (a, i) =>
      (text += `### 2.${i + 1} ${a.name}\n\n${a.description}\n\nCorrectness: ${a.correctness}\n\nTime: ${a.time}. Space: ${a.space}. Baseline: ${a.baseline}.\n\nImplementation: ${a.source}.\n\n\`\`\`text\n${a.pseudocode}\n\`\`\`\n\n`),
  );
  text += `## 3. Experimental methodology\n\n${reportMethod}\n\nSeed 206; same 100 lookup queries (75 hits, 25 misses); drain fresh n-item FIFO queues; sort identical seeded full-timestamp records stably; route from the same entrance to the same target on the fixed graph.\n\nSetup, bay recommendation, instrumentation, validation, database, network and animation are excluded. The timer includes Python call and result construction overhead.\n\nRelative runtime R = median(T_baseline) / median(T_primary). Per-operation time = median batch time / operation count.\n\nTable 2. Controlled workload and validation.\n\n| Task | Controlled input | Output criterion |\n| --- | --- | --- |\n| Routing | Same entrance, target and weighted graph | Equal shortest distance |\n| Lookup | Same 100 queries (75 hits, 25 misses) | Equal IDs/absent results |\n| Queue | Fresh n-item queue, drained completely | Equal FIFO sequence |\n| Sorting | Same seeded full timestamp records | Equal stable sorted order |\n\n## 4. Experimental results\n\n`;
  if (b) {
    text += `Recorded UTC: ${b.measured_at}. n = ${b.size}; repetitions = ${b.repeats}; seed = ${b.seed}; capacity = ${b.capacity}; floors = ${b.floors}.\n\nEnvironment: ${JSON.stringify(b.environment)}\n\nGraph: ${JSON.stringify(b.graph)}\n\nTable 3. Median runtime per task workload (ms).\n\n| Task | Primary | Median (ms) | Baseline | Median (ms) | R | Validation |\n| --- | --- | ---: | --- | ---: | ---: | --- |\n`;
    b.pairs.forEach(
      (p) =>
        (text += `| ${p.task} | ${p.primary.name} | ${reportMs(p.primary.median_ms)} | ${p.baseline.name} | ${reportMs(p.baseline.median_ms)} | ${p.speedup?.toFixed(3) ?? "undefined"} | ${p.verified ? "Matched" : "Mismatch"} |\n`),
    );
    text +=
      "\nTable 4. Descriptive timing statistics and derived per-operation averages (ms).\n\n| Task / method | Mean | Minimum | Maximum | Operations / run | Median / operation |\n| --- | ---: | ---: | ---: | ---: | ---: |\n";
    b.pairs.forEach((p) =>
      [p.primary, p.baseline].forEach(
        (m) =>
          (text += `| ${p.task} / ${m.name} | ${reportMs(m.mean_ms)} | ${reportMs(m.min_ms)} | ${reportMs(m.max_ms)} | ${m.operation_count} | ${reportMs(m.per_operation_ms)} |\n`),
      ),
    );
    text +=
      "\nTable 5. Work counts obtained separately from runtime measurement.\n\n| Task | Primary work | Baseline work |\n| --- | --- | --- |\n";
    b.pairs.forEach(
      (p) =>
        (text += `| ${p.task} | ${p.primary.work} ${p.primary.work_label} | ${p.baseline.work} ${p.baseline.work_label} |\n`),
    );
    text +=
      "\nAppendix data. Workloads and individual timed samples; warm-up excluded.\n\n";
    b.pairs.forEach((p) => {
      text += `### ${p.task}\n\nWorkload: ${p.workload}.\n\n`;
      [p.primary, p.baseline].forEach(
        (m) =>
          (text += `- ${m.name}: mean ${reportMs(m.mean_ms)} ms; min ${reportMs(m.min_ms)} ms; max ${reportMs(m.max_ms)} ms; ${m.operation_count} operations/run; median/operation ${reportMs(m.per_operation_ms)} ms; ${m.work} ${m.work_label}. Samples (ms): ${m.samples_ms.map(reportMs).join(", ")}.\n`),
      );
      text += "\n";
    });
    text += `Routing target: ${b.pairs[0].slot}; distance ${b.pairs[0].distance} m; ${b.pairs[0].assignment_available ? "selected from eligible bays" : "route-only target, no assignable bay"}.\n\nQueue shifts are theoretical n(n-1)/2; dictionary work counts calls, not collision probes. Visible backend CPU count does not establish hardware allocation.\n\n`;
  } else
    text +=
      "No empirical results recorded. Run an experiment to populate measured results.\n\n";
  text += `## 5. Discussion and limitations\n\n${reportObservations()}\n\n${reportLimitations}\n\nFurther evaluation: vary input size and distribution, route targets and measurement order; record hardware; conduct a separate end-to-end load study.\n\n## 6. References\n\n`;
  reportReferences.forEach(
    (r, i) => (text += `[${i + 1}] ${r.label} ${r.url}\n\n`),
  );
  return text;
}
function reportCsv() {
  const b = benchmarkResults;
  const header = [
    "recorded_utc",
    "record_count",
    "repetitions",
    "seed",
    "capacity",
    "floors",
    "task",
    "method",
    "role",
    "median_ms",
    "mean_ms",
    "min_ms",
    "max_ms",
    "operations_per_run",
    "median_per_operation_ms",
    "work_count",
    "work_unit",
    "outputs_matched",
    "samples_ms",
    "python",
    "implementation",
    "system",
    "machine",
    "visible_logical_cpus",
    "clock_resolution_ns",
    "graph_vertices",
    "graph_edges",
    "runtime_release",
    "clock_monotonic",
    "routing_destination",
    "route_target_bay",
    "route_distance_m",
    "assignable_bay_available",
    "graph_start",
    "graph_goal",
  ];
  const rows = b.pairs.flatMap((p) =>
    ["primary", "baseline"].map((role) => {
      const m = p[role],
        env = b.environment || {},
        g = b.graph || {};
      return [
        b.measured_at,
        b.size,
        b.repeats,
        b.seed,
        b.capacity,
        b.floors,
        p.task,
        m.name,
        role,
        m.median_ms,
        m.mean_ms,
        m.min_ms,
        m.max_ms,
        m.operation_count,
        m.per_operation_ms,
        m.work,
        m.work_label,
        p.verified,
        JSON.stringify(m.samples_ms),
        env.python,
        env.implementation,
        env.system,
        env.machine,
        env.logical_cpus,
        env.clock_resolution_ns,
        g.vertices,
        g.undirected_edges,
        env.release,
        env.clock_monotonic,
        b.destination,
        b.pairs[0].slot,
        b.pairs[0].distance,
        b.pairs[0].assignment_available,
        JSON.stringify(g.start),
        JSON.stringify(g.goal),
      ];
    }),
  );
  return [header, ...rows]
    .map((row) =>
      row.map((v) => '"' + String(v ?? "").replace(/"/g, '""') + '"').join(","),
    )
    .join("\r\n");
}
async function handleAcademicAction(el) {
  const action = el.dataset.action;
  if (action === "report-section") {
    document
      .getElementById(el.dataset.section)
      ?.scrollIntoView({ behavior: "smooth" });
    return true;
  }
  if (action === "report-print") {
    window.print();
    return true;
  }
  if (action === "report-markdown") {
    downloadReportFile(
      reportFileStem() + ".md",
      reportMarkdown(),
      "text/markdown;charset=utf-8",
    );
    return true;
  }
  if (action === "report-csv") {
    if (!benchmarkResults) {
      toast("Run an experiment before exporting measured results.", true);
      return true;
    }
    downloadReportFile(
      reportFileStem() + ".csv",
      reportCsv(),
      "text/csv;charset=utf-8",
    );
    return true;
  }
  return false;
}
document.addEventListener("click", (event) => {
  if (event.target.closest('[data-action="report-section"]'))
    event.preventDefault();
});
