"""Inspectable scenario checks in disposable lots, independent of live parking records."""
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from time import perf_counter
from unittest.mock import patch

from .algorithms import astar
from .store import ParkingError, ParkingStore, now

SCENARIOS = [
    ('normal_entry', 'Normal arrival & parking', 'A valid vehicle receives a route, confirms parking and is found by plate.'),
    ('duplicate', 'Duplicate plate', 'A normalized duplicate is rejected without creating a second visit.'),
    ('invalid_plate', 'Invalid license plate', 'Invalid characters are rejected before state changes.'),
    ('unknown_plate', 'Unknown vehicle', 'Looking up an absent plate returns a clear not-found result.'),
    ('floor_full', 'Destination floor full', 'All 100 bays on the destination floor are taken; use another connected floor.'),
    ('lot_full', 'All 1,100 bays full', 'The next arrival waits at FIFO position #1 without an assigned bay.'),
    ('fifo', 'Exit & FIFO handoff', 'An exit releases a bay to the first of three waiting vehicles.'),
    ('cancel', 'Cancel a middle waiter', 'Cancellation preserves the order and positions of the remaining vehicles.'),
    ('closed_bay', 'Bay closed for maintenance', 'A closed bay is excluded from recommendation.'),
    ('reopen', 'Reopen a bay', 'Opening a closed bay serves the oldest waiting visitor.'),
    ('no_route', 'Entrance route blocked', 'Disconnected driving access produces no route and queues the arrival.'),
    ('fee', 'Free-hour fee boundary', 'A visit just over two hours costs the first billed-hour fee.'),
    ('reentry', 'Exit, then re-enter', 'A new visit can use the same plate after the prior visit ends.'),
    ('concurrent', 'Concurrent arrival burst', 'Twenty arrivals compete for two free bays without duplicate assignment.'),
    ('history', 'Out-of-order history', 'Merge Sort orders full timestamps and preserves equal-time order.'),
    ('restart', 'Server restart recovery', 'Persisted assignment, queue order and bay closures survive reopening the database.'),
    ('rollback', 'Operation failure & rollback', 'A simulated failure during exit restores both database and in-memory state.'),
    ('clear_demo', 'Clear demo, keep manual visits', 'Version 1’s clear control removes demo records and serves manual waiters.'),
]


def catalog():
    return [{'id': key, 'name': name, 'description': description} for key, name, description in SCENARIOS]


def run_case(case_id, floors=11, bays=100):
    definitions = {key: (name, description) for key, name, description in SCENARIOS}
    if case_id not in definitions:
        raise ParkingError('Unknown scenario.', 404)
    name, description = definitions[case_id]
    checks, steps, evidence = [], [], {}
    started = perf_counter()
    def check(label, actual, expected):
        checks.append({'label': label, 'actual': actual, 'expected': expected, 'passed': actual == expected})
    def rejection(operation):
        try:
            operation()
        except ParkingError as error:
            steps.append(str(error))
            return error.status
        return None
    with tempfile.TemporaryDirectory(prefix='parkside-scenario-') as directory:
        path = Path(directory) / 'scenario.sqlite3'
        store = ParkingStore(path, floors, bays, False)
        capacity = len(store.slots)
        initial = {'capacity': capacity, 'occupied': 0, 'waiting': 0, 'disabled': 0}
        try:
            if case_id == 'normal_entry':
                r = store.enter('ABC-1234', 0, True)
                v = store.confirm('ABC1234')
                located = store.find('abc 1234')
                check('Vehicle status', v['status'], 'parked')
                check('Plate lookup returns the assigned bay', located['slot'], r['vehicle']['slot'])
                check('Driving route ends at the bay', tuple(located['route']['driving']['path'][-1]), store.slots[v['slot']]['node'])
                evidence.update(plate=v['plate'], slot=v['slot'], algorithm=r['algorithm'])
                steps.extend(['Register ABC-1234 → assigned bay', 'Confirm parking → parked', 'Hash lookup → same bay'])
            elif case_id == 'duplicate':
                store.enter('ABC-1234', 0, True)
                check('Duplicate rejected', rejection(lambda: store.enter('abc 1234', 0, True)), 409)
                check('Active visits', len(store.active), 1)
            elif case_id == 'invalid_plate':
                check('Invalid plate rejected', rejection(lambda: store.enter('BAD<script>', 0, True)), 400)
                check('No active visit created', len(store.active), 0)
            elif case_id == 'unknown_plate':
                check('Unknown plate returns not found', rejection(lambda: store.find('UNKNOWN')), 404)
                check('No occupancy change', len(store.occupied), 0)
            elif case_id == 'floor_full':
                with store.transaction():
                    for s in store.slots.values():
                        if s['floor'] == 0:
                            store._insert(f'FIXTURE{s["index"]}', 0, s['id'], True, status='parked')
                    store._reload()
                initial['occupied'] = bays
                v = store.enter('FALLBACK1', 0, True)['vehicle']
                check('Assigned on a different floor', v['floor'] != 0, True)
                check('Not queued while other floors have capacity', v['status'], 'assigned')
                evidence.update(slot=v['slot'], floor=v['floor'], walk_m=v['route']['walking']['distance'])
                steps.extend([f'Fixture: fill floor 0 ({bays} bays)', 'Arrival requests floor 0 destination', 'A* finds a bay on another connected floor'])
            elif case_id in ('lot_full', 'fifo', 'cancel', 'restart'):
                store.simulate('fill'); initial['occupied'] = capacity
                waiters = ['WAIT1'] if case_id == 'lot_full' else ['WAIT1', 'WAIT2', 'WAIT3']
                for plate in waiters: store.enter(plate, 0, True)
                steps.extend([f'Fill {capacity:,} bays', 'Enqueue: ' + ' → '.join(waiters)])
                if case_id == 'lot_full':
                    v = store.find('WAIT1')
                    check('Waiting status', v['status'], 'waiting'); check('Queue position', v['queue_position'], 1)
                    check('No bay assigned', v['slot'], None)
                elif case_id == 'fifo':
                    leaving = next(iter(store.occupied.values()))
                    r = store.exit(leaving)
                    check('First waiter served', r['promoted'][0]['plate'], 'WAIT1')
                    check('Released bay reused', r['promoted'][0]['slot'], r['receipt']['slot'])
                    check('Remaining order', list(store.waiting), ['WAIT2', 'WAIT3'])
                    evidence.update(released_bay=r['receipt']['slot'], promoted='WAIT1')
                    steps.append(f'Exit {leaving} → WAIT1 receives {r["receipt"]["slot"]}')
                elif case_id == 'cancel':
                    store.cancel('WAIT2')
                    check('Cancellation preserves FIFO', list(store.waiting), ['WAIT1', 'WAIT3'])
                    check('Updated WAIT3 position', store.find('WAIT3')['queue_position'], 2)
                    steps.append('Cancel WAIT2 → WAIT1, WAIT3 remain in order')
                else:
                    # Release a bay then close an unused bay; retain the waiting order before restart.
                    leaving = next(iter(store.occupied.values())); store.exit(leaving)
                    leaving = next(iter(store.occupied.values())); store.exit(leaving)
                    leaving = next(iter(store.occupied.values())); store.exit(leaving)
                    leaving = next(iter(store.occupied.values())); free = store.exit(leaving)['receipt']['slot']
                    store.set_slot(free, True)
                    store.enter('WAIT4', 0, True)  # All remaining open bays occupied.
                    expected_occupied, expected_waiting = dict(store.occupied), list(store.waiting)
                    store.close(); store = ParkingStore(path, floors, bays, False)
                    check('Assignment registry restored', store.occupied == expected_occupied, True)
                    check('Queue order restored', list(store.waiting), expected_waiting)
                    check('Bay closure restored', free in store.disabled, True)
                    steps.append('Close and reopen the same SQLite database')
            elif case_id == 'closed_bay':
                best = store._assignment(0)['slot']; store.set_slot(best, True)
                v = store.enter('MAINT1', 0, True)['vehicle']
                check('Closed bay not assigned', v['slot'] != best, True)
                check('Closed bay retained', best in store.disabled, True)
                evidence.update(closed_bay=best, assigned_bay=v['slot'])
            elif case_id == 'reopen':
                with store.transaction():
                    store.db.executemany('INSERT INTO closed_slots VALUES (?,?)', [(s, 'Scenario fixture') for s in store.slots])
                    store._reload()
                initial['disabled'] = capacity
                store.enter('WAIT1', 0, True); store.enter('WAIT2', 0, True)
                r = store.set_slot('A-01', False)
                check('Oldest waiter promoted', r['promoted'][0]['plate'], 'WAIT1')
                check('Reopened bay assigned', r['promoted'][0]['slot'], 'A-01')
                check('Second waiter remains', list(store.waiting), ['WAIT2'])
                steps.extend(['Fixture: close every bay', 'Enqueue WAIT1, WAIT2', 'Reopen A-01 → WAIT1'])
            elif case_id == 'no_route':
                start = (0, 0, 4)
                store.graph[start] = {}
                v = store.enter('BLOCKED1', 0, True)['vehicle']
                check('Disconnected route returns no path', astar(store.graph, start, store.slots['A-01']['node']), None)
                check('Arrival waits safely', v['status'], 'waiting')
                check('No unreachable bay assigned', v['slot'], None)
                steps.extend(['Fixture: disconnect entrance driving edges', 'Physical bays are free, but no driving route is reachable', 'Arrival enters FIFO queue'])
            elif case_id == 'fee':
                store.enter('FEE1', 0, True)
                assigned = (now() - timedelta(hours=2, seconds=1)).isoformat()
                with store.transaction():
                    store.db.execute('UPDATE sessions SET entry_time=?,parked_time=? WHERE plate=?', (assigned, assigned, 'FEE1'))
                    store._reload()
                estimate = store.find('FEE1')['estimated_fee']; r = store.exit('FEE1')['receipt']
                check('Fee just beyond free period', r['fee'], 30)
                check('Estimate agrees with receipt', estimate, r['fee'])
                check('Billable hours', r['billable_hours'], 1)
                evidence.update(duration_minutes=r['duration_minutes'], fee=r['fee'])
                steps.extend(['Fixture: 2h 1s parking duration', 'Two free hours expire', 'Calculate and persist THB 30'])
            elif case_id == 'reentry':
                first = store.enter('REPEAT1', 0, True)['vehicle']['id']; store.exit('REPEAT1')
                second = store.enter('REPEAT1', 0, True)['vehicle']['id']
                check('New visit identity', first != second, True)
                check('Only one active visit', len(store.active), 1)
                check('Previous visit in history', len(store.history()), 1)
            elif case_id == 'concurrent':
                store.simulate('fill')
                for plate in list(store.occupied.values())[:2]: store.exit(plate)
                initial['occupied'] = capacity - 2
                with ThreadPoolExecutor(max_workers=8) as pool:
                    outcomes = list(pool.map(lambda i: store.enter(f'BURST{i}', i % 11, True), range(20)))
                assigned = [r['vehicle']['slot'] for r in outcomes if r['vehicle']['slot']]
                check('Exactly two bays assigned', len(assigned), 2)
                check('Assigned bays unique', len(set(assigned)), 2)
                check('Remaining arrivals queued', len(store.waiting), 18)
                check('Physical capacity respected', len(store.occupied), capacity)
                steps.extend(['Fixture: two bays available', 'Run 20 arrivals on eight threads', 'Verify unique assignment and 18 waiters'])
            elif case_id == 'history':
                values = [('SORT1', '2026-10-01T14:30:00+00:00'), ('SORT2', '2026-10-01T08:15:00+00:00'), ('SORT3', '2026-10-01T12:20:00+00:00'), ('SORT4', '2026-10-01T08:15:00+00:00')]
                for plate, entry in values:
                    store.enter(plate, 0, True); store.exit(plate)
                    with store.transaction(): store.db.execute('UPDATE sessions SET entry_time=? WHERE plate=?', (entry, plate))
                ordered = [r['plate'] for r in store.history('asc')]
                check('Timestamp order and equal-time stability', ordered, ['SORT2', 'SORT4', 'SORT3', 'SORT1'])
                evidence.update(output=ordered)
            elif case_id == 'rollback':
                store.enter('KEEP1', 0, True)
                before = dict(store.occupied)
                with patch.object(store, '_promote', side_effect=RuntimeError('Injected scenario failure')):
                    try: store.exit('KEEP1')
                    except RuntimeError: steps.append('Injected queue-promotion failure during exit')
                check('Bay registry rolled back', store.occupied == before, True)
                check('Visit still active', store.find('KEEP1')['status'], 'assigned')
                check('Failed exit not in history', len(store.history()), 0)
            elif case_id == 'clear_demo':
                store.enter('MANUAL1', 0); store.simulate('fill'); store.enter('MANUAL2', 1)
                initial['occupied'] = capacity
                store.simulate('clear')
                check('Manual visits preserved', set(store.active) == {'MANUAL1', 'MANUAL2'}, True)
                check('Manual waiter promoted', store.find('MANUAL2')['status'], 'assigned')
                check('All demo records removed', store.db.execute('SELECT COUNT(*) FROM sessions WHERE is_demo=1').fetchone()[0], 0)
                steps.extend(['Create a manual arrival', 'Fill demo bays, then queue a manual arrival', 'Clear only demo records → manual waiter promoted'])
            # Invariants are checked for every scenario, not just its own expected outcome.
            active_slots = [r['slot'] for r in store.active.values() if r['slot']]
            check('No duplicate bay assignment', len(active_slots), len(set(active_slots)))
            check('No occupied closed bay', bool(set(store.occupied) & set(store.disabled)), False)
            final = {'capacity': capacity, 'occupied': len(store.occupied), 'waiting': len(store.waiting),
                     'disabled': len(store.disabled), 'available': capacity-len(store.occupied)-len(store.disabled)}
        except Exception as error:
            checks.append({'label': 'Scenario completed without unexpected error', 'actual': str(error), 'expected': 'completed', 'passed': False})
            final = None
        finally:
            store.close()
    return {'id': case_id, 'name': name, 'description': description,
            'passed': all(c['passed'] for c in checks), 'checks': checks, 'steps': steps,
            'initial': initial, 'final': final, 'evidence': evidence,
            'runtime_ms': round((perf_counter()-started)*1000, 3), 'scope': 'Disposable scenario database; live records unchanged'}


def run_scenarios(case_id='all', floors=11, bays=100):
    ids = [item[0] for item in SCENARIOS] if case_id == 'all' else [case_id]
    results = [run_case(key, floors, bays) for key in ids]
    return {'results': results, 'passed': sum(r['passed'] for r in results), 'total': len(results),
            'runtime_ms': round(sum(r['runtime_ms'] for r in results), 3),
            'capacity': floors*bays, 'floors': floors, 'scope': 'isolated'}
