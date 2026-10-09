import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Request, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .algorithms import astar, dijkstra, merge_sort
from .store import ParkingError, ParkingStore
from .benchmarks import benchmark, measure
from .scenarios import catalog, run_scenarios

ROOT = Path(__file__).resolve().parent.parent


@asynccontextmanager
async def lifespan(app):
    app.state.parking = ParkingStore(os.environ.get('PARKING_DB', str(ROOT/'data'/'parking.sqlite3')),
                                     floors=int(os.environ.get('PARKING_FLOORS','11')),
                                     bays=int(os.environ.get('BAYS_PER_FLOOR','100')),
                                     seed=os.environ.get('SEED_DEMO','true').lower() == 'true')
    yield
    app.state.parking.close()


app = FastAPI(title='Parkside · Mall Parking', version='2.1.0', lifespan=lifespan)
app.mount('/static', StaticFiles(directory=ROOT/'static'), name='static')


@app.exception_handler(ParkingError)
async def error_handler(request: Request, error: ParkingError):
    return JSONResponse(status_code=error.status, content={'detail':str(error)})


class Plate(BaseModel):
    plate: str = Field(min_length=2,max_length=40)


class Entry(Plate):
    destination: int = Field(ge=0,le=10)


class SlotChange(BaseModel):
    disabled: bool
    reason: str = Field(default='Maintenance',min_length=1,max_length=120)


class Settings(BaseModel):
    mall_name: str = Field(min_length=1,max_length=60)
    free_hours: int = Field(ge=0,le=24)
    first_hour: float = Field(ge=0,le=10000)
    additional_hour: float = Field(ge=0,le=10000)
    destinations: list[str] = Field(min_length=11,max_length=11)


class Simulation(BaseModel):
    action: Literal['entry','exit','generate','fill','clear','reset','queue']
    count: int = Field(default=10,ge=1,le=100)
    destination: int | None = Field(default=None,ge=0,le=10)


class BenchmarkInput(BaseModel):
    size: int = Field(default=1100,ge=10,le=5000)
    repeats: int = Field(default=7,ge=3,le=15)
    destination: int = Field(default=0,ge=0,le=10)


class ScenarioInput(BaseModel):
    case: str = Field(default='all',max_length=40)


class Incident(BaseModel):
    slot: str | None = None
    category: Literal['Blocked bay','Vehicle assistance','Lost item','Safety concern','Other']
    note: str = Field(min_length=3,max_length=500)


@app.get('/',include_in_schema=False)
def index():
    return FileResponse(ROOT/'static'/'index.html')


@app.get('/api/health')
def health():
    return {'status':'ok'}


@app.get('/api/state')
def state(request: Request):
    return request.app.state.parking.state()


@app.post('/api/entry',status_code=201)
def entry(body: Entry, request: Request):
    return request.app.state.parking.enter(body.plate,body.destination)


@app.post('/api/confirm')
def confirm(body: Plate,request: Request):
    return request.app.state.parking.confirm(body.plate)


@app.post('/api/exit')
def exit_vehicle(body: Plate,request: Request):
    return request.app.state.parking.exit(body.plate)


@app.post('/api/queue/cancel')
def cancel(body: Plate,request: Request):
    return request.app.state.parking.cancel(body.plate)


@app.get('/api/vehicles/{plate}')
def find(plate: str,request: Request):
    return request.app.state.parking.find(plate)


@app.get('/api/history')
def history(request: Request,order: Literal['asc','desc']='desc',query: str=Query(default='',max_length=40)):
    return {'records':request.app.state.parking.history(order,query),'algorithm':'Merge Sort'}


@app.get('/api/analytics')
def analytics(request: Request,days: int=Query(default=1,ge=1,le=30),start: str|None=None,end: str|None=None):
    return request.app.state.parking.analytics(days,start,end)


@app.patch('/api/slots/{slot}')
def change_slot(slot: str,body: SlotChange,request: Request):
    return request.app.state.parking.set_slot(slot,body.disabled,body.reason)


@app.get('/api/slots/{slot}')
def slot_details(slot: str,request: Request,destination: int=Query(default=0,ge=0,le=10)):
    return request.app.state.parking.slot_details(slot,destination)


@app.put('/api/settings')
def settings(body: Settings,request: Request):
    return request.app.state.parking.update_settings(body.model_dump())


@app.post('/api/simulate')
def simulate(body: Simulation,request: Request):
    return request.app.state.parking.simulate(body.action,body.count,body.destination)


@app.post('/api/incidents',status_code=201)
def incident(body: Incident,request: Request):
    return request.app.state.parking.incident(body.slot,body.category,body.note)


@app.post('/api/incidents/{incident_id}/resolve')
def resolve(incident_id: int,request: Request):
    return request.app.state.parking.resolve(incident_id)


@app.get('/api/algorithms/merge')
def merge_demo(request: Request):
    with request.app.state.parking.lock:
        values = [dict(r)['entry_time'] for r in request.app.state.parking.db.execute('SELECT entry_time FROM sessions WHERE status=\'exited\' LIMIT 8')]
    trace = []
    result = merge_sort(values, trace=trace)
    return {'input':values,'output':result,'trace':trace}


@app.get('/api/algorithms/astar')
def astar_demo(request: Request,destination: int=Query(default=0,ge=0,le=10)):
    store = request.app.state.parking
    with store.lock:
        result = store._assignment(destination)
        return {'algorithm':result,'route':store._route({'slot':result['slot'],'destination':destination}) if result else None}


@app.get('/api/algorithms/graph')
def astar_graph(request: Request):
    store = request.app.state.parking
    edges = [[a, b, w] for a, near in store.graph.items() for b, w in near.items() if a < b]
    return {'columns': store.columns, 'edges': edges}


@app.get('/api/algorithms/astar/trace')
def astar_trace(request: Request, destination: int=Query(default=0,ge=0,le=10),
                leg: Literal['driving','walking']='driving', mode: Literal['astar','dijkstra']='astar',
                slot: str | None=Query(default=None,max_length=8)):
    """Full expansion trace for the A* lab; slot overrides the recommended bay."""
    store = request.app.state.parking
    with store.lock:
        if destination >= len(store.destinations):
            raise ParkingError('Unknown destination.')
        if slot:
            slot = slot.strip().upper()
            if slot not in store.slots:
                raise ParkingError(f'Bay {slot} does not exist.')
            recommended = False
        else:
            result = store._assignment(destination)
            if not result:
                raise ParkingError('No available connected bays. Enter a bay ID to trace a route anyway.')
            slot, recommended = result['slot'], True
        bay, target = store.slots[slot]['node'], store.destinations[destination]['node']
        graph = store.graph
    start, goal = ((0, 0, 4), bay) if leg == 'driving' else (bay, target)
    search = astar(graph, start, goal, trace=True, use_heuristic=mode == 'astar')
    if search is None:
        raise ParkingError('No connected route between these nodes.')
    steps = [{k: v for k, v in s.items() if k != 'open_nodes'} for s in search['steps']]
    return {'slot': slot, 'recommended': recommended, 'destination': destination, 'leg': leg, 'mode': mode,
            'start': start, 'goal': goal, 'path': search['path'], 'distance': search['distance'],
            'expanded': search['expanded'], 'steps': steps}


@app.get('/api/algorithms/compare')
def compare(request: Request,destination: int=Query(default=0,ge=0,le=10)):
    store=request.app.state.parking
    with store.lock:
        result=store._assignment(destination)
        if not result:
            raise ParkingError('No available connected bays for a comparison.')
        start,goal=(0,0,4),store.slots[result['slot']]['node']
        graph=store.graph
        slot=result['slot']
    a_time,a=measure(lambda:None,lambda _:astar(graph,start,goal),7)
    d_time,d=measure(lambda:None,lambda _:dijkstra(graph,start,goal),7)
    return {'slot':slot,'astar':{'distance':a['distance'],'expanded':a['expanded'],**a_time},
            'dijkstra':{'distance':d['distance'],'expanded':d['expanded'],**d_time}}


@app.post('/api/algorithms/benchmark')
def efficiency(body: BenchmarkInput, request: Request):
    return benchmark(request.app.state.parking,body.size,body.repeats,body.destination)


@app.get('/api/simulation/scenarios')
def scenarios():
    return {'scenarios':catalog()}


@app.post('/api/simulation/scenarios')
def check_scenarios(body: ScenarioInput,request: Request):
    store=request.app.state.parking
    return run_scenarios(body.case,store.floor_count,store.bays)
