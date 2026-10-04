import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from heapq import heappop, heappush
from pathlib import Path
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fastapi.testclient import TestClient
from app.algorithms import FIFOQueue, astar, build_layout, merge_sort
from app.main import app
from app.store import ParkingStore, ParkingError, fee_for, normalize_plate


class AlgorithmTests(unittest.TestCase):
    def test_layout_is_1100_bays_on_eleven_floors(self):
        graph, slots = build_layout(11,100)
        self.assertEqual(len(slots),1100)
        for floor in range(11):
            self.assertEqual(sum(s['floor']==floor for s in slots.values()),100)
        self.assertTrue(all(len(graph[s['node']])==1 for s in slots.values()))

    def test_astar_matches_dijkstra_for_every_bay(self):
        graph, slots = build_layout(3,40)
        for start in [(0,0,4),(1,8,4),(2,11,4)]:
            queue, costs = [(0,start)], {start:0}
            while queue:
                cost,node = heappop(queue)
                if cost != costs[node]: continue
                for other,weight in graph[node].items():
                    new = cost+weight
                    if new < costs.get(other,float('inf')):
                        costs[other]=new;heappush(queue,(new,other))
            for slot in slots.values():
                route=astar(graph,start,slot['node'],True)
                self.assertEqual(route['distance'],costs[slot['node']])
                self.assertEqual(sum(graph[a][b] for a,b in zip(route['path'],route['path'][1:])),route['distance'])
                self.assertTrue(all(s['g']+s['h']==s['f'] for s in route['steps']))

    def test_astar_no_route(self):
        self.assertIsNone(astar({(0,0,0):{},(0,1,0):{}},(0,0,0),(0,1,0)))

    def test_merge_sort_is_stable_and_emits_real_trace(self):
        trace=[];values=[(3,'a'),(1,'b'),(3,'c'),(2,'d'),(1,'e')]
        self.assertEqual(merge_sort(values,key=lambda i:i[0],trace=trace),[(1,'b'),(1,'e'),(2,'d'),(3,'a'),(3,'c')])
        self.assertEqual(trace[-1]['values'],[1,1,2,3,3])
        self.assertEqual(merge_sort([]),[])

    def test_explicit_fifo(self):
        q=FIFOQueue();self.assertTrue(q.is_empty());q.enqueue('A');q.enqueue('B')
        self.assertEqual(q.front(),'A');self.assertEqual(q.dequeue(),'A');self.assertEqual(q.dequeue(),'B')
        self.assertIsNone(q.dequeue())

    def test_unicode_normalization_and_validation(self):
        self.assertEqual(normalize_plate(' กข-1234 '),'กข1234')
        self.assertEqual(normalize_plate('abc-123'),'ABC123')
        for invalid in ['?','<script>',' ','A'*17]:
            with self.assertRaises(ParkingError): normalize_plate(invalid)

    def test_fee_rounding_and_free_boundary(self):
        settings={'free_hours':2,'first_hour':30,'additional_hour':20}
        for mins,fee in [(0,0),(120,0),(120.01,30),(180,30),(180.01,50),(240,50)]:
            self.assertEqual(fee_for(mins,settings)['fee'],fee)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name)/'parking.sqlite3'
        self.store=ParkingStore(self.path,3,4,False)

    def tearDown(self):
        self.store.close();self.temp.cleanup()

    def fill(self):
        for i in range(12): self.store.enter(f'CAR{i}',i%11)

    def test_entry_assignment_confirmation_and_exit(self):
        result=self.store.enter('ABC-1234',0);v=result['vehicle']
        self.assertEqual(v['status'],'assigned');self.assertEqual(self.store.state()['available'],11)
        self.assertEqual(self.store.confirm('abc 1234')['status'],'parked')
        self.assertEqual(self.store.find('ABC1234')['slot'],v['slot'])
        receipt=self.store.exit('ABC1234')['receipt'];self.assertEqual(receipt['status'],'exited')
        self.assertNotIn('ABC1234',self.store.active);self.assertEqual(self.store.state()['available'],12)
        self.assertEqual(self.store.history()[0]['plate'],'ABC1234')

    def test_candidate_pruning_matches_exhaustive_recommendation(self):
        for destination in range(11):
            available=[s for s in self.store.slots.values() if s['id'] not in self.store.occupied]
            goal=self.store.destinations[destination]['node']
            expected=min(available,key=lambda s:(astar(self.store.graph,s['node'],goal)['distance'],astar(self.store.graph,(0,0,4),s['node'])['distance'],s['index'],s['floor']))
            result=self.store.enter(f'CAR{destination}',destination)
            self.assertEqual(result['vehicle']['slot'],expected['id'])

    def test_full_destination_falls_back_to_another_floor(self):
        for i in range(4): self.store.enter(f'AA{i}',0)
        v=self.store.enter('BB',0)['vehicle'];self.assertNotEqual(v['floor'],0)
        self.assertGreater(v['route']['walking']['distance'],200)

    def test_full_lot_queues_and_multiple_waiters_promote_fifo(self):
        self.fill()
        self.assertEqual(self.store.enter('WAIT1',0)['vehicle']['queue_position'],1)
        self.assertEqual(self.store.enter('WAIT2',10)['vehicle']['queue_position'],2)
        result=self.store.exit('CAR0');self.assertEqual(result['promoted'][0]['plate'],'WAIT1')
        self.assertEqual(result['promoted'][0]['slot'],result['receipt']['slot'])
        self.assertEqual(self.store.find('WAIT2')['queue_position'],1)
        self.assertEqual(self.store.state()['occupied'],12)
        self.assertEqual(self.store.state()['events'][0]['kind'],'dequeue')

    def test_cancellation_preserves_order(self):
        self.fill()
        for p in ['WAIT1','WAIT2','WAIT3']:self.store.enter(p,0)
        self.store.cancel('WAIT2');self.assertEqual(list(self.store.waiting),['WAIT1','WAIT3'])
        with self.assertRaises(ParkingError):self.store.exit('WAIT1')

    def test_duplicate_assigned_parked_and_waiting_rejected(self):
        self.fill();self.store.confirm('CAR0');self.store.enter('WAIT1',0)
        for p in ['car-0','car-1','wait 1']:
            with self.assertRaises(ParkingError) as error:self.store.enter(p,0)
            self.assertEqual(error.exception.status,409)

    def test_closed_bays_never_recommended_and_reopen_promotes(self):
        for s in self.store.slots:self.store.set_slot(s,True)
        self.assertEqual(self.store.state()['available'],0)
        self.store.enter('WAIT1',0)
        result=self.store.set_slot('A-01',False)
        self.assertEqual(result['promoted'][0]['plate'],'WAIT1')
        with self.assertRaises(ParkingError):self.store.set_slot('A-01',True)

    def test_unknown_plate_and_invalid_destination_leave_state_unchanged(self):
        with self.assertRaises(ParkingError):self.store.find('UNKNOWN')
        with self.assertRaises(ParkingError):self.store.enter('AA',11)
        self.assertEqual(self.store.state()['occupied'],0)

    def test_concurrency_never_assigns_two_vehicles_to_one_slot(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results=list(pool.map(lambda i:self.store.enter(f'CON{i}',i%11),range(30)))
        slots=[r['vehicle']['slot'] for r in results if r['vehicle']['slot']]
        self.assertEqual(len(slots),12);self.assertEqual(len(set(slots)),12)
        self.assertEqual(len(self.store.waiting),18)

    def test_restart_preserves_vehicles_fifo_and_bay_closures(self):
        self.store.set_slot('A-01',True);self.store.simulate('fill');self.store.enter('WAIT1',0)
        self.store.close();self.store=ParkingStore(self.path,3,4,False)
        self.assertEqual(self.store.find('WAIT1')['queue_position'],1)
        self.assertIn('A-01',self.store.disabled);self.assertEqual(self.store.state()['occupied'],11)

    def test_rollback_restores_db_and_memory(self):
        self.store.enter('AA',0)
        with patch.object(self.store,'_promote',side_effect=RuntimeError('failure')):
            with self.assertRaises(RuntimeError):self.store.exit('AA')
        self.assertEqual(self.store.find('AA')['status'],'assigned');self.assertEqual(self.store.history(),[])

    def test_fees_are_snapshotted_and_settings_persist(self):
        settings=dict(self.store.settings,free_hours=0,first_hour=50)
        self.store.update_settings(settings);self.store.enter('AA',0);self.store.confirm('AA')
        with patch('app.store.now',return_value=datetime.now(timezone.utc)+timedelta(minutes=5)):
            receipt=self.store.exit('AA')['receipt']
        self.assertEqual(receipt['fee'],50)
        self.store.update_settings(dict(settings,first_hour=100))
        self.assertEqual(self.store.history()[0]['fee'],50)
        self.store.close();self.store=ParkingStore(self.path,3,4,False)
        self.assertEqual(self.store.settings['first_hour'],100)

    def test_analytics_entry_exit_turnover_and_history_sort(self):
        for p in ['ABC1','XYZ2','ABC3']:
            self.store.enter(p,0);self.store.exit(p)
        a=self.store.analytics();self.assertEqual(a['entries'],3);self.assertEqual(a['exits'],3)
        self.assertEqual(sum(a['distribution']),3);self.assertEqual(sum(a['usage'].values()),3)
        self.assertEqual(self.store.state()['turnover_today'],.25)
        self.assertEqual([r['plate'] for r in self.store.history('asc','ABC')],['ABC1','ABC3'])

    def test_clear_and_reset_preserve_manual_records(self):
        self.store.enter('REAL1',0);self.store.simulate('fill');self.store.enter('REAL2',1)
        self.store.simulate('clear');self.assertEqual(set(self.store.active),{'REAL1','REAL2'})
        self.assertEqual(self.store.find('REAL2')['status'],'assigned')
        self.store.simulate('reset');self.assertEqual(self.store.find('REAL1')['status'],'assigned')

    def test_incidents_and_date_validation(self):
        self.store.incident('A-01','Blocked bay','Delivery trolley in bay');self.store.resolve(1)
        self.assertEqual(self.store.state()['incidents'][0]['status'],'resolved')
        for start,end in [('not-a-date','2026-01-01'),('2099-01-01','2099-02-01')]:
            with self.assertRaises(ParkingError):self.store.analytics(start=start,end=end)

    def test_queue_arrivals_count_before_assignment(self):
        self.fill();self.store.enter('WAIT1',0)
        a=self.store.analytics();self.assertEqual(a['entries'],13);self.assertEqual(a['assignments'],12)
        self.store.cancel('WAIT1');self.assertEqual(self.store.analytics()['entries'],13)

    def test_fee_policy_and_billable_hours_remain_immutable(self):
        self.store.update_settings(dict(self.store.settings,free_hours=0,first_hour=60))
        self.store.enter('AA',0)
        with patch('app.store.now',return_value=datetime.now(timezone.utc)+timedelta(minutes=5)):
            self.store.exit('AA')
        self.store.update_settings(dict(self.store.settings,free_hours=24,first_hour=0))
        row=self.store.history()[0];self.assertEqual(row['fee'],60);self.assertEqual(row['billable_hours'],1)
        self.assertIn('"first_hour": 60',row['fee_policy'])

    def test_fee_estimate_uses_unrounded_duration_at_boundary(self):
        initial=datetime.now(timezone.utc)
        with patch('app.store.now',return_value=initial):self.store.enter('AA',0)
        with patch('app.store.now',return_value=initial+timedelta(hours=2,seconds=1)):
            self.assertEqual(self.store.find('AA')['estimated_fee'],30)
            self.assertEqual(self.store.exit('AA')['receipt']['fee'],30)


class ApiTests(unittest.TestCase):
    def test_http_workflow_validation_and_capacity(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ,{'PARKING_DB':str(Path(directory)/'api.sqlite3'),'SEED_DEMO':'false','PARKING_FLOORS':'11','BAYS_PER_FLOOR':'100'}):
                with TestClient(app) as c:
                    s=c.get('/api/state').json();self.assertEqual(s['capacity'],1100)
                    self.assertEqual(len(s['floors']),11);self.assertTrue(all(f['capacity']==100 for f in s['floors']))
                    self.assertEqual(c.get('/').status_code,200)
                    self.assertEqual(c.post('/api/entry',json={'plate':'BAD?','destination':0}).status_code,400)
                    self.assertEqual(c.post('/api/entry',json={'plate':'AA','destination':99}).status_code,422)
                    self.assertEqual(c.get('/api/vehicles/UNKNOWN').status_code,404)
                    self.assertEqual(c.post('/api/entry',json={'plate':'ABC1234','destination':4}).status_code,201)
                    self.assertEqual(c.post('/api/entry',json={'plate':'abc-1234','destination':4}).status_code,409)
                    self.assertEqual(c.post('/api/confirm',json={'plate':'ABC1234'}).json()['status'],'parked')
                    self.assertEqual(c.post('/api/exit',json={'plate':'ABC1234'}).json()['receipt']['status'],'exited')
                    self.assertEqual(c.get('/api/algorithms/merge').json()['output'],c.get('/api/algorithms/merge').json()['input'])
                    self.assertEqual(c.get('/api/history').json()['algorithm'],'Merge Sort')
                    self.assertEqual(c.get('/api/analytics').json()['exits'],1)
                    self.assertEqual(c.get('/api/analytics?days=0').status_code,422)
                    self.assertEqual(c.post('/api/simulate',json={'action':'bad'}).status_code,422)


if __name__=='__main__': unittest.main()
