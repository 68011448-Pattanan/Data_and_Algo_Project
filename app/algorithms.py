"""Explicit course algorithms. Coordinates are illustrative five-meter units."""
from heapq import heappop, heappush
from itertools import count
from collections import deque


class FIFOQueue:
    """Deque-backed FIFO: enqueue/dequeue/front O(1); cancellation O(n)."""
    def __init__(self, items=()):
        self.items = deque(items)

    def enqueue(self, item):
        self.items.append(item)

    def dequeue(self):
        return self.items.popleft() if self.items else None

    def front(self):
        return self.items[0] if self.items else None

    def is_empty(self):
        return not self.items

    def remove(self, item):
        self.items.remove(item)

    def __iter__(self):
        return iter(self.items)

    def __len__(self):
        return len(self.items)


def merge_sort(items, key=lambda item: item, trace=None, stats=None):
    if len(items) < 2:
        return list(items)
    mid = len(items) // 2
    if trace is not None:
        trace.append({"operation": "divide", "values": [key(i) for i in items]})
    left = merge_sort(items[:mid], key, trace, stats)
    right = merge_sort(items[mid:], key, trace, stats)
    output, a, b = [], 0, 0
    while a < len(left) and b < len(right):
        if stats is not None:
            stats['comparisons'] = stats.get('comparisons', 0) + 1
        if key(left[a]) <= key(right[b]):
            output.append(left[a]); a += 1
        else:
            output.append(right[b]); b += 1
    output.extend(left[a:]); output.extend(right[b:])
    if trace is not None:
        trace.append({"operation": "merge", "values": [key(i) for i in output]})
    return output


def insertion_sort(items, key=lambda item: item, stats=None):
    """Stable explicit O(n²) baseline for the efficiency experiment."""
    output = list(items)
    for index in range(1, len(output)):
        value, position = output[index], index - 1
        while position >= 0:
            if stats is not None:
                stats['comparisons'] = stats.get('comparisons', 0) + 1
            if key(output[position]) <= key(value):
                break
            output[position + 1] = output[position]
            position -= 1
        output[position + 1] = value
    return output


def heuristic(a, b):
    return (40 * abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])) * 5


def astar(graph, start, goal, trace=False, use_heuristic=True):
    sequence = count()
    estimate = heuristic if use_heuristic else lambda a,b: 0
    frontier = [(estimate(start, goal), next(sequence), 0, start)]
    costs, previous, explored, steps = {start: 0}, {}, [], []
    while frontier:
        f, _, distance, current = heappop(frontier)
        if distance != costs[current]:
            continue
        explored.append(current)
        if trace:
            steps.append({"node": current, "g": distance, "h": estimate(current, goal),
                          "f": f, "open": len(frontier), "closed": len(explored),
                          "open_nodes": [entry[3] for entry in frontier]})
        if current == goal:
            path = [current]
            while current in previous:
                current = previous[current]
                path.append(current)
            return {"path": list(reversed(path)), "distance": distance,
                    "explored": explored, "steps": steps, "expanded": len(explored)}
        for neighbor, weight in graph.get(current, {}).items():
            candidate = distance + weight
            if candidate < costs.get(neighbor, float("inf")):
                costs[neighbor], previous[neighbor] = candidate, current
                heappush(frontier, (candidate + estimate(neighbor, goal), next(sequence), candidate, neighbor))
    return None


def dijkstra(graph, start, goal):
    """Same explicit priority-queue search with h(n)=0, for the optional lab comparison."""
    return astar(graph, start, goal, use_heuristic=False)


def build_layout(floors=3, bays=40):
    if not 1 <= floors <= 11 or not 4 <= bays <= 100 or floors * bays > 1100 or bays % 4:
        raise ValueError("Use 1–11 floors with 4–100 bays per floor, in multiples of four (maximum 1,100).")
    columns = bays // 4
    graph, slots = {}, {}
    def edge(a, b, weight=5):
        graph.setdefault(a, {})[b] = weight
        graph.setdefault(b, {})[a] = weight
    for floor in range(floors):
        for y in (0, 3, 4, 6, 9):
            for x in range(columns + 1):
                edge((floor, x, y), (floor, x + 1, y))
        for x in (0, columns + 1):
            for y in range(9):
                edge((floor, x, y), (floor, x, y + 1))
        for index in range(bays):
            row, col = divmod(index, columns)
            y, aisle = ((1, 0), (2, 3), (7, 6), (8, 9))[row]
            node = (floor, col + 1, y)
            edge(node, (floor, col + 1, aisle))
            sid = f"{chr(65 + floor)}-{index + 1:02}"
            slots[sid] = {"id": sid, "floor": floor, "zone": chr(65 + floor),
                          "index": index, "row": row, "column": col, "node": node,
                          "x": col + 1, "y": y}
        if floor:
            edge((floor - 1, 0, 4), (floor, 0, 4), 200)
    return graph, slots
