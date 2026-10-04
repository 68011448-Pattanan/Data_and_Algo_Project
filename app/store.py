"""Atomic parking operations, SQLite persistence, and a plate-keyed hash registry."""
import json
import math
import random
import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from time import perf_counter

from .algorithms import FIFOQueue, astar, build_layout, heuristic, merge_sort

BANGKOK = timezone(timedelta(hours=7))
DEFAULT_NAMES = ["Main entrance", "Department store", "Gourmet market", "Food court",
                 "Cinema", "Fashion avenue", "Family & kids", "Electronics", "Restaurants",
                 "Elevator A", "Staircase B"]


class ParkingError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def now():
    return datetime.now(timezone.utc)


def normalize_plate(value):
    plate = re.sub(r"[\s-]+", "", value.strip()).upper()
    if not 2 <= len(plate) <= 16 or not all(c.isalnum() for c in plate):
        raise ParkingError("Enter 2–16 letters or numbers. Thai plates, spaces and hyphens are accepted.")
    return plate


def fee_for(minutes, settings):
    billable = max(0, math.ceil(max(0, minutes) / 60) - settings["free_hours"])
    fee = 0 if billable == 0 else settings["first_hour"] + (billable - 1) * settings["additional_hour"]
    return {"billable_hours": billable, "fee": fee}


class ParkingStore:
    def __init__(self, path, floors=11, bays=100, seed=True):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.graph, self.slots = build_layout(floors, bays)
        self.floor_count, self.bays, self.columns = floors, bays, bays // 4
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
              id TEXT PRIMARY KEY, plate TEXT NOT NULL, destination INTEGER NOT NULL,
              slot TEXT, status TEXT NOT NULL, entry_time TEXT NOT NULL, parked_time TEXT,
              exit_time TEXT, fee REAL DEFAULT 0, is_demo INTEGER NOT NULL DEFAULT 0);
            CREATE UNIQUE INDEX IF NOT EXISTS active_plate ON sessions(plate)
              WHERE status IN ('assigned','parked','waiting');
            CREATE UNIQUE INDEX IF NOT EXISTS active_slot ON sessions(slot)
              WHERE status IN ('assigned','parked');
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS closed_slots (slot TEXT PRIMARY KEY, reason TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT,
              time TEXT NOT NULL, kind TEXT NOT NULL, plate TEXT, message TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY AUTOINCREMENT,
              time TEXT NOT NULL, slot TEXT, category TEXT NOT NULL, note TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'open');
        """)
        columns = {r['name'] for r in self.db.execute('PRAGMA table_info(sessions)')}
        if 'billable_hours' not in columns:
            self.db.execute('ALTER TABLE sessions ADD COLUMN billable_hours INTEGER DEFAULT 0')
            self.db.execute('ALTER TABLE sessions ADD COLUMN fee_policy TEXT')
        layout = self.db.execute("SELECT value FROM metadata WHERE key='layout'").fetchone()
        if layout and json.loads(layout[0]) != [floors, bays]:
            raise RuntimeError("Database layout differs. Choose a new PARKING_DB path for a different capacity.")
        self.db.execute("INSERT OR IGNORE INTO metadata VALUES ('layout',?)", (json.dumps([floors, bays]),))
        self.settings = {"mall_name": "The Mall · Bangkok", "free_hours": 2, "first_hour": 30,
                         "additional_hour": 20, "destinations": DEFAULT_NAMES}
        saved = self.db.execute("SELECT value FROM metadata WHERE key='settings'").fetchone()
        if saved:
            self.settings.update(json.loads(saved[0]))
        self.destinations = []
        for i, name in enumerate(self.settings["destinations"]):
            floor = i % floors
            x = self.columns + 1 if i in (0, 9, 10) else 1 + (i * 3) % self.columns
            self.destinations.append({"id": i, "name": name, "floor": floor,
                                      "node": (floor, x, 4), "type": "elevator" if i == 9 else "staircase" if i == 10 else "mall"})
        initialized = self.db.execute("SELECT 1 FROM metadata WHERE key='initialized'").fetchone()
        if seed and not initialized:
            self._seed()
        self.db.execute("INSERT OR IGNORE INTO metadata VALUES ('initialized','1')")
        self.db.commit()
        self._reload()

    def _reload(self):
        records = [dict(r) for r in self.db.execute("SELECT * FROM sessions WHERE status IN ('assigned','parked','waiting') ORDER BY entry_time,rowid")]
        self.active = {r["plate"]: r for r in records}  # Python dictionary = native hash table.
        self.occupied = {r["slot"]: r["plate"] for r in records if r["slot"]}
        self.waiting = FIFOQueue(r["plate"] for r in records if r["status"] == "waiting")
        self.disabled = {r["slot"]: r["reason"] for r in self.db.execute("SELECT * FROM closed_slots")}

    @contextmanager
    def transaction(self):
        with self.lock:
            try:
                with self.db:
                    yield
            except Exception:
                self._reload()
                raise

    def _event(self, kind, message, plate=None):
        self.db.execute("INSERT INTO events(time,kind,plate,message) VALUES (?,?,?,?)",
                        (now().isoformat(), kind, plate, message))

    def _insert(self, plate, destination, slot=None, demo=False, entry=None, status=None, exit_time=None):
        entry = entry or now().isoformat()
        status = status or ("assigned" if slot else "waiting")
        record = dict(id=uuid.uuid4().hex, plate=plate, destination=destination, slot=slot,
                      status=status, entry_time=entry, parked_time=entry if slot else None,
                      exit_time=exit_time, fee=0, is_demo=int(demo), billable_hours=0, fee_policy=None)
        if exit_time:
            record.update(fee_for((datetime.fromisoformat(exit_time)-datetime.fromisoformat(entry)).total_seconds()/60, self.settings))
            record['fee_policy'] = json.dumps(self.settings)
        self.db.execute("INSERT INTO sessions(id,plate,destination,slot,status,entry_time,parked_time,exit_time,fee,is_demo,billable_hours,fee_policy) VALUES (:id,:plate,:destination,:slot,:status,:entry_time,:parked_time,:exit_time,:fee,:is_demo,:billable_hours,:fee_policy)", record)
        return record

    def _seed(self):
        rng = random.Random(206)
        current = now()
        for floor in range(self.floor_count):
            bays = [s for s in self.slots.values() if s["floor"] == floor]
            for bay in rng.sample(bays, int(len(bays) * [0.75, 0.60, 0.425][floor % 3])):
                entry = (current - timedelta(minutes=rng.randint(15, 230))).isoformat()
                self._insert(f"{rng.choice(['กข','ขค','งจ'])}{floor}{bay['index']+1000}", floor % 11,
                             bay["id"], True, entry, "parked")
        all_bays = list(self.slots.values())
        # Non-overlapping historical uses of each bay; all seed visits have already ended.
        for day in range(30):
            for bay in rng.sample(all_bays, min(len(all_bays), 18 + day % 12)):
                end = current - timedelta(days=day, minutes=rng.randint(300, 700))
                start = end - timedelta(minutes=rng.randint(35, 220))
                self._insert(f"DEMO{day:02}{bay['index']:03}{bay['floor']}", (day + bay["index"]) % 11,
                             bay["id"], True, start.isoformat(), "exited", end.isoformat())
        self._event("system", "Demo dataset loaded · 30 days of illustrative mall visits")

    def _validate_destination(self, destination):
        if not isinstance(destination, int) or not 0 <= destination < len(self.destinations):
            raise ParkingError("Choose a valid mall destination.")

    def _assignment(self, destination):
        began = perf_counter()
        candidates = [s for s in self.slots.values() if s["id"] not in self.occupied and s["id"] not in self.disabled]
        best, explored = None, 0
        target = self.destinations[destination]["node"]
        candidates = merge_sort(candidates, key=lambda s: heuristic(s['node'], target))
        evaluated = 0
        for slot in candidates:
            # Manhattan + minimum ramp cost is a lower bound, never a route distance.
            if best is not None and heuristic(slot['node'], target) > best[0][0]:
                break
            evaluated += 1
            walk = astar(self.graph, slot["node"], target)
            drive = astar(self.graph, (0, 0, 4), slot["node"])
            if not walk or not drive:
                continue
            explored += walk["expanded"] + drive["expanded"]
            rank = (walk["distance"], drive["distance"], slot["index"], slot["floor"])
            if best is None or rank < best[0]:
                best = (rank, slot)
        if best is None:
            return None
        return {"slot": best[1]["id"], "walking_distance": best[0][0], "driving_distance": best[0][1],
                "candidates": len(candidates), "evaluated": evaluated, "nodes_explored": explored,
                "execution_ms": round((perf_counter() - began) * 1000, 2)}

    def _route(self, record):
        if not record["slot"]:
            return None
        node = self.slots[record["slot"]]["node"]
        return {"driving": astar(self.graph, (0, 0, 4), node, trace=True),
                "walking": astar(self.graph, node, self.destinations[record["destination"]]["node"], trace=True)}

    def _public(self, record, route=False):
        r = dict(record)
        r["destination_name"] = self.destinations[r["destination"]]["name"]
        r["floor"] = self.slots[r["slot"]]["floor"] if r["slot"] else None
        r["queue_position"] = list(self.waiting).index(r["plate"]) + 1 if r["status"] == "waiting" else None
        start = datetime.fromisoformat(r["parked_time"] or r["entry_time"])
        end = datetime.fromisoformat(r["exit_time"]) if r["exit_time"] else now()
        elapsed_minutes = max(0,(end-start).total_seconds()/60)
        r["duration_minutes"] = round(elapsed_minutes,1)
        estimate = fee_for(elapsed_minutes, self.settings) if r["status"] != "waiting" else {"billable_hours": 0, "fee": 0}
        r["billable_hours"] = r["billable_hours"] if r["status"] == "exited" else estimate["billable_hours"]
        r["estimated_fee"] = r["fee"] if r["status"] == "exited" else estimate["fee"]
        if route:
            r["route"] = self._route(r)
        return r

    def enter(self, plate, destination, demo=False):
        plate = normalize_plate(plate)
        with self.transaction():
            self._validate_destination(destination)
            if plate in self.active:
                raise ParkingError("This plate already has an active visit or queue entry.", 409)
            # Waiters always get first access to available bays.
            self._promote()
            assignment = self._assignment(destination) if self.waiting.is_empty() else None
            record = self._insert(plate, destination, assignment["slot"] if assignment else None, demo)
            self.active[plate] = record
            if assignment:
                self.occupied[record["slot"]] = plate
                self._event("assignment", f"{plate} assigned to {record['slot']}", plate)
            else:
                self.waiting.enqueue(plate)
                self._event("enqueue", f"{plate} joined the FIFO queue", plate)
            return {"vehicle": self._public(record, True), "algorithm": assignment}

    def confirm(self, plate):
        plate = normalize_plate(plate)
        with self.transaction():
            r = self.active.get(plate)
            if not r or r["status"] != "assigned":
                raise ParkingError("Only an assigned vehicle can confirm parking.", 409)
            self.db.execute("UPDATE sessions SET status='parked' WHERE id=?", (r["id"],))
            r["status"] = "parked"
            self._event("parked", f"{plate} confirmed parking in {r['slot']}", plate)
            return self._public(r, True)

    def _promote(self):
        promoted = []
        while not self.waiting.is_empty():
            plate = self.waiting.front()
            r = self.active[plate]
            assignment = self._assignment(r["destination"])
            if not assignment:
                break
            self.waiting.dequeue()
            r.update(slot=assignment["slot"], status="assigned", parked_time=now().isoformat())
            self.occupied[r["slot"]] = plate
            self.db.execute("UPDATE sessions SET slot=?,status='assigned',parked_time=? WHERE id=?",
                            (r["slot"], r["parked_time"], r["id"]))
            self._event("dequeue", f"{plate}: your bay {r['slot']} is ready. Follow your route and confirm parking.", plate)
            promoted.append(self._public(r, True))
        return promoted

    def exit(self, plate):
        plate = normalize_plate(plate)
        with self.transaction():
            r = self.active.get(plate)
            if not r:
                raise ParkingError("No active vehicle found for this plate.", 404)
            if r["status"] == "waiting":
                raise ParkingError("Cancel a waiting vehicle from the queue instead.", 409)
            exit_time = now().isoformat()
            cost = fee_for((datetime.fromisoformat(exit_time)-datetime.fromisoformat(r["parked_time"])).total_seconds()/60, self.settings)
            fee = cost['fee']
            policy = json.dumps(self.settings)
            self.db.execute("UPDATE sessions SET status='exited',exit_time=?,fee=?,billable_hours=?,fee_policy=? WHERE id=?", (exit_time, fee, cost['billable_hours'],policy,r["id"]))
            del self.occupied[r["slot"]]; del self.active[plate]
            r.update(status="exited", exit_time=exit_time, fee=fee,billable_hours=cost['billable_hours'],fee_policy=policy)
            self._event("exit", f"{plate} exited · ฿{fee:g} · {r['slot']} released", plate)
            promoted = self._promote()
            return {"receipt": self._public(r), "promoted": promoted, "rates": dict(self.settings)}

    def cancel(self, plate):
        plate = normalize_plate(plate)
        with self.transaction():
            r = self.active.get(plate)
            if not r or r["status"] != "waiting":
                raise ParkingError("No waiting vehicle found.", 404)
            self.db.execute("UPDATE sessions SET status='cancelled',exit_time=? WHERE id=?", (now().isoformat(), r["id"]))
            self.waiting.remove(plate); del self.active[plate]
            self._event("cancel", f"{plate} cancelled its queue entry", plate)
            return {"plate": plate}

    def find(self, plate):
        with self.lock:
            r = self.active.get(normalize_plate(plate))
            if not r:
                raise ParkingError("No active vehicle found. Check the plate or ask security.", 404)
            return self._public(r, True)

    def set_slot(self, slot, disabled, reason="Maintenance"):
        with self.transaction():
            if slot not in self.slots:
                raise ParkingError("Unknown bay.", 404)
            if slot in self.occupied:
                raise ParkingError("This bay has an active vehicle. Record its exit before closing it.", 409)
            if disabled:
                self.db.execute("INSERT OR REPLACE INTO closed_slots VALUES (?,?)", (slot, reason))
                self.disabled[slot] = reason
            else:
                self.db.execute("DELETE FROM closed_slots WHERE slot=?", (slot,))
                self.disabled.pop(slot, None)
            self._event("bay", f"{slot} {'closed: '+reason if disabled else 'reopened'}")
            return {"promoted": self._promote()}

    def slot_details(self, slot, destination=0):
        with self.lock:
            if slot not in self.slots: raise ParkingError('Unknown bay.',404)
            self._validate_destination(destination)
            distances = {}
            for d in self.destinations:
                route = astar(self.graph,self.slots[slot]['node'],d['node'])
                distances[str(d['id'])] = route['distance'] if route else None
            reachable = {name:distance for name,distance in distances.items() if distance is not None}
            today=now().astimezone(BANGKOK).date().isoformat()
            uses=self.db.execute("SELECT COUNT(*) FROM sessions WHERE slot=? AND date(parked_time,'+7 hours')=?",(slot,today)).fetchone()[0]
            return dict(self.slots[slot],distance_to_destinations=distances,
                        nearest_destination=self.destinations[int(min(reachable,key=reachable.get))]['name'] if reachable else None,
                        selected_destination=self.destinations[destination]['name'],
                        selected_distance=distances[str(destination)],uses_today=uses)

    def update_settings(self, values):
        with self.transaction():
            names = values.get("destinations", self.settings["destinations"])
            if len(names) != 11 or any(not n.strip() or len(n) > 60 for n in names):
                raise ParkingError("Provide 11 destination names, each 1–60 characters.")
            self.settings.update(values)
            self.db.execute("INSERT OR REPLACE INTO metadata VALUES ('settings',?)", (json.dumps(self.settings, ensure_ascii=False),))
            for d, name in zip(self.destinations, names):
                d["name"] = name
            self._event("settings", "Mall display name, fee policy and destination labels updated")
            return self.settings

    def history(self, order="desc", query=""):
        with self.lock:
            query = re.sub(r"[\s-]+", "", query).upper()
            records = [dict(r) for r in self.db.execute("SELECT * FROM sessions WHERE status IN ('exited','cancelled')") if query in r["plate"]]
            result = merge_sort(records, key=lambda r: r["entry_time"])
            if order == "desc": result.reverse()
            return [self._public(r) for r in result]

    def state(self):
        with self.lock:
            uses = {r["slot"]: r["n"] for r in self.db.execute("SELECT slot,COUNT(*) n FROM sessions WHERE slot IS NOT NULL GROUP BY slot")}
            floors = []
            for floor in range(self.floor_count):
                bays = []
                for s in self.slots.values():
                    if s["floor"] != floor: continue
                    plate = self.occupied.get(s["id"])
                    bays.append(dict(s, plate=plate, status=self.active[plate]["status"] if plate else "disabled" if s["id"] in self.disabled else "available",
                                     reason=self.disabled.get(s["id"]), usage_count=uses.get(s["id"], 0)))
                count_used = sum(s["plate"] is not None for s in bays)
                count_closed = sum(s["status"] == "disabled" for s in bays)
                floors.append({"id": floor, "name": ["B1", "G", "L1"][floor] if floor < 3 else f"L{floor-1}",
                               "zone": chr(65+floor), "capacity": len(bays), "occupied": count_used,
                               "disabled": count_closed, "available": len(bays)-count_used-count_closed, "slots": bays})
            today = now().astimezone(BANGKOK).date().isoformat()
            today_rows = [dict(r) for r in self.db.execute("SELECT * FROM sessions WHERE date(entry_time,'+7 hours')=?", (today,))]
            completed = [dict(r) for r in self.db.execute("SELECT * FROM sessions WHERE status='exited' AND date(exit_time,'+7 hours')=?", (today,))]
            durations = [self._public(r)["duration_minutes"] for r in completed]
            return {"floors": floors, "columns": self.columns, "destinations": self.destinations, "settings": self.settings,
                    "capacity": len(self.slots), "occupied": len(self.occupied), "disabled": len(self.disabled),
                    "available": len(self.slots)-len(self.occupied)-len(self.disabled), "waiting_count": len(self.waiting),
                    "vehicles_today": len(today_rows), "revenue_today": sum(r["fee"] for r in completed),
                    "average_duration": round(sum(durations)/len(durations), 1) if durations else 0,
                    "turnover_today": round(len(completed)/len(self.slots), 2),
                    "vehicles": [self._public(r) for r in self.active.values()],
                    "queue": [self._public(self.active[p]) for p in self.waiting],
                    "events": [dict(r) for r in self.db.execute("SELECT * FROM events ORDER BY id DESC LIMIT 25")],
                    "incidents": [dict(r) for r in self.db.execute("SELECT * FROM incidents ORDER BY id DESC LIMIT 100")],
                    "updated_at": now().isoformat()}

    def analytics(self, days=1, start=None, end=None):
        with self.lock:
            current = now().astimezone(BANGKOK)
            try:
                beginning = datetime.fromisoformat(start).replace(tzinfo=BANGKOK) if start else current.replace(hour=0,minute=0,second=0,microsecond=0)-timedelta(days=days-1)
                ending = datetime.fromisoformat(end).replace(tzinfo=BANGKOK)+timedelta(days=1) if end else current
            except ValueError:
                raise ParkingError("Use valid YYYY-MM-DD dates.")
            ending = min(ending, current)
            if beginning > ending or (ending-beginning).days > 365:
                raise ParkingError("Choose a past date range up to 365 days.")
            records = [dict(r) for r in self.db.execute("SELECT * FROM sessions")]
            entered = [r for r in records if beginning <= datetime.fromisoformat(r["entry_time"]) <= ending]
            assigned = [r for r in records if r['parked_time'] and beginning <= datetime.fromisoformat(r['parked_time']) <= ending]
            exits = [r for r in records if r["status"] == "exited" and beginning <= datetime.fromisoformat(r["exit_time"]) <= ending]
            hours = [{"hour": h, "entries": 0, "exits": 0, "occupancy": 0} for h in range(24)]
            for r in entered: hours[datetime.fromisoformat(r["entry_time"]).astimezone(BANGKOK).hour]["entries"] += 1
            for r in exits: hours[datetime.fromisoformat(r["exit_time"]).astimezone(BANGKOK).hour]["exits"] += 1
            samples = [0]*24
            day = beginning.replace(hour=0,minute=0,second=0,microsecond=0)
            while day <= ending:
                for h in range(24):
                    point = day + timedelta(hours=h)
                    if not beginning <= point <= ending: continue
                    hours[h]["occupancy"] += sum(bool(r['parked_time']) and datetime.fromisoformat(r["parked_time"]) <= point and (not r["exit_time"] or datetime.fromisoformat(r["exit_time"]) > point) for r in records)
                    samples[h] += 1
                day += timedelta(days=1)
            for h, sample in zip(hours, samples):
                h["occupancy"] = round(h["occupancy"]/sample, 1) if sample else None
            distribution = [0]*4
            usage = {}
            for r in assigned:
                usage[r["slot"]] = usage.get(r["slot"], 0) + 1
            for r in exits:
                mins = self._public(r)["duration_minutes"]
                distribution[0 if mins < 60 else 1 if mins < 120 else 2 if mins < 240 else 3] += 1
            ranked = merge_sort([{"slot": s, "uses": n, "average_minutes": round(sum(self._public(r)["duration_minutes"] for r in exits if r["slot"] == s)/max(1,sum(r["slot"] == s for r in exits)),1)} for s,n in usage.items()], key=lambda r: -r["uses"])
            measured = [h for h in hours if h["occupancy"] is not None]
            peak = max(measured, key=lambda h: h["occupancy"]) if measured else None
            return {"hours": hours, "distribution": distribution, "top_slots": ranked[:8], "usage": usage,
                    "entries": len(entered), "assignments":len(assigned), "exits": len(exits), "revenue": sum(r["fee"] for r in exits),
                    "peak": peak, "average_occupancy": round(sum(h["occupancy"] for h in measured)/max(1,len(measured)),1),
                    "arrival_rate": round(len(entered)/max(1,(ending-beginning).total_seconds()/3600),1),
                    "range_start": beginning.isoformat(), "range_end": ending.isoformat()}

    def incident(self, slot, category, note):
        with self.transaction():
            if slot and slot not in self.slots: raise ParkingError("Unknown bay.")
            self.db.execute("INSERT INTO incidents(time,slot,category,note) VALUES (?,?,?,?)", (now().isoformat(),slot,category,note))
            self._event("incident", f"Security report: {category} · {slot or 'general'}")
            return {"message": "Incident logged"}

    def resolve(self, incident_id):
        with self.transaction():
            row = self.db.execute("UPDATE incidents SET status='resolved' WHERE id=?", (incident_id,))
            if not row.rowcount: raise ParkingError("Incident not found.",404)
            return {"message": "Incident resolved"}

    def simulate(self, action, count=10):
        with self.lock:
            if action in ("entry","generate","queue"):
                if action == "queue": self.simulate("fill")
                results = []
                for _ in range(1 if action == "entry" else 3 if action == "queue" else count):
                    results.append(self.enter(f"SIM{uuid.uuid4().hex[:8].upper()}", random.randrange(11), True))
                return {"message": f"Generated {len(results)} demo arrivals", "vehicle": results[-1]["vehicle"], "algorithm": results[-1]["algorithm"]}
            if action == "exit":
                if not self.occupied: raise ParkingError("No vehicles to exit.")
                return self.exit(next(iter(self.occupied.values())))
            with self.transaction():
                if action == "fill":
                    self._promote()
                    for s in self.slots.values():
                        if s["id"] in self.occupied or s["id"] in self.disabled: continue
                        r = self._insert(f"SIM{uuid.uuid4().hex[:8].upper()}", s["floor"] % 11, s["id"], True, status="parked")
                        self.active[r["plate"]] = r; self.occupied[s["id"]] = r["plate"]
                    self._event("simulation", "All open bays filled with demo vehicles")
                elif action in ("clear","reset"):
                    self.db.execute("DELETE FROM sessions WHERE is_demo=1")
                    self._reload()
                    if action == "reset":
                        # Seed only unoccupied bays and historical demo records in a temporary store.
                        temp = ParkingStore(":memory:", self.floor_count, self.bays, seed=True)
                        for row in temp.db.execute("SELECT * FROM sessions"):
                            r = dict(row)
                            if r["status"] == "parked" and (r["slot"] in self.occupied or r["slot"] in self.disabled or r['plate'] in self.active): continue
                            self.db.execute("INSERT INTO sessions(id,plate,destination,slot,status,entry_time,parked_time,exit_time,fee,is_demo,billable_hours,fee_policy) VALUES (:id,:plate,:destination,:slot,:status,:entry_time,:parked_time,:exit_time,:fee,:is_demo,:billable_hours,:fee_policy)", r)
                        temp.close(); self._reload()
                    self._promote()
                    self._event("simulation", "Demo records reset" if action == "reset" else "Demo records cleared; manual records preserved")
                else: raise ParkingError("Unknown simulation action.")
                return {"message": "Simulation complete · manual records preserved"}

    def close(self):
        self.db.close()
