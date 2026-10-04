/* Efficiency experiments and simulation controls extend the shared parking UI. */
let benchmarkResults=null, benchmarkRunning=false, scenarioCatalog=[], scenarioResults={}, scenarioRunning='';
let benchmarkConfig={size:1100,repeats:7,destination:0};
let trafficConfig={destination:'random',mode:'balanced',interval:5,batch:1};
let trafficTimer=null, trafficTicks=0, trafficLast='Ready to simulate', trafficError='';

function runtime(ms){
 if(ms<0.001)return `${(ms*1000000).toFixed(1)} ns`;
 if(ms<1)return `${(ms*1000).toFixed(2)} µs`;
 if(ms<1000)return `${ms.toFixed(3)} ms`;
 return `${(ms/1000).toFixed(2)} s`;
}
function benchmarkPanel(){
 const rows=benchmarkResults?.pairs||[];
 return `<section class="panel efficiency-panel"><div class="panel-head"><div><h2>Algorithm efficiency bench</h2><p>Repeated server timings · identical inputs within each task</p></div><span class="chip">${benchmarkRunning?'Measuring…':rows.length?'Measured results':'Run an experiment'}</span></div><div class="panel-body"><form class="benchmark-form" data-form="benchmark"><label class="field">Record / queue size<select name="size" id="benchmark-size">${[100,500,1100,5000].map(n=>`<option value="${n}" ${n===benchmarkConfig.size?'selected':''}>${num(n)} records</option>`).join('')}</select></label><label class="field">Repetitions<select name="repeats" id="benchmark-repeats">${[3,5,7,15].map(n=>`<option value="${n}" ${n===benchmarkConfig.repeats?'selected':''}>${n} repetitions</option>`).join('')}</select></label><label class="field">Routing destination<select name="destination" id="benchmark-destination">${destinationsOptions(benchmarkConfig.destination)}</select></label>${btn(benchmarkRunning?'Measuring runtime…':'Run efficiency comparison','submit-benchmark','chart')}</form><p class="bench-note">Compare methods that solve the same task. Lookup, routing, queueing and sorting have different workloads; their raw runtimes are not a shared ranking.</p>${benchmarkRunning?'<div class="notice">Running warm-ups and repeated measurements. Large sorting experiments may take a few seconds.</div>':''}${rows.length?`<div class="table-wrap"><table class="benchmark-table"><thead><tr><th>Task / methods</th><th>Primary median</th><th>Baseline median</th><th>Relative runtime</th><th>Output check</th></tr></thead><tbody>${rows.map(p=>`<tr><td><strong>${esc(p.task)}</strong><br><small>${esc(p.primary.name)} vs ${esc(p.baseline.name)}</small></td><td>${runtime(p.primary.median_ms)}<br><small class="muted">${p.primary.operation_count>1?runtime(p.primary.per_operation_ms)+' / operation':'per run'}</small></td><td>${runtime(p.baseline.median_ms)}<br><small class="muted">${p.baseline.operation_count>1?runtime(p.baseline.per_operation_ms)+' / operation':'per run'}</small></td><td>${ratioText(p)}</td><td><span class="chip ${p.verified?'':'red'}">${p.verified?'Equal & valid':'Mismatch'}</span></td></tr>`).join('')}</tbody></table></div><div class="benchmark-grid">${rows.map(p=>benchmarkCard(p)).join('')}</div><div class="notice">${esc(benchmarkResults.methodology)}</div><small class="muted">Seed ${benchmarkResults.seed} · ${num(benchmarkResults.size)} synthetic records · ${benchmarkResults.repeats} timed repetitions · routing uses the actual ${num(benchmarkResults.capacity)}-bay graph on ${benchmarkResults.floors} floors. Synthetic record size changes only the experiment.</small>`:'<div class="benchmark-empty">'+icon('chart')+'<div><strong>See how efficiency changes with input size.</strong><p>Run four comparisons, then try a larger dataset. Results include median, mean, range, work counts and output validation.</p></div></div>'}</div></section>`;
}
function ratioText(pair){
 if(!pair.speedup)return 'Below timer resolution';
 return pair.speedup>=1?`${pair.speedup.toFixed(2)}× primary faster`:`${(1/pair.speedup).toFixed(2)}× baseline faster`;
}
function benchmarkCard(p){
 const max=Math.max(p.primary.median_ms,p.baseline.median_ms);
 return `<article class="benchmark-card"><h3>${esc(p.task)}</h3><p>${esc(p.workload)}</p>${[p.primary,p.baseline].map((r,i)=>`<div class="runtime-row"><div><strong>${esc(r.name)}</strong><span>${runtime(r.median_ms)}</span></div><div class="runtime-track"><i class="${i?'baseline':''}" style="width:${Math.max(2,r.median_ms/max*100)}%"></i></div><small>Mean ${runtime(r.mean_ms)} · range ${runtime(r.min_ms)}–${runtime(r.max_ms)}</small><small>${num(r.work)} ${esc(r.work_label)} · ${esc(r.complexity)}</small></div>`).join('')}<details><summary>Show individual timings</summary><p>${p.primary.name}: ${p.primary.samples_ms.map(runtime).join(', ')}<br>${p.baseline.name}: ${p.baseline.samples_ms.map(runtime).join(', ')}</p></details>${p.task==='Routing'?`<p class="bench-note">Both routes: ${p.distance} m. ${p.assignment_available?'Bay chosen from live availability.':'Lot has no assignable bay; this is a route-only comparison to a physical bay.'}</p>`:''}</article>`;
}
async function runBenchmark(data){
 benchmarkConfig={size:Number(data.size),repeats:Number(data.repeats),destination:Number(data.destination)};
 await mutate(async()=>{
  benchmarkRunning=true;render();
  try{benchmarkResults=await api('/api/algorithms/benchmark',benchmarkConfig);toast('Efficiency measurements complete. All four task pairs checked.');}
  finally{benchmarkRunning=false;render();}
 });
}
function simulationPage(){
 const tested=Object.values(scenarioResults),passed=tested.filter(r=>r.passed).length;
 return '<div class="simulation-heading">'+pageHead('Put every parking case to the test.','Live demo controls from Version 1, plus repeatable checks for operational edge cases.',btn('Run all scenario checks','scenario','play','','data-case="all"'))+'</div>'+`<div class="notice">${icon('info')}Live controls update demo vehicles in this workspace. Scenario checks use a separate ${num(state.capacity)}-bay database and report expected vs actual outcomes.</div><div class="simulation-layout"><section class="panel"><div class="panel-head"><div><h2>Live simulation controls</h2><p>Register near a selected destination, fill the lot, or clear demo records</p></div><span class="chip ${trafficTimer?'':'gray'}">${trafficTimer?'Traffic running':'Traffic paused'}</span></div><div class="panel-body"><div class="control-fields"><label class="field">Arrival destination<select id="simulation-destination"><option value="random" ${trafficConfig.destination==='random'?'selected':''}>Random across all floors</option>${destinationsOptions(trafficConfig.destination)}</select></label><label class="field">Batch size<select id="simulation-batch">${[1,5,10,100].map(n=>`<option value="${n}" ${n===trafficConfig.batch?'selected':''}>${n} vehicle${n>1?'s':''}</option>`).join('')}</select></label></div><div class="live-control-grid">${[
 ['entry','Simulate one arrival','Enter a generated plate near your selected destination.','enter'],
 ['exit','Simulate one exit','Exit a demo vehicle, calculate its fee and serve the FIFO queue.','exit'],
 ['custom','Generate selected batch','Create the chosen number of arrivals using the destination above.','plus'],
 ['fill','Fill all 1,100 bays','Fill open bays with demo vehicles; the next arrival queues.','layers'],
 ['queue','Create a waiting queue','Fill available bays, then enqueue three demonstration arrivals.','queue'],
 ['clear','Clear simulation records','Version 1 behavior: clear demo visits and keep manual entries.','trash'],
 ['reset','Reset demo dataset','Restore sample occupancy and history while retaining manual visits.','refresh']
 ].map(([sim,label,description,ico])=>`<button class="live-control" data-action="simulate" data-sim="${sim}">${icon(ico)}<span><strong>${label}</strong><small>${description}</small></span>${icon('chevron')}</button>`).join('')}</div><div class="divider"></div><h3>Continuous traffic</h3><p class="bench-note">Runs while this tab stays open. Entries use the chosen destination; automatic departures select demo vehicles only.</p><div class="control-fields"><label class="field">Traffic mode<select id="traffic-mode">${[['balanced','Balanced arrivals / exits'],['arrivals','Arrivals only'],['departures','Departures only'],['rush','Rush hour: arrivals + one exit']].map(([key,label])=>`<option value="${key}" ${key===trafficConfig.mode?'selected':''}>${label}</option>`).join('')}</select></label><label class="field">Tick interval<select id="traffic-interval">${[2,5,10].map(n=>`<option value="${n}" ${n===trafficConfig.interval?'selected':''}>Every ${n} seconds</option>`).join('')}</select></label></div><div class="result-actions">${btn(trafficTimer?'Pause traffic':'Start traffic',trafficTimer?'traffic-pause':'traffic-start',trafficTimer?'close':'play')}${btn('Step one traffic tick','traffic-step','arrow','secondary')}</div><div class="traffic-status" role="status"><span class="dot"></span><span>${trafficTimer?'Running':'Paused'} · ${trafficTicks} ticks · ${esc(trafficLast)}</span></div>${trafficError?`<div class="notice warning">${esc(trafficError)}</div>`:''}</div></section><div class="side-stack"><section class="panel"><div class="panel-head"><h2>Current workspace</h2></div><div class="panel-body"><div class="simulation-counters">${[['Physical bays',state.capacity],['Available',state.available],['Occupied / assigned',state.occupied],['Waiting',state.waiting_count],['Closed',state.disabled]].map(([label,n])=>`<div><span>${label}</span><strong>${num(n)}</strong></div>`).join('')}</div><div class="notice" style="margin:18px 0 0">Clear/reset keeps manual vehicles, settings, incidents and bay closures. Live exit controls affect demo vehicles only.</div></div></section><section class="panel"><div class="panel-head"><h2>Recent simulation activity</h2></div><div class="panel-body">${recentActivity(5)}</div></section></div></div><section class="panel scenario-panel"><div class="panel-head"><div><h2>Scenario control mode</h2><p>${scenarioCatalog.length} cases · actual parking-engine operations · disposable lot per case</p></div><span class="chip ${tested.some(r=>!r.passed)?'red':''}">${scenarioRunning?'Testing…':`${passed}/${tested.length} tested cases passed`}</span></div><div class="panel-body"><div class="scenario-summary"><span>${tested.length}/${scenarioCatalog.length} cases tested</span><span>${tested.length-passed} failed</span><span>${runtime(tested.reduce((n,r)=>n+r.runtime_ms,0))} total scenario runtime</span>${btn(scenarioRunning?'Running scenario checks…':'Run all cases','scenario','play','secondary small','data-case="all"')}</div><p class="bench-note">Scenario runtimes include database setup, fixtures and validation. They are separate from the algorithm-only efficiency measurements. Each result shows the checks and final lot state.</p><div class="scenario-grid">${scenarioCatalog.map(s=>scenarioCard(s,scenarioResults[s.id])).join('')}</div></div></section>`;
}
function scenarioCard(definition, r){
 const show=value=>esc(typeof value==='object'?JSON.stringify(value):String(value));
 return `<article class="scenario-card ${r?(r.passed?'passed':'failed'):''}"><div class="scenario-title"><h3>${esc(definition.name)}</h3><span class="chip ${r?(r.passed?'':'red'):'gray'}">${scenarioRunning===definition.id||scenarioRunning==='all'?'Running':r?(r.passed?'Pass':'Fail'):'Ready'}</span></div><p>${esc(definition.description)}</p><div class="scenario-actions">${btn('Run case','scenario','play','secondary small',`data-case="${definition.id}"`)}${r?`<span class="muted">${runtime(r.runtime_ms)}</span>`:''}</div>${r?`<details><summary>View expected / actual checks</summary>${r.steps.length?`<ol>${r.steps.map(s=>`<li>${esc(s)}</li>`).join('')}</ol>`:''}<div class="scenario-checks">${r.checks.map(c=>`<div><strong>${c.passed?'✓':'✕'} ${esc(c.label)}</strong><span>Expected: ${show(c.expected)}</span><span>Actual: ${show(c.actual)}</span></div>`).join('')}</div>${r.final?`<p>Final lot: ${r.final.occupied} occupied, ${r.final.available} available, ${r.final.waiting} waiting, ${r.final.disabled} closed.</p>`:''}<small>${esc(r.scope)}</small></details>`:''}</article>`;
}
async function runScenario(id){
 await mutate(async()=>{
  scenarioRunning=id;render();
  try{const report=await api('/api/simulation/scenarios',{case:id});report.results.forEach(r=>scenarioResults[r.id]=r);toast(`${report.passed}/${report.total} scenario checks passed · ${runtime(report.runtime_ms)}`,report.passed!==report.total);}
  finally{scenarioRunning='';render();}
 });
}
function stopTraffic(message='Traffic paused'){
 clearInterval(trafficTimer);trafficTimer=null;trafficLast=message;
}
async function trafficTick(){
 if(busy||role==='visitor')return;
 await mutate(async()=>{
  trafficError='';trafficTicks++;
  const destination=trafficConfig.destination==='random'?null:Number(trafficConfig.destination);
  const batch=Math.min(trafficConfig.batch,10); // Automatic ticks are bounded; manual batches allow 100.
  let action=trafficConfig.mode==='departures'?'exit':trafficConfig.mode==='balanced'&&trafficTicks%2===0?'exit':'generate';
  if(state.waiting_count>=100){action='exit';trafficLast='Queue limit reached; prioritizing demo departures';}
  try{
   if(action==='exit')await api('/api/simulate',{action:'exit'});
   else{await api('/api/simulate',{action:'generate',count:batch,destination});if(trafficConfig.mode==='rush')await api('/api/simulate',{action:'exit'});}
   trafficLast=action==='exit'?'Demo departure → fee / queue handoff':`${batch} demo arrivals${trafficConfig.mode==='rush'?' + one departure':''}`;
  }catch(error){trafficError=error.message;trafficLast='Tick completed with a rejected operation';}
  await refresh();if(page==='simulation'||!['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName))render();
 });
}
async function handleLabToolsAction(el){
 const action=el.dataset.action;
 if(action==='scenario'){await runScenario(el.dataset.case);return true;}
 if(action==='traffic-start'){
  if(!trafficTimer){trafficLast='Waiting for next tick';trafficTimer=setInterval(trafficTick,trafficConfig.interval*1000);render();toast('Continuous demo traffic started.');}return true;
 }
 if(action==='traffic-pause'){stopTraffic();render();return true;}
 if(action==='traffic-step'){await trafficTick();return true;}
 return false;
}
document.addEventListener('change',event=>{
 const el=event.target;
 const benchmarkKeys={'benchmark-size':'size','benchmark-repeats':'repeats','benchmark-destination':'destination'};
 if(benchmarkKeys[el.id])benchmarkConfig[benchmarkKeys[el.id]]=Number(el.value);
 const keys={'simulation-destination':'destination','simulation-batch':'batch','traffic-mode':'mode','traffic-interval':'interval'};
 if(keys[el.id]){
  trafficConfig[keys[el.id]]=['simulation-batch','traffic-interval'].includes(el.id)?Number(el.value):el.value;
  if(trafficTimer&&el.id==='traffic-interval'){clearInterval(trafficTimer);trafficTimer=setInterval(trafficTick,trafficConfig.interval*1000);}
 }
});
window.addEventListener('pagehide',()=>stopTraffic('Tab closed; traffic paused'));
