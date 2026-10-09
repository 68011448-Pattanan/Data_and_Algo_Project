"""Repeatable comparisons of equivalent tasks; timings exclude setup and validation."""
import random
import os
import platform
from datetime import datetime, timedelta, timezone
from statistics import median, mean
from time import perf_counter_ns, get_clock_info

from .algorithms import FIFOQueue, astar, dijkstra, insertion_sort, merge_sort


def measure(prepare, operation, repeats, operation_count=1):
    # Warm up both implementations, then build fresh equivalent inputs before each timer.
    operation(prepare())
    samples, output = [], None
    for _ in range(repeats):
        data = prepare()
        began = perf_counter_ns()
        output = operation(data)
        samples.append((perf_counter_ns() - began) / 1_000_000)
    middle = median(samples)
    return ({'median_ms': middle, 'mean_ms': mean(samples), 'min_ms': min(samples),
             'max_ms': max(samples), 'samples_ms': samples, 'repeats': repeats,
             'operation_count': operation_count, 'per_operation_ms': middle / operation_count}, output)


def linear_lookup(records, query, stats=None):
    for record in records:
        if stats is not None:
            stats['comparisons'] = stats.get('comparisons', 0) + 1
        if record['plate'] == query:
            return record['id']
    return None


def pair(task, workload, primary, baseline, verified):
    return {'task': task, 'workload': workload, 'primary': primary, 'baseline': baseline,
            'verified': verified,
            'speedup': baseline['median_ms'] / primary['median_ms'] if primary['median_ms'] else None}


def benchmark(store, size=1100, repeats=7, destination=0):
    if not 10 <= size <= 5000 or not 3 <= repeats <= 15:
        raise ValueError('Use 10–5,000 records and 3–15 repetitions.')
    rng = random.Random(206)
    epoch = datetime(2026, 10, 1, tzinfo=timezone.utc)
    records = [{'id': i, 'plate': f'BENCH{i:06}',
                'entry': (epoch + timedelta(seconds=rng.randrange(size // 2 + 1))).isoformat()}
               for i in range(size)]
    keys = [r['plate'] for r in records]
    queries = [keys[rng.randrange(size)] if i % 4 else f'MISSING{i}' for i in range(100)]
    with store.lock:
        store._validate_destination(destination)
        recommendation = store._assignment(destination)
        # A route comparison remains available when the lot is full: routing only, no assignment.
        slot = recommendation['slot'] if recommendation else next(s['id'] for s in store.slots.values() if s['floor'] == store.destinations[destination]['floor'])
        graph = store.graph
        start, goal = (0, 0, 4), store.slots[slot]['node']
        capacity, floor_count = len(store.slots), store.floor_count
    pairs = []
    a, a_output = measure(lambda: None, lambda _: astar(graph, start, goal), repeats)
    d, d_output = measure(lambda: None, lambda _: dijkstra(graph, start, goal), repeats)
    a.update(name='A*', complexity='O((V + E) log V)', work=a_output['expanded'], work_label='expanded nodes')
    d.update(name='Dijkstra', complexity='O((V + E) log V)', work=d_output['expanded'], work_label='expanded nodes')
    pairs.append(pair('Routing', f'Entrance → {slot}; {len(graph):,} nodes; same weighted graph', a, d,
                      a_output['distance'] == d_output['distance']))
    pairs[-1].update(slot=slot, distance=a_output['distance'], assignment_available=bool(recommendation))

    h, h_output = measure(lambda: {r['plate']: r['id'] for r in records},
                          lambda registry: [registry.get(q) for q in queries], repeats, len(queries))
    l, l_output = measure(lambda: records, lambda source: [linear_lookup(source, q) for q in queries], repeats, len(queries))
    linear_stats = {}
    for q in queries: linear_lookup(records, q, linear_stats)
    h.update(name='Hash table', complexity='Average O(1) per lookup', work=len(queries), work_label='dictionary lookups')
    l.update(name='Linear search', complexity='O(n) per lookup', work=linear_stats['comparisons'], work_label='plate comparisons')
    pairs.append(pair('Vehicle lookup', f'{size:,} records; same 100 queries (75 hits, 25 misses)', h, l, h_output == l_output))

    q, q_output = measure(lambda: FIFOQueue(keys), lambda queue: [queue.dequeue() for _ in range(size)], repeats, size)
    front, front_output = measure(lambda: list(keys), lambda queue: [queue.pop(0) for _ in range(size)], repeats, size)
    q.update(name='FIFO deque', complexity='O(1) per dequeue', work=size, work_label='dequeues')
    front.update(name='List front removal', complexity='O(n) per removal', work=size * (size - 1) // 2, work_label='shifted references (theoretical)')
    pairs.append(pair('Waiting queue', f'Drain the same {size:,}-vehicle queue; fresh queue per repetition', q, front, q_output == front_output))

    m, m_output = measure(lambda: records, lambda source: merge_sort(source, key=lambda r: r['entry']), repeats)
    i, i_output = measure(lambda: records, lambda source: insertion_sort(source, key=lambda r: r['entry']), repeats)
    merge_stats, insertion_stats = {}, {}
    merge_sort(records, key=lambda r: r['entry'], stats=merge_stats)
    insertion_sort(records, key=lambda r: r['entry'], stats=insertion_stats)
    m.update(name='Merge Sort', complexity='O(n log n)', work=merge_stats['comparisons'], work_label='key comparisons')
    i.update(name='Insertion Sort', complexity='O(n²)', work=insertion_stats['comparisons'], work_label='key comparisons')
    pairs.append(pair('History sorting', f'Same {size:,} shuffled visit records; stable full ordering', m, i,
                      m_output == i_output and all(m_output[j]['entry'] <= m_output[j+1]['entry'] for j in range(size-1))))
    clock = get_clock_info('perf_counter')
    return {'measured_at': datetime.now(timezone.utc).isoformat(),
            'environment': {'python': platform.python_version(), 'implementation': platform.python_implementation(),
                            'system': platform.system(), 'release': platform.release(), 'machine': platform.machine(),
                            'logical_cpus': os.cpu_count(), 'timer': 'perf_counter_ns',
                            'clock_resolution_ns': clock.resolution * 1_000_000_000,
                            'clock_monotonic': clock.monotonic},
            'graph': {'vertices': len(graph), 'undirected_edges': sum(len(neighbors) for neighbors in graph.values()) // 2,
                      'start': start, 'goal': goal},
            'size': size, 'repeats': repeats, 'destination': destination, 'capacity': capacity,
            'floors': floor_count, 'seed': 206, 'pairs': pairs,
            'methodology': 'Server perf_counter_ns; one warm-up; median of repeated runs. Input creation, instrumentation, validation, animation, database work and network time excluded. Compare within each task only. Synthetic lookup/queue/sort records do not modify the parking lot. Runtime is machine- and input-dependent; deque can lose on small inputs because Python method overhead is included.'}
