import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from app.algorithms import insertion_sort, merge_sort
from app.benchmarks import benchmark
from app.main import app
from app.scenarios import catalog, run_scenarios
from app.store import ParkingStore, ParkingError


class EfficiencyTests(unittest.TestCase):
    def setUp(self):
        self.store=ParkingStore(':memory:',seed=False)

    def tearDown(self):
        self.store.close()

    def test_same_workload_outputs_timings_and_work_counts(self):
        result=benchmark(self.store,100,3,4)
        self.assertEqual(len(result['pairs']),4)
        self.assertTrue(all(pair['verified'] for pair in result['pairs']))
        for pair in result['pairs']:
            for method in (pair['primary'],pair['baseline']):
                self.assertEqual(len(method['samples_ms']),3)
                self.assertGreater(method['median_ms'],0)
                self.assertLessEqual(method['min_ms'],method['median_ms'])
                self.assertGreaterEqual(method['max_ms'],method['median_ms'])
                self.assertAlmostEqual(method['per_operation_ms']*method['operation_count'],method['median_ms'])
                self.assertGreater(method['work'],0)
        self.assertEqual(result['capacity'],1100)
        self.assertEqual(self.store.state()['occupied'],0)
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0],0)

    def test_insertion_baseline_is_stable_and_does_not_mutate_input(self):
        source=[(3,'A'),(1,'B'),(1,'C'),(2,'D')]
        expected=[(1,'B'),(1,'C'),(2,'D'),(3,'A')]
        self.assertEqual(insertion_sort(source,key=lambda r:r[0]),expected)
        self.assertEqual(merge_sort(source,key=lambda r:r[0]),expected)
        self.assertEqual(source[0],(3,'A'))

    def test_benchmark_works_with_full_lot_and_preserves_visits(self):
        self.store.enter('MANUAL1',0);self.store.simulate('fill')
        result=benchmark(self.store,30,3)
        self.assertFalse(result['pairs'][0]['assignment_available'])
        self.assertTrue(result['pairs'][0]['verified'])
        self.assertEqual(self.store.state()['occupied'],1100)
        self.assertEqual(self.store.find('MANUAL1')['status'],'assigned')

    def test_selected_destination_and_demo_only_exit(self):
        self.store.enter('MANUAL1',0)
        with self.assertRaises(ParkingError):self.store.simulate('exit')
        generated=self.store.simulate('generate',3,10)
        self.assertEqual(generated['vehicle']['destination'],10)
        self.assertEqual({r['destination'] for r in self.store.active.values() if r['is_demo']},{10})
        exited=self.store.simulate('exit')['receipt']['plate']
        self.assertNotEqual(exited,'MANUAL1')
        self.assertIn('MANUAL1',self.store.active)


class ScenarioTests(unittest.TestCase):
    def test_all_operational_scenarios_pass_on_1100_bay_layout(self):
        result=run_scenarios()
        self.assertEqual(result['passed'],18)
        self.assertEqual(result['total'],18)
        self.assertEqual(result['capacity'],1100)
        for row in result['results']:
            self.assertTrue(row['passed'],row)
            self.assertGreater(row['runtime_ms'],0)
            self.assertTrue(row['checks'])
            self.assertTrue(all(c['passed'] for c in row['checks']))
            self.assertEqual(row['final']['capacity'],1100)

    def test_unknown_scenario_has_explicit_error(self):
        with self.assertRaises(ParkingError):run_scenarios('unknown')

    def test_api_scenarios_leave_live_manual_and_demo_visits_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ,{'PARKING_DB':str(Path(directory)/'test.sqlite3'),'SEED_DEMO':'false','PARKING_FLOORS':'11','BAYS_PER_FLOOR':'100'}):
                with TestClient(app) as client:
                    client.post('/api/entry',json={'plate':'KEEP1','destination':2})
                    client.post('/api/simulate',json={'action':'generate','count':3,'destination':4})
                    before=client.get('/api/state').json()
                    catalog_response=client.get('/api/simulation/scenarios').json()
                    self.assertEqual(len(catalog_response['scenarios']),len(catalog()))
                    report=client.post('/api/simulation/scenarios',json={'case':'fifo'}).json()
                    self.assertEqual(report['passed'],1)
                    after=client.get('/api/state').json()
                    self.assertEqual([r['id'] for r in before['vehicles']],[r['id'] for r in after['vehicles']])
                    self.assertEqual(before['events'],after['events'])
                    self.assertEqual(client.post('/api/algorithms/benchmark',json={'size':30,'repeats':3,'destination':2}).status_code,200)
                    comparison=client.get('/api/algorithms/compare?destination=2').json()
                    self.assertEqual(comparison['astar']['distance'],comparison['dijkstra']['distance'])
                    for name in ('astar','dijkstra'):
                        self.assertEqual(len(comparison[name]['samples_ms']),7)
                        self.assertGreater(comparison[name]['median_ms'],0)
                    self.assertEqual(client.post('/api/algorithms/benchmark',json={'size':5001,'repeats':3}).status_code,422)
                    self.assertEqual(client.post('/api/algorithms/benchmark',json={'size':30,'repeats':1}).status_code,422)
                    self.assertEqual(client.post('/api/simulation/scenarios',json={'case':'invalid'}).status_code,404)


if __name__=='__main__':unittest.main()
