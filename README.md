# Parkside — Mall Parking, Version 2

A working parking-management website for mall visitors, administrators and security. Built from the supplied DS & Algorithms proposal and master prompt, adapted to a mall such as Siam Paragon or Mega Bangna. **The default capacity is 1,100 parking bays across 11 floors, 100 bays per floor.** Layouts, distances, destination names and prices are illustrative, not official mall data.

The project uses FastAPI, Python, SQLite and a responsive HTML/CSS/JavaScript frontend. This follows Version 1's existing stack; the prompt's suggested Next.js stack is optional. There is no frontend build step and no external hardware dependency.

## Start

From this folder in PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8002
```

Open **http://localhost:8002**. API documentation: **http://localhost:8002/docs**.

Alternatively, run `./start.ps1` in a PowerShell session that allows local scripts. The script creates the environment, installs requirements and launches the service.

Docker Desktop alternative:

```powershell
docker compose -f docker.yaml up --build -d
docker compose -f docker.yaml down
```

The Docker named volume retains the database. Local storage is `data/parking.sqlite3`. Use exactly **one backend worker**. `Version 1` is preserved and uses a separate database.

## Stakeholder views

Select the view from the top-right dropdown:

* **Mall visitor:** enter a plate, choose a destination, get a bay and route, confirm parking, find a car, check availability and queue position.
* **Mall administrator:** view capacity and revenue, inspect all floors, manage active visits and history, analyze demand, change fees and labels, run simulations and demonstrate algorithms.
* **Security staff:** register arrivals, simulate plate detection, verify parking, record exits and fee receipts, locate vehicles, close/reopen free bays, log incidents and resolve reports.

These views demonstrate stakeholder workflows. They are not authenticated roles or API access controls. The app is bound to localhost by default.

## Complete presentation scenario

1. In Settings, optionally change the mall name and destination labels. Fees default to two free hours, THB 30 for the first billed hour and THB 20 per additional billed hour.
2. Switch to Mall visitor. Enter `ABC-1234`, choose a destination such as Cinema, and select **Find my parking bay**. A* chooses a currently free bay near the destination. The precise ID depends on state.
3. Follow the route. Floor tabs show the computed path segments; cross-floor travel uses connected ramps. Select **Confirm parking**.
4. Use Find my car with `ABC-1234` to retrieve its location, entry time, duration, fee estimate and route.
5. Switch to Mall administrator. Open **Simulation tools → Fill all 1,100 bays**. Closed bays remain closed; manually registered vehicles remain intact.
6. Switch to Mall visitor. Register `XYZ-5678`; it receives FIFO position #1. Register additional plates to demonstrate queue order.
7. Switch to Security staff. Record an exit for `ABC-1234`. A receipt shows duration and fee; the oldest waiter receives the released bay atomically.
8. Inspect Waiting queue and the event stream. Return to Find my car for `XYZ-5678` and confirm its assigned bay.
9. Open Parking history. Change the direction or filter by plate. Ordering uses explicit Merge Sort.
10. Open Algorithm lab. Run/animate A*, animate Merge Sort and compare A* with Dijkstra on the same entrance-to-bay example.
11. Open Analytics. Explore Today, 7 days, 30 days or a custom date range, occupancy, entries/exits, duration and usage heatmap.
12. Open Presentation for the 12-step guided walkthrough. Previous, Next and Fullscreen controls are provided.

The prompt's 20-bay/A-17 example is adapted to the user's requested 1,100-bay layout. Bay assignment always follows the algorithm and current availability; it does not force a predetermined bay ID.

## Architecture

```text
Visitor / Admin / Security frontend
                |
         FastAPI parking engine
          /        |        \
 Plate hash map    A*     FIFO queue
          \        |        /
         Atomic SQLite transactions
          /                 \
 Historical visits       Events, bays, settings, incidents
        |
 Explicit Merge Sort + source-backed analytics
```

`ParkingStore.active` is a native Python dictionary keyed by normalized plate. A `threading.RLock` serializes all state mutations. SQLite transactions and partial unique indexes enforce one active plate per visit and one active vehicle per bay. In-memory hash maps and FIFO order rebuild from persisted state after restart or a failed transaction.

States: `available → assigned → parked → available` for a bay; a full/unreachable lot creates a `waiting` visit. Exit is also allowed for an assigned vehicle that leaves before parking confirmation. Cancellation applies to waiting visits. Closing an occupied/assigned bay is rejected. Opening a bay and exiting a vehicle both serve waiters before new arrivals.

## Graph and A*

Each floor has four rows of 25 bays. Bays attach as leaf nodes to access aisles, so paths cannot cross through bays. Aisles are bidirectional and adjacent floors connect at their ramp. The proposal's conceptual map is rebuilt interactively rather than embedded as an image.

Coordinates are illustrative five-meter units; each adjacent-floor ramp costs 200 m. The heuristic is:

```text
h(a,b) = 200 × |floor difference| + 5 × (|x difference| + |y difference|)
```

This is admissible and consistent for the configured weighted graph. A* uses an explicit priority queue, predecessor map and cost relaxation. Its trace contains node coordinates, g/h/f, open heap nodes, explored nodes and the final path. The UI reports per-search expansion counts; recommendation metrics include candidate searches as well.

Proximity means **bay to selected destination**, never car to car. Candidates are ranked by actual shortest walking-route distance, then entrance driving distance, bay index and floor. A heuristic lower bound prunes candidates only when they cannot improve the best walking distance. The route to the assigned bay is a separate A* search. Both distances honor actual graph connections. The walking graph shares demonstration aisle/ramp connectivity; production pedestrian routing requires a surveyed separate graph.

One heap-based A* search is O((V + E) log V) with O(V + E) auxiliary heap/map storage in this consistent-heuristic implementation. Recommendation may run several searches, so its total cost also depends on the candidate count. The optional Dijkstra comparison uses the same explicit search with h(n)=0. A* remains primary.

## Other data structures and algorithms

* **Hash table:** insert/search/update/delete active plate records. Average O(1), worst-case O(n), space O(n). Plate normalization accepts Unicode letters/digits, strips spaces/hyphens and uppercases Latin letters.
* **FIFOQueue:** explicit `enqueue`, `dequeue`, `front`, `is_empty` operations backed by a deque. Enqueue/dequeue/front O(1), space O(n); cancelling a middle entry is O(n).
* **Merge Sort:** manually implemented stable recursive divide/merge, O(n log n) time and O(n) extra space. History compares full entry timestamps; the lab shows a trace of eight actual records. No library sort substitutes for this algorithm.

## Fees and time

Dates are persisted in UTC and displayed/calculated with Asia/Bangkok day boundaries. Parking duration and fees begin at bay assignment (`parked_time`); time in the queue is excluded. Confirmation updates status without resetting the fee clock. Partial hours round upward after subtracting free hours.

```text
billable_hours = max(0, ceil(parking_minutes / 60) − free_hours)
fee = 0, if billable_hours = 0
fee = first_hour + (billable_hours − 1) × additional_hour, otherwise
```

Exit stores the calculated fee, billable hours and fee policy. Later settings changes do not change stored receipts. Active estimates use current settings. No payment is collected.

## Analytics and simulation

First startup seeds deterministic demo bay occupancy plus 30 days of completed visits. Demo vehicles are labeled. Dashboard numbers come from current records, not static mock figures. Data is retained across refreshes/restarts.

Charts reconstruct occupied/assigned bay counts at Bangkok hour boundaries from visit intervals. For multi-day ranges, each hour is the average of observed samples for that clock hour; future hours are omitted. These are hourly samples, not a second-by-second peak. Occupancy percentages use physical capacity, with closed bays reported separately.

Analytics include completed revenue, entry/exit totals, duration bands, arrivals per hour (including waiting visitors), assignment heatmap, top bays, average completed duration and uses per day. Heatmap counts assignments in the selected period; top-bay durations use only completed visits. The dashboard's average turnover is today's completed visits divided by physical bays. Interpret demand using the exact definitions in the UI; correlation with proximity is not a causal claim.

Simulation offers single entry/exit, 10/100 arrivals, fill, create queue, clear demo records and reset the dataset. Clear/reset preserves manual visits, settings, incidents and bay closures. Reset historical seed visits are generated at the reset time. Notifications are local in-app events and queue status polls every five seconds while the page is open.

## Folder structure

```text
app/algorithms.py     A*, Dijkstra comparison, Merge Sort, FIFOQueue, graph
app/store.py          State transitions, persistence, fees, simulation, analytics
app/main.py           Validated REST API, frontend serving
static/index.html     Application shell
static/styles.css     Responsive layout and map styling
static/app.js         Stakeholder workflows, SVG maps/charts, animations
tests/test_parking.py Algorithm, transaction, concurrency and API checks
data/                 Runtime SQLite database (ignored by Git)
start.ps1             Windows launcher
Dockerfile            Container build
docker.yaml           Local service with persistent volume
REQUIREMENTS.md        Coverage and prototype limitations
```

## Test

```powershell
.\.venv\Scripts\python -m pip install -r requirements-dev.txt
.\.venv\Scripts\python -m unittest discover -s tests -v
node --check static/app.js
docker compose -f docker.yaml config --quiet
```

Automated checks cover 11 × 100 capacity, A* against independently implemented Dijkstra distances, disconnected paths, Merge Sort stability/trace, fee boundaries, Thai plates, assignment/confirmation/exit, cross-floor fallback, FIFO promotion, cancellation, duplicates, closures/reopening, persistence, concurrent arrivals, rollback, settings, analytics and API validation. Browser validation details are in `REQUIREMENTS.md`.

## Configuration and scope

Environment variables: `PARKING_DB` (database path), `SEED_DEMO` (`true`/`false`, first creation only), `PARKING_FLOORS` (default 11), `BAYS_PER_FLOOR` (default 100, multiple of four, max 100). Maximum capacity is 1,100. If changing capacity, choose a new database path; persisted layout mismatches fail explicitly.

The local prototype has no production identity/authentication, actual mall plans, camera OCR, sensors, SMS, remote notifications, payment processing or multi-server synchronization. Production improvements include verified floor/pedestrian graphs, one-way traffic rules, authenticated permissions, privacy and retention controls, sensor integration, payment integration, live push notifications and multi-worker database-backed coordination. Fonts use Google Fonts when reachable and system fallbacks otherwise. Application operations require only this local backend.
