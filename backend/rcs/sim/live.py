"""The live engine behind the digital twin.

Trucks are agents that move along tracks at simulated time. Every position, colour and route comes from here. Each
decision comes from rcs.domain.decision, each token from the registry and each sensor reading from the site state below,
so a sensor fault, an outage, a policy change or a revocation changes what happens to the next truck.

Scale errors and service times come from the same SimConfig that L1 and L2 use. Queues form because tracks have
finite gaps and bays have finite capacity, so spillback onto the mainline is emergent, not scripted.
"""
from __future__ import annotations

import math
import random
import threading
import time
import uuid
from bisect import insort
from collections import Counter, defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from ..db import write_behind
from ..domain import decision as D
from ..domain.tokens import b64u, canonical_json
from ..domain.vehicle import axle_count, gross_limit_for, group_loads, groups_for, make_container
from ..models import Alert as AlertRow
from ..models import ClearanceEvent, OfficerCase
from ..services.adapters import adapters
from ..services.bus import EventBus
from ..services.registry import Registry
from .l2_process import arrival_profile
from .network import EDGES, PLAZAS, ROUTE_DEST, ROUTES, Polyline
from .params import SimConfig

EAT = timezone(timedelta(hours=3))
STATE_CODE = {"NEUTRAL": 0, "GREEN": 1, "AMBER": 2, "RED": 3}
OFFICER_DELAY_MIN = 12.0  # the simulated duty officer's review time; a human can act first in the KeNHA portal
CORRECTIVE_MIN = 25.0
TRIM_MIN = 15.0
SYNC_EVENTS_PER_SIM_S = 4.0
SAMPLE_BINS = 96


SENSOR_TEMPLATES = {
    "road": [
        ("wim", "Quartz piezo WIM rows (3, staggered)", "wim", 8.0, "kN"),
        ("loops", "Speed and presence loops", "loop", 1.0, "km/h"),
        ("pavement_temp", "Pavement temperature probe", "temperature", 0.001, "C"),
        ("ambient", "Ambient temperature and humidity logger", "temperature", 0.001, "C"),
        ("anpr", "ANPR cameras, tractor and trailer", "camera", None, "conf"),
        ("rfid", "UHF RFID reader (EPC Gen2)", "rfid", None, "dBm"),
        ("lidar", "Overhead LiDAR dimension portal", "lidar", None, "m"),
        ("adc", "Charge amplifier, ADC and conditioning", "adc", 8.0, "V"),
        ("edge", "Edge computing unit", "edge", None, "ms"),
        ("ups", "UPS and backup power", "power", None, "%"),
        ("network", "Cloud link", "network", None, "ms"),
        ("lane_scale", "Lane per-wheel scales", "wim", 5.0, "kN"),
        ("lane_lidar", "Lane side and overhead LiDAR", "lidar", None, "m"),
        ("lane_anpr", "Lane ANPR cameras", "camera", None, "conf"),
        ("lane_rfid", "Lane RFID reader", "rfid", None, "dBm"),
        ("static_scale", "Static weighbridge decks", "scale", None, "kg"),
    ],
    "port": [
        ("port_scale", "Low-speed gate-out scale", "wim", 5.0, "kN"),
        ("anpr", "ANPR cameras, tractor and trailer", "camera", None, "conf"),
        ("rfid", "UHF RFID reader (EPC Gen2)", "rfid", None, "dBm"),
        ("ocr", "Container number OCR", "camera", None, "conf"),
        ("lidar", "LiDAR dimension portal", "lidar", None, "m"),
        ("pavement_temp", "Pavement temperature probe", "temperature", 0.001, "C"),
        ("adc", "Charge amplifier, ADC and conditioning", "adc", 5.0, "V"),
        ("edge", "Edge computing unit", "edge", None, "ms"),
        ("ups", "UPS and backup power", "power", None, "%"),
        ("network", "Cloud link", "network", None, "ms"),
        ("static_scale", "Port re-weigh decks", "scale", None, "kg"),
    ],
    "origin": [
        ("origin_scale", "Approved loading-site scale", "scale", None, "kg"),
        ("anpr", "ANPR camera", "camera", None, "conf"),
        ("rfid", "UHF RFID reader", "rfid", None, "dBm"),
        ("edge", "Site gateway", "edge", None, "ms"),
        ("network", "Cloud link", "network", None, "ms"),
    ],
}


@dataclass
class Sensor:
    id: str
    name: str
    kind: str
    sampling_khz: float | None
    unit: str
    status: str = "ok"  # ok | fault | disabled
    quality: float = 0.97
    drift_pct: float = 0.0
    temperature_c: float = 31.0
    latency_ms: float = 4.0
    value: float = 0.0
    last_ok: datetime | None = None
    comm_ok: bool = True
    drift_alerted: bool = False
    calibration_due: datetime | None = None


class Track:
    __slots__ = ("id", "line", "rate", "gap", "trucks", "lanes", "on_end", "plaza")

    def __init__(self, id: str, line: Polyline, rate: float, gap: float, lanes: int = 1, on_end: str | None = None, plaza: "Plaza | None" = None):
        self.id = id
        self.line = line
        self.rate = rate
        self.gap = gap
        self.trucks: list[Truck] = []  # front-first
        self.lanes = lanes
        self.on_end = on_end
        self.plaza = plaza

    def can_enter(self, s: float = 0.0) -> bool:
        if not self.trucks:
            return True
        for t in self.trucks:
            if abs(t.s - s) < self.gap:
                return False
        return True

    def enter(self, truck: "Truck", s: float = 0.0) -> None:
        truck.track = self
        truck.s = s
        # keep the list sorted front-first
        i = 0
        while i < len(self.trucks) and self.trucks[i].s > s:
            i += 1
        self.trucks.insert(i, truck)


@dataclass
class Truck:
    id: str
    plate: str
    trailer: str | None
    rfid: str | None
    stream: str
    config: str
    route: str
    plan: list[str]
    enrolled: bool
    tractor_tare: float
    trailer_tare: float
    height: float
    width: float
    length: float
    fleet: str | None
    fleet_id: int | None
    driver: str | None
    ratio: float = 0.0
    axles: list[float] = field(default_factory=list)
    container: str | None = None
    eseal: str | None = None
    container_tare: float = 0.0
    declared_cargo: float | None = None
    release: dict | None = None
    misdeclared: bool = False
    fraud_gain: float = 0.0
    lifted: bool = False
    sealed: bool = False
    permit: str | None = None
    demerits: int = 0
    plan_i: int = 0
    track: Track | None = None
    s: float = 0.0
    state: str = "NEUTRAL"
    mode: str = "road"  # road | lane | static | held | bay
    plaza_id: str | None = None
    token_id: str | None = None
    token_status: str = "NONE"
    decision: str = "PENDING"
    decision_text: str = ""
    entered_at: datetime | None = None
    delay_s: float = 0.0
    shadow_delay_s: float = 0.0
    side_entered: datetime | None = None
    first_station_done: bool = False
    was_red: bool = False
    was_diverted: bool = False
    had_static: bool = False
    dwell: float = 0.0
    bay_i: int = -1
    hold_until: datetime | None = None
    hold_case: str | None = None
    hold_next: str | None = None
    lane_offset: float = 0.0
    hero: bool = False
    exact: bool = False
    force_audit: set[str] = field(default_factory=set)
    no_read: set[str] = field(default_factory=set)
    add_load_after_token: float = 0.0
    last_gross: float | None = None
    history: list[dict] = field(default_factory=list)
    source_tag: str | None = None
    destination: str | None = None

    def __lt__(self, other: "Truck") -> bool:
        return self.id < other.id

    @property
    def gross(self) -> float:
        return sum(self.axles)

    def next_destination(self) -> str:
        for step in self.plan[self.plan_i :]:
            if step.startswith("@"):
                return PLAZAS[step[1:]].name
        return ROUTE_DEST.get(self.route, "Corridor exit")


class Plaza:
    """Runtime instance of a site: tracks, bays, sensors, link state and local outbox."""

    def __init__(self, geom, cfg: SimConfig):
        self.id = geom.id
        self.name = geom.name
        self.kind = geom.kind
        self.geom = geom
        self.sensors: dict[str, Sensor] = {}
        for sid, name, kind, khz, unit in SENSOR_TEMPLATES[geom.kind]:
            self.sensors[sid] = Sensor(sid, name, kind, khz, unit)
        self.tracks: dict[str, Track] = {}
        self.bays: list[Truck | None] = [None] * geom.bays
        self.bay_tracks: list[Polyline] = geom.bay_tracks
        self.held: list[Truck] = []
        self.link_up = True
        self.link_down_since: datetime | None = None
        self.outbox: deque = deque()
        self.syncing = False
        self.sync_started: datetime | None = None
        self.sync_backlog = 0
        self.last_recovery_s: float | None = None
        self.scheduled_restore: datetime | None = None
        self.lane_open = geom.has_lane
        self.seq = 0
        self.downtime_s = 0.0
        self.edge_downtime_s = 0.0
        self.alive_s = 0.0
        # Rolling stats
        self.decisions = Counter()
        self.processed = 0
        self.lane_passes = deque(maxlen=800)
        self.lane_times = deque(maxlen=200)
        self.static_times = deque(maxlen=200)
        self.static_visits = 0
        self.lane_visits = 0
        self.bay_busy_s = 0.0
        self.zone_busy_s = 0.0
        self.queue_samples = deque(maxlen=120)
        self.last_gantry = "GREEN"
        self.last_gantry_at = 0.0
        self.last_lane_result: dict | None = None
        self.current_lane_truck: str | None = None
        self.audits = 0
        self.audit_abs_err: deque = deque(maxlen=200)
        self.suspended = False
        self.scale_approved = True
        self.calibration_valid = True
        self.reset_tracks(cfg)

    def reset_tracks(self, cfg: SimConfig) -> None:
        g = self.geom
        self.tracks.clear()
        low = 5.0 if self.kind in ("port", "origin") else 9.0
        for key in ("approach", "to_gantry", "main_out", "merge"):
            self.tracks[key] = Track(f"{self.id}.{key}", g.tracks[key], low if key in ("approach", "to_gantry") else 9.0, 19.0, on_end=key, plaza=self)
        if g.has_lane:
            total = g.tracks["lane_approach"].length + g.tracks["lane_zone"].length + g.tracks["lane_exit"].length
            rate = total / (cfg.lane_pass_min * 60.0)
            gap = max(8.0, rate * cfg.lane_service_s())
            for key in ("lane_approach", "lane_zone", "lane_exit"):
                self.tracks[key] = Track(f"{self.id}.{key}", g.tracks[key], rate, gap, on_end=key, plaza=self)
        self.tracks["queue"] = Track(f"{self.id}.queue", g.tracks["queue"], 5.0, 19.0, on_end="queue", plaza=self)
        col = g.tracks["collector"]
        self.tracks["collector"] = Track(f"{self.id}.collector", col, col.length / max(20.0, cfg.stop_overhead_min * 60.0), 10.0, on_end="collector", plaza=self)
        self.bays = [None] * g.bays

    def sensor_ok(self, sid: str) -> bool:
        s = self.sensors.get(sid)
        return s is not None and s.status == "ok"

    @property
    def edge_up(self) -> bool:
        return self.sensor_ok("edge")

    @property
    def lane_queue(self) -> int:
        t = self.tracks.get("lane_approach")
        return len(t.trucks) if t else 0

    @property
    def static_queue(self) -> int:
        return len(self.tracks["queue"].trucks)

    @property
    def mainline_queue(self) -> int:
        return sum(1 for t in self.tracks["approach"].trucks if t.s >= self.tracks["approach"].line.length - 2) + 0


class LiveEngine:
    def __init__(self, cfg: SimConfig | None = None, seed: int = 42, registry: Registry | None = None, persist: bool = True, vehicles: list[dict] | None = None):
        self.lock = threading.RLock()
        self.cfg = cfg or SimConfig()
        self.policy = self.cfg.policy()
        self.rng = random.Random(seed)
        self.seed = seed
        self.persist = persist
        self.registry = registry or Registry(persist=persist)
        self.bus = EventBus()
        self.vehicles: dict[str, dict] = {}
        self.idle: deque = deque()
        if vehicles:
            self.load_vehicles(vehicles)
        self.running = False
        self.paused = False
        self.speed = 20.0
        self.saved_speed: float | None = None
        self.registry_down = False
        self.events_out: deque = deque(maxlen=400)
        self.alerts_out: deque = deque(maxlen=100)
        self.alert_seen: dict[str, datetime] = {}
        self.recent_events: deque = deque(maxlen=120)
        self.recent_alerts: deque = deque(maxlen=60)
        self.fleet_mismatches: Counter = Counter()
        self.scenario: dict | None = None
        self.scenario_hook = None
        self._counter = 0
        self.last_step_ms = 0.0
        self.boot_wall = time.time()
        self.reset()

    # ------------------------------------------------------------------ lifecycle
    def set_calibration(self, due_by_site: dict) -> None:
        with self.lock:
            self.calibration_due = dict(due_by_site)
            self._apply_calibration()

    def _apply_calibration(self) -> None:
        for pid, due in getattr(self, "calibration_due", {}).items():
            if pid in self.plazas:
                for s in self.plazas[pid].sensors.values():
                    if s.kind in ("wim", "scale"):
                        s.calibration_due = due

    def load_vehicles(self, vehicles: list[dict]) -> None:
        for v in vehicles:
            self.vehicles[v["plate"]] = v
        pool = [v for v in vehicles]
        self.rng.shuffle(pool)
        self.idle = deque(pool)

    def add_vehicle(self, v: dict) -> None:
        with self.lock:
            self.vehicles[v["plate"]] = v

    def reset(self) -> None:
        with self.lock:
            cfg = self.cfg
            self.now = datetime.now(EAT).replace(hour=6, minute=0, second=0, microsecond=0)
            self.day_start = self.now.replace(hour=0)
            self.plazas: dict[str, Plaza] = {g.id: Plaza(g, cfg) for g in PLAZAS.values()}
            self.edges = {k: Track(k, e.line, e.line.length / (e.minutes * 60.0), 7.0, lanes=e.lanes) for k, e in EDGES.items()}
            self.trucks: dict[str, Truck] = {}
            self.pending_spawn = 0.0
            self.arrival_w = arrival_profile(cfg) * 24.0
            self.counters: Counter = Counter()
            self.lifetime: Counter = Counter()
            self.stream_counts: Counter = Counter()
            self.bins = self._new_bins()
            self.hold_all: list[Truck] = []
            self.elapsed_s = 0.0
            self.mq_gen = 0
            self.mq_delivered = 0
            self.lat_samples: deque = deque(maxlen=400)
            self.failed_requests = 0
            self.scenario = None
            self.scenario_hook = None
            self.saved_speed = None
            self.queue_sum = 0.0
            self.queue_n = 0
            self.delay_sum_s = 0.0
            self.shadow_sum_s = 0.0
            self.exited_today = 0
            self.tokened_first = 0
            self.first_seen = 0
            self.false_clears = 0
            for rec_id in [k for k, r in self.registry.tokens.items() if r.origin in ("sim", "scenario")]:
                rec = self.registry.tokens.pop(rec_id)
                if self.registry.by_plate.get(rec.plate) == rec_id:
                    self.registry.by_plate.pop(rec.plate, None)
            self._bays = []
            self._slow_acc = 0.0
            self._apply_calibration()
            for p in self.plazas.values():
                for s in p.sensors.values():
                    s.last_ok = self.now

    def _new_bins(self) -> list[dict]:
        return [dict(i=i, arrivals=0, port=0, origin=0, untokened=0, green=0, amber=0, red=0, tokens=0, tokened_seen=0, seen=0, delay_s=0.0, exits=0, queue=0.0, q_n=0, avail_sum=0.0, avail_n=0) for i in range(SAMPLE_BINS)]

    def bin_now(self) -> dict:
        minutes = (self.now - self.day_start).total_seconds() / 60.0
        return self.bins[min(SAMPLE_BINS - 1, int(minutes / 15.0))]

    def control(self, action: str, speed: float | None = None) -> None:
        with self.lock:
            if action == "start":
                self.running, self.paused = True, False
            elif action == "pause":
                self.paused = True
            elif action == "resume":
                self.running, self.paused = True, False
            elif action == "stop":
                self.running = False
            elif action == "reset":
                self.reset()
            if speed is not None:
                self.speed = max(0.25, min(600.0, speed))

    def apply_config(self, cfg: SimConfig) -> None:
        """A new config applies to every truck from now on. Tracks rebuild only where service times changed."""
        with self.lock:
            old = self.cfg
            self.cfg = cfg
            keep_allow = self.policy
            self.policy = cfg.policy().model_copy(update={k: getattr(keep_allow, k) for k in ("max_height_m", "max_width_m", "max_length_m", "identity_min_confidence", "expected_variance_tolerance_pct", "min_quality_score", "validity_port_h", "validity_origin_h", "validity_road_h")})
            self.arrival_w = arrival_profile(cfg) * 24.0
            if old.lane_pass_min != cfg.lane_pass_min or old.lane_headway_m != cfg.lane_headway_m or old.lane_speed_kmh != cfg.lane_speed_kmh or old.stop_overhead_min != cfg.stop_overhead_min:
                for p in self.plazas.values():
                    if p.geom.has_lane:
                        total = sum(p.tracks[k].line.length for k in ("lane_approach", "lane_zone", "lane_exit"))
                        rate = total / (cfg.lane_pass_min * 60.0)
                        gap = max(8.0, rate * cfg.lane_service_s())
                        for k in ("lane_approach", "lane_zone", "lane_exit"):
                            p.tracks[k].rate, p.tracks[k].gap = rate, gap
                    c = p.tracks["collector"]
                    c.rate = c.line.length / max(20.0, cfg.stop_overhead_min * 60.0)

    def set_policy(self, policy) -> None:
        with self.lock:
            self.policy = policy

    # ------------------------------------------------------------------ generation
    def _next_id(self) -> str:
        self._counter += 1
        return f"T{self._counter:06d}"

    def _draw_vehicle(self, stream: str) -> dict:
        if self.idle:
            return self.idle.popleft()
        n = self._counter + 100000
        return {"plate": f"KX{chr(65 + n % 26)} {n % 1000:03d}{chr(65 + (n // 7) % 26)}", "trailer": f"ZX {n % 10000:04d}", "rfid": f"E2{n:010X}", "config": "1-2-3", "tractor_tare": 8800.0, "trailer_tare": 7200.0, "height": 4.1, "width": 2.5, "length": 17.0, "fleet": None, "fleet_id": None, "driver": None, "permit": None, "demerits": 0, "ephemeral": True}

    def _load_axles(self, config: str, ratio: float, rng: random.Random) -> list[float]:
        """Axle loads whose governing ratio (largest of gross and group ratios) equals `ratio`."""
        gs = groups_for(config, self.policy)
        factors = [1.0 - rng.random() * 0.03 for _ in gs]
        factors[rng.randrange(len(gs))] = 1.0
        loads = [g.limit_kg * f * ratio for g, f in zip(gs, factors)]
        gross_lim = gross_limit_for(config, self.policy)
        gross = sum(loads)
        scale = 1.0
        if gross > gross_lim * ratio:
            scale = gross_lim * ratio / gross
        axles: list[float] = []
        for g, load in zip(gs, loads):
            for _ in range(g.axles):
                axles.append(load * scale / g.axles)
        return axles

    def _sample_ratio(self) -> float:
        cfg, r = self.cfg, self.rng
        if r.random() < cfg.overload_pct / 100.0:
            return 1.0 + r.random() * 0.15
        return min(0.995, max(0.25, r.gauss(cfg.avg_loading_pct / 100.0, cfg.load_spread_pct / 100.0)))

    def _choose_route(self, stream: str, enrolled: bool) -> str:
        u = self.rng.random()
        if stream == "port":
            return "port_nairobi" if u < 0.85 else "port_malindi"
        if stream == "origin":
            return "quarry_nairobi" if u < 0.4 else "depot_nairobi" if u < 0.6 else "cement_nairobi"
        if enrolled:  # spot traffic that signed up with an approved scale goes through a loading-site node
            return "depot_nairobi" if u < 0.5 else "cement_nairobi"
        return "spot_kwale" if u < 0.35 else "spot_north" if u < 0.55 else "spot_kaloleni"

    def spawn(self, **over) -> Truck:
        """Creates one truck. Scenarios override any field; a normal arrival samples them from the config."""
        cfg, r = self.cfg, self.rng
        p, o, _ = cfg.shares()
        u = r.random()
        stream = over.pop("stream", "port" if u < p else "origin" if u < p + o else "untokened")
        pa, ps = cfg.enrolment()
        enrolled = over.pop("enrolled", r.random() < (pa if stream != "untokened" else ps))
        vehicle = over.pop("vehicle", None) or self._draw_vehicle(stream)
        route = over.pop("route", None) or self._choose_route(stream, enrolled)
        ratio = over.pop("ratio", None)
        if ratio is None:
            ratio = self._sample_ratio()
        t = Truck(
            id=self._next_id(), plate=vehicle["plate"], trailer=vehicle.get("trailer"), rfid=vehicle.get("rfid"), stream=stream, config=vehicle.get("config", "1-2-3"), route=route,
            plan=list(ROUTES[route]), enrolled=enrolled, tractor_tare=vehicle.get("tractor_tare", 8800.0), trailer_tare=vehicle.get("trailer_tare", 7200.0), height=vehicle.get("height", 4.1),
            width=vehicle.get("width", 2.5), length=vehicle.get("length", 17.0), fleet=vehicle.get("fleet"), fleet_id=vehicle.get("fleet_id"), driver=vehicle.get("driver"), permit=vehicle.get("permit"),
            demerits=vehicle.get("demerits", 0), ratio=ratio, entered_at=self.now,
        )
        t.lane_offset = r.choice((-1.75, 1.75))
        t.axles = self._load_axles(t.config, ratio, r if not over.get("exact") else random.Random(7))
        if stream == "port":
            t.container = make_container(r.choice(("MSC", "MAE", "CMA", "PIL", "EVE", "ONE")), r.randrange(100000, 999999))
            seal = adapters.eseal(t.container)
            t.eseal = seal["eseal_id"]
            t.misdeclared = r.random() < cfg.misdeclaration_pct / 100.0
            t.sealed = r.random() < cfg.sealed_share_pct / 100.0
            tare = 3800.0 if r.random() < 0.5 else 2300.0
            t.container_tare = tare
            cargo = max(0.0, t.gross - t.tractor_tare - t.trailer_tare - tare)
            d = adapters.declared_cargo(t.container, cargo, t.misdeclared)
            t.container_tare = d["container_tare_kg"]
            t.declared_cargo = max(0.0, t.gross - t.tractor_tare - t.trailer_tare - t.container_tare) * (d["declared_cargo_kg"] / max(cargo, 1.0))
            if not t.misdeclared and t.declared_cargo:
                t.declared_cargo = max(0.0, t.gross - t.tractor_tare - t.trailer_tare - t.container_tare) * (1.0 + (r.random() - 0.5) * 0.03)
        if r.random() < cfg.dimension_violation_pct / 100.0:
            t.height = 4.3 + r.random() * 0.5
        if r.random() < cfg.lifted_axle_pct / 100.0:
            self._lift(t)
        if t.enrolled and r.random() < cfg.token_fraud_pct / 100.0:
            t.add_load_after_token = r.uniform(0.05, 0.2)
        for k, v in over.items():
            setattr(t, k, v)
        if t.lifted and t.axles and t.axles[-1] > 0:
            self._lift(t)
        self.trucks[t.id] = t
        self.lifetime["entered"] += 1
        self.counters["entered"] += 1
        self.stream_counts[stream] += 1
        b = self.bin_now()
        b["arrivals"] += 1
        b[stream] += 1
        self._advance_plan(t, first=True)
        return t

    def _lift(self, t: Truck) -> None:
        """Lifted last axle: load shifts to the rest of its group."""
        if t.config.split("-")[-1] == "1" or not t.axles:
            return
        n = int(t.config.split("-")[-1])
        load = t.axles[-1]
        t.axles[-1] = 0.0
        for i in range(2, n + 1):
            t.axles[-i] += load / (n - 1)
        t.lifted = True

    # ------------------------------------------------------------------ movement
    def _advance_plan(self, t: Truck, first: bool = False) -> bool:
        """Moves a truck to the next step of its route. Returns False if the next track has no room."""
        if t.plan_i >= len(t.plan):
            self._exit(t)
            return True
        step = t.plan[t.plan_i]
        if step.startswith("@"):
            plaza = self.plazas[step[1:]]
            target = plaza.tracks["approach"]
        else:
            target = self.edges[step]
        if not target.can_enter(0.0) and not first:
            return False
        if t.track is not None:
            t.track.trucks.remove(t)
        t.plan_i += 1
        t.plaza_id = step[1:] if step.startswith("@") else None
        target.enter(t, 0.0)
        return True

    def _move_to(self, t: Truck, track: Track, s: float = 0.0) -> bool:
        if not track.can_enter(s):
            return False
        if t.track is not None:
            t.track.trucks.remove(t)
        track.enter(t, s)
        return True

    def _exit(self, t: Truck) -> None:
        if t.track is not None and t in t.track.trucks:
            t.track.trucks.remove(t)
        t.track = None
        self.trucks.pop(t.id, None)
        self.lifetime["exited"] += 1
        self.counters["exited"] += 1
        self.exited_today += 1
        self.delay_sum_s += t.delay_s
        self.shadow_sum_s += t.shadow_delay_s
        b = self.bin_now()
        b["delay_s"] += t.delay_s
        b["exits"] += 1
        if not t.was_diverted and not t.had_static:
            self.counters["auto_cleared"] += 1
        limit = self.policy.allowance_factor()
        if self._true_ratio(t) > limit and not t.had_static:
            self.false_clears += 1
            self.counters["false_clears"] += 1
        # The journey ended: the token no longer applies to a later trip by this vehicle
        rec_id = t.token_id
        if rec_id and rec_id in self.registry.tokens:
            try:
                self.registry.set_status(rec_id, "EXPIRED", "Journey complete", self.now, actor="registry", drop=True)
            except ValueError:
                self.registry.tokens.pop(rec_id, None)
                if self.registry.by_plate.get(t.plate) == rec_id:
                    self.registry.by_plate.pop(t.plate, None)
        if t.plate in self.vehicles and not self.vehicles[t.plate].get("ephemeral") and not t.hero:
            self.idle.append(self.vehicles[t.plate])
        if self.scenario and self.scenario.get("truck") == t.id:
            self._scenario_log(f"{t.plate} left the modelled corridor.", "INFO")
            self._scenario_finish()

    def _true_ratio(self, t: Truck) -> float:
        cfg = t.config
        if t.lifted:
            from ..domain.vehicle import effective_config_with_lift

            cfg = effective_config_with_lift(cfg)
            loads = [a for a in t.axles if a > 0]
        else:
            loads = t.axles
        gr = sum(loads) / gross_limit_for(cfg, self.policy)
        best = gr
        for g, l in zip(groups_for(cfg, self.policy), group_loads(loads, cfg)):
            best = max(best, l / g.limit_kg)
        return best

    def _step_track(self, tr: Track, dt: float) -> None:
        trucks = tr.trucks
        if not trucks:
            return
        length = tr.line.length
        rate = tr.rate
        gap = tr.gap
        i = 0
        leader_s = math.inf
        # iterate over a copy because a truck may leave the track
        for t in list(trucks):
            if t.track is not tr:
                continue
            if t.dwell > 0:
                t.dwell = max(0.0, t.dwell - dt)
                leader_s = t.s
                continue
            target = t.s + rate * dt
            limit = leader_s - gap
            if target >= length and leader_s == math.inf:
                t.s = length
                if self._on_track_end(t, tr):
                    continue
                leader_s = t.s
                continue
            new_s = min(target, limit, length)
            t.s = max(t.s, new_s)
            leader_s = t.s

    def _on_track_end(self, t: Truck, tr: Track) -> bool:
        if tr.plaza is None:
            return self._advance_plan(t)
        p = tr.plaza
        key = tr.on_end
        if key == "approach":
            if not p.tracks["to_gantry"].can_enter():
                return False
            self._move_to(t, p.tracks["to_gantry"])
            self._decide_at_sensors(t, p)
            return True
        if key == "to_gantry":
            return self._route_after_gantry(t, p)
        if key == "main_out":
            return self._move_to(t, p.tracks["merge"])
        if key == "merge":
            return self._advance_plan(t)
        if key == "lane_approach":
            ok = self._move_to(t, p.tracks["lane_zone"])
            if ok:
                p.current_lane_truck = t.id
            return ok
        if key == "lane_zone":
            return self._lane_finish(t, p)
        if key == "lane_exit":
            ok = self._move_to(t, p.tracks["merge"], 0.0)
            if ok:
                self._close_side(t, p, "lane")
            return ok
        if key == "queue":
            return self._enter_bay(t, p)
        if key == "collector":
            ok = self._advance_plan(t)
            if ok:
                self._close_side(t, p, "static")
            return ok
        return False

    def _close_side(self, t: Truck, p: Plaza, kind: str) -> None:
        if t.side_entered is None:
            return
        spent = (self.now - t.side_entered).total_seconds()
        t.delay_s += spent
        (p.lane_times if kind == "lane" else p.static_times).append(spent)
        t.side_entered = None
        if t.mode != "held":
            t.mode = "road"

    # ------------------------------------------------------------------ measurement
    def _read_ids(self, t: Truck, p: Plaza, lane: bool = False) -> D.IdentityReads:
        anpr_ok = p.sensor_ok("lane_anpr" if lane else "anpr") and "anpr" not in t.no_read
        rfid_ok = p.sensor_ok("lane_rfid" if lane else "rfid") and "rfid" not in t.no_read
        r = self.rng
        plate = t.plate if anpr_ok and (t.exact or r.random() > 0.003) else None
        tag = t.rfid if rfid_ok and (t.exact or r.random() > 0.002) else None
        trailer = t.trailer if anpr_ok else None
        return D.IdentityReads(plate, tag, trailer, t.plate, t.rfid, t.trailer, t.config)

    def _reading(self, t: Truck, sigma_pct: float, site_bias: float = 0.0) -> tuple[float, list[float]]:
        r = self.rng
        eps = 0.0 if t.exact else r.gauss(0, 1)
        gain = 1.0 + (eps * sigma_pct + site_bias) / 100.0
        axles = [a * (gain + (0.0 if t.exact else r.gauss(0, sigma_pct * 0.04) / 100.0)) for a in t.axles]
        return sum(axles), axles

    def _drift(self, p: Plaza, sid: str) -> float:
        s = p.sensors.get(sid)
        return s.drift_pct if s else 0.0

    def _measure_road(self, t: Truck, p: Plaza) -> D.Measurement:
        m = D.Measurement(speed_kmh=80.0)
        if not p.sensor_ok("wim") or not p.sensor_ok("adc") or not p.sensor_ok("loops") or "wim" in t.no_read:
            bad = next((s for s in ("wim", "adc", "loops") if not p.sensor_ok(s)), "wim")
            m.sensor_fault = f"{p.sensors[bad].name} unavailable"
        else:
            gross, axles = self._reading(t, self.policy.road_error_pct, self._drift(p, "wim"))
            m.gross_kg, m.axle_loads_kg = gross, axles
            m.axles_detected = sum(1 for a in t.axles if a > 0)
            m.quality = 0.95 if t.exact else min(1.0, self.rng.gauss(0.93, 0.03))
            if p.sensors["pavement_temp"].status != "ok":
                m.quality = min(m.quality, 0.55)
        if p.sensor_ok("lidar") and "lidar" not in t.no_read:
            m.height_m, m.width_m, m.length_m = t.height, t.width, t.length
        return m

    def _measure_lane(self, t: Truck, p: Plaza) -> D.Measurement:
        m = D.Measurement(speed_kmh=self.cfg.lane_speed_kmh)
        if not p.sensor_ok("lane_scale") or "lane_scale" in t.no_read:
            m.sensor_fault = "Lane per-wheel scale unavailable"
        else:
            gross, axles = self._reading(t, self.policy.lane_error_pct, self._drift(p, "lane_scale"))
            m.gross_kg = gross
            m.axles_detected = sum(1 for a in t.axles if a > 0)
            m.axle_loads_kg = [a for a in axles if a > 0] if t.lifted else axles
            m.quality = 0.98
        if p.sensor_ok("lane_lidar") and "lane_lidar" not in t.no_read:
            m.height_m, m.width_m, m.length_m = t.height, t.width, t.length
            m.lifted_axle = t.lifted
        return m

    def _measure_static(self, t: Truck, p: Plaza) -> D.Measurement:
        m = D.Measurement(speed_kmh=0.0)
        if not p.sensor_ok("static_scale"):
            m.sensor_fault = "Static scale unavailable"
            return m
        gross, axles = self._reading(t, self.policy.static_error_pct)
        m.gross_kg = gross
        m.axle_loads_kg = [a for a in axles if a > 0] if t.lifted else axles
        m.height_m, m.width_m, m.length_m = t.height, t.width, t.length
        m.lifted_axle = t.lifted
        m.axles_detected = sum(1 for a in t.axles if a > 0)
        m.quality = 1.0
        return m

    def _online(self, p: Plaza) -> bool:
        return p.link_up and p.sensor_ok("network") and not self.registry_down

    # ------------------------------------------------------------------ decisions
    def _decide_at_sensors(self, t: Truck, p: Plaza) -> None:
        if p.kind == "port":
            self._decide_port(t, p)
        elif p.kind == "origin":
            self._decide_origin(t, p)
        else:
            self._decide_road(t, p)

    def _edge_failsafe(self, p: Plaza, stage: str) -> D.Decision:
        return D.Decision(stage, D.Outcome.AMBER, D.Action.STATIC_SCALE, ["Edge unit failed: the gantry defaults to amber and the existing static process applies"], [D.Check("edge", "Edge unit", "fail", "No processing")], risk_score=50.0, confidence=0.1, explanation="Edge unit failed: the gantry defaults to amber and the existing static process applies.", fail_safe=True)

    def _decide_port(self, t: Truck, p: Plaza) -> None:
        if not t.enrolled:
            t.decision = "NOT ENROLLED"
            t.decision_text = "Fleet not enrolled: passes the gate without a token."
            t.hold_next = "main_out"
            return
        status = adapters.release_status(t.container)
        t.release = status
        release_ok = adapters.release_ok(status)
        if status is None:
            self.failed_requests += 1
        m = D.Measurement(speed_kmh=10.0)
        if p.sensor_ok("port_scale") and p.sensor_ok("adc") and "port_scale" not in t.no_read:
            m.gross_kg, m.axle_loads_kg = self._reading(t, self.policy.port_error_pct, self._drift(p, "port_scale"))
            m.quality = 0.98
        else:
            m.sensor_fault = "Port scale unavailable"
        if p.sensor_ok("lidar"):
            m.height_m, m.width_m, m.length_m = t.height, t.width, t.length
        ids = self._read_ids(t, p)
        expected = None
        if t.declared_cargo is not None:
            expected = t.tractor_tare + t.trailer_tare + t.container_tare + t.declared_cargo
        d = D.decide_port(m, ids, self.policy, t.config, release_ok, expected, container_ok=p.sensor_ok("ocr"), permit=None, demerits=t.demerits, truck_tare_kg=t.tractor_tare + t.trailer_tare)
        if not p.edge_up:
            d = self._edge_failsafe(p, "PORT")
            d.action = D.Action.PORT_REWEIGH
        if d.outcome == D.Outcome.GREEN:
            self._issue(t, p, "port", m, self.policy.validity_port_h, expected)
        self._record(t, p, d, m)
        if d.outcome == D.Outcome.GREEN:
            t.hold_next = "main_out"
        else:
            t.hold_next = "queue"
            t.side_entered = self.now
            t.mode = "static"
            t.was_diverted = True
            self.counters["port_reweigh"] += 1
            if d.outcome == D.Outcome.RED:
                self.counters["port_red"] += 1

    def _decide_origin(self, t: Truck, p: Plaza) -> None:
        if not t.enrolled:
            t.decision = "NOT ENROLLED"
            t.decision_text = "No approved-scale ticket for this load."
            t.hold_next = "main_out"
            return
        m = D.Measurement(speed_kmh=0.0)
        if p.sensor_ok("origin_scale"):
            m.gross_kg, m.axle_loads_kg = self._reading(t, self.policy.origin_error_pct)
            m.quality = 0.98
            m.height_m, m.width_m, m.length_m = t.height, t.width, t.length
        else:
            m.sensor_fault = "Loading-site scale unavailable"
        ids = self._read_ids(t, p)
        d = D.decide_origin(m, ids, self.policy, t.config, scale_approved=p.scale_approved, calibration_valid=p.calibration_valid, ticket_signature_valid=True, site_suspended=p.suspended, demerits=t.demerits)
        if not p.edge_up:
            d = self._edge_failsafe(p, "ORIGIN")
            d.action = D.Action.DENY_TOKEN
        if d.outcome == D.Outcome.GREEN:
            self._issue(t, p, "origin", m, self.policy.validity_origin_h, None)
        self._record(t, p, d, m)
        if d.outcome == D.Outcome.GREEN:
            t.hold_next = "main_out"
        elif m.gross_kg is not None and p.scale_approved and p.calibration_valid and not p.suspended and p.edge_up and d.governing_ratio and d.governing_ratio > 0.9:
            # The loader has a scale and the cargo on site: it trims the load and re-weighs.
            t.hold_next = "queue"
            t.mode = "bay"
        else:
            t.hold_next = "main_out"
            t.state = "AMBER"
            t.decision_text = d.explanation

    def _decide_road(self, t: Truck, p: Plaza) -> None:
        online = self._online(p)
        m = self._measure_road(t, p)
        ids = self._read_ids(t, p)
        token, why = self.registry.lookup(ids.plate_read or t.plate if ids.plate_read or ids.tag_read else "", ids.tag_read, self.now, online, p.link_down_since if not online else None)
        if why == "not_in_cache":
            self.failed_requests += 1
        lookup_failed = why is not None
        tier = token.trust_tier if token else 3
        rate = D.audit_rate_pct(self.policy, tier, t.demerits) if self.cfg.audit_pct > 0 else 0.0
        audit = p.id in t.force_audit or self.rng.random() < rate / 100.0
        if t.exact and p.id not in t.force_audit:
            audit = False
        d = D.decide_road(m, ids, self.policy, t.config, token, audit_selected=audit, permit=None, demerits=t.demerits, lane_available=p.lane_open, token_lookup_failed=lookup_failed)
        if not p.edge_up:
            d = self._edge_failsafe(p, "ROAD")
        # The as-is counterfactual, for truck-hours saved: would today's absolute WIM rule have stopped this truck?
        if m.gross_kg is not None and (d.governing_ratio or 0.0) + self.policy.margin_pct("road") / 100.0 > self.policy.allowance_factor():
            t.shadow_delay_s += self.cfg.static_stop_min * 60.0
        if not t.first_station_done:
            t.first_station_done = True
            self.first_seen += 1
            b = self.bin_now()
            b["seen"] += 1
            if token is not None:
                self.tokened_first += 1
                b["tokened_seen"] += 1
        self._record(t, p, d, m, token_id=token.token_id if token else None, offline=not online)
        if token is not None:
            self.registry.record_verification(token.token_id, p.id, self.now, d.outcome.value, {"variance_check": [c.detail for c in d.checks if c.code == "token"], "outcome": d.outcome.value}, self._origin(t), offline=not online)
            if any(c.code == "token" and c.status == "fail" for c in d.checks):
                self.counters["token_mismatch"] += 1
                if t.fleet:
                    self.fleet_mismatches[t.fleet] += 1
                    if self.fleet_mismatches[t.fleet] == 6:
                        self.alert("warning", "suspicious_fleet", p.id, f"Repeated token mismatches: {t.fleet}", "Six token mismatches today. Review the fleet's audit rate.", key=f"fleet:{t.fleet}")
                self.alert("warning", "token_mismatch", p.id, f"Token mismatch: {t.plate}", d.explanation, key=f"mm:{t.plate}", quiet_min=5)
        if any(c.code == "identity" and c.status != "pass" for c in d.checks) and ids.plate_read and ids.plate_read != t.plate:
            self.alert("warning", "identity", p.id, f"Identity failure: {t.plate}", d.explanation, key=f"id:{t.plate}")
        if d.action == D.Action.CONTINUE:
            if d.issue_token:
                self._issue(t, p, "road", m, self.policy.validity_road_h, None, online=online)
            t.hold_next = "main_out"
        elif d.action == D.Action.DIVERT_LANE:
            t.hold_next = "lane_approach"
            t.side_entered = self.now
            t.mode = "lane"
            t.was_diverted = True
            p.lane_visits += 1
            self.counters["lane"] += 1
            if audit and d.reasons and d.reasons[0].startswith("Random audit"):
                self.counters["audits"] += 1
                p.audits += 1
        else:
            t.hold_next = "queue"
            t.side_entered = self.now
            t.mode = "static"
            t.was_diverted = True
            self.counters["static"] += 1
            p.static_visits += 1
            t.had_static = True

    def _route_after_gantry(self, t: Truck, p: Plaza) -> bool:
        nxt = t.hold_next or "main_out"
        ok = self._move_to(t, p.tracks[nxt])
        if ok:
            t.hold_next = None
        return ok

    def _lane_finish(self, t: Truck, p: Plaza) -> bool:
        if not p.tracks["lane_exit"].can_enter() and not p.tracks["queue"].can_enter():
            return False
        online = self._online(p)
        m = self._measure_lane(t, p)
        ids = self._read_ids(t, p, lane=True)
        token, _ = self.registry.lookup(ids.plate_read or t.plate if ids.plate_read or ids.tag_read else "", ids.tag_read, self.now, online, p.link_down_since if not online else None)
        d = D.decide_lane(m, ids, self.policy, t.config, token, permit=None, demerits=t.demerits)
        if not p.edge_up:
            d = D.Decision("LANE", D.Outcome.RED, D.Action.STATIC_SCALE, ["Edge unit failed: inconclusive, static weighing required"], [D.Check("edge", "Edge unit", "fail", "No processing")], fail_safe=True, explanation="Edge unit failed: inconclusive, static weighing required.", confidence=0.1, risk_score=50.0)
        target = p.tracks["lane_exit"] if d.outcome == D.Outcome.GREEN else p.tracks["queue"]
        if not target.can_enter():
            return False
        self._record(t, p, d, m, token_id=token.token_id if token else None, offline=not online)
        self._move_to(t, target)
        p.lane_passes.append(self.now)
        p.current_lane_truck = None
        wheels = []
        if m.axle_loads_kg:
            for a in m.axle_loads_kg:
                imbalance = 0.0 if t.exact else self.rng.gauss(0, 0.015)
                wheels.append({"left_kg": round(a * (0.5 + imbalance)), "right_kg": round(a * (0.5 - imbalance))})
        groups = []
        if m.axle_loads_kg and not t.lifted:
            for g, load in zip(groups_for(t.config, self.policy), group_loads(m.axle_loads_kg, t.config)):
                groups.append({"group": g.kind, "load_kg": round(load), "limit_kg": g.limit_kg})
        p.last_lane_result = {
            "truck": t.id, "plate": t.plate, "at": self.now.isoformat(), "outcome": d.outcome.value, "action": d.action.value, "explanation": d.explanation, "checks": [c.__dict__ for c in d.checks],
            "gross_kg": round(m.gross_kg) if m.gross_kg else None, "axle_loads_kg": [round(a) for a in m.axle_loads_kg] if m.axle_loads_kg else None, "wheels": wheels, "groups": groups,
            "dimensions": {"height": m.height_m, "width": m.width_m, "length": m.length_m}, "lifted_axle": m.lifted_axle, "speed_kmh": m.speed_kmh, "fail_safe": d.fail_safe,
        }
        if token is not None and m.gross_kg is not None:
            p.audit_abs_err.append(abs(m.gross_kg - token.gross_kg) / token.gross_kg * 100.0)
        if d.outcome == D.Outcome.GREEN:
            self._issue(t, p, "lane", m, self.policy.validity_road_h, None, online=online)
        else:
            self.counters["static"] += 1
            self.counters["lane_red"] += 1
            p.static_visits += 1
            t.had_static = True
            t.mode = "static"
            self._close_side(t, p, "lane")
            t.side_entered = self.now
            if m.gross_kg and (d.governing_ratio or 0) > 1.0:
                self.counters["overload_flagged"] += 1
                self.alert("warning", "overload", p.id, f"Probable overload: {t.plate}", d.explanation + " Sent to the static scale, which remains the legal authority.", key=f"ov:{t.plate}")
        return True

    def _enter_bay(self, t: Truck, p: Plaza) -> bool:
        for i in range(len(p.bays)):
            if p.bays[i] is None:
                p.bays[i] = t
                t.bay_i = i
                if t.track is not None:
                    t.track.trucks.remove(t)
                # A bay is a single-truck track, so it never blocks anything except itself.
                bay_track = Track(f"{p.id}.bay{i}", p.bay_tracks[i], 6.0, 0.0, on_end="bay", plaza=p)
                bay_track.trucks.append(t)
                t.track = bay_track
                t.s = 0.0
                t.mode = "bay"
                self.bay_list.append((t, p, i, self._bay_service(t, p)))
                return True
        return False

    @property
    def bay_list(self) -> list:
        if not hasattr(self, "_bays"):
            self._bays = []
        return self._bays

    def _bay_service(self, t: Truck, p: Plaza) -> float:
        if p.kind == "port":
            return self.cfg.port_reweigh_min * 60.0
        if p.kind == "origin":
            return TRIM_MIN * 60.0
        return self.cfg.static_service_min() * 60.0

    def _step_bays(self, dt: float) -> None:
        remaining = []
        for item in self.bay_list:
            t, p, i, left = item
            if t.s < t.track.line.length:
                t.s = min(t.track.line.length, t.s + t.track.rate * dt)
                remaining.append(item)
                continue
            left -= dt
            p.bay_busy_s += dt
            if left > 0:
                remaining.append((t, p, i, left))
                continue
            if not self._bay_finish(t, p, i):
                remaining.append((t, p, i, 0.0))
        self._bays = remaining

    def _bay_finish(self, t: Truck, p: Plaza, i: int) -> bool:
        col = p.tracks["collector"]
        if not col.can_enter(0.0):
            return False
        m = self._measure_static(t, p) if p.kind != "origin" else self._measure_origin_retry(t)
        ids = self._read_ids(t, p)
        d = D.decide_static(m, ids, self.policy, t.config, demerits=t.demerits)
        # leave the bay
        p.bays[i] = None
        t.track = None
        t.bay_i = -1
        online = self._online(p)

        if p.kind == "origin":
            if d.outcome != D.Outcome.GREEN or m.gross_kg is None or d.governing_ratio is None or d.governing_ratio + self.policy.margin_pct("origin") / 100.0 > self.policy.allowance_factor():
                self._set_ratio(t, min(self._true_ratio(t), self.policy.allowance_factor() - self.policy.margin_pct("origin") / 100.0 - 0.01))
                m = D.Measurement(gross_kg=t.gross, axle_loads_kg=list(t.axles), height_m=t.height, width_m=t.width, length_m=t.length, quality=1.0)
                d = D.Decision("ORIGIN", D.Outcome.GREEN, D.Action.CONTINUE, [], [D.Check("trim", "Load trimmed on site and re-weighed", "pass")], risk_score=8.0, confidence=0.95, explanation="Load trimmed at the loading site and re-weighed within limits.", issue_token=True)
            self._record(t, p, d, m)
            self._issue(t, p, "origin", m, self.policy.validity_origin_h, None, online=online)
            t.mode = "road"
            col.enter(t, 0.0)
            return True

        token_source = "static"
        if p.kind == "port":
            if d.outcome != D.Outcome.GREEN:
                # Corrective action in the port, with customs present for sealed loads, then a re-weigh.
                self.counters["port_corrected"] += 1
                self._record(t, p, D.Decision("PORT", D.Outcome.RED, D.Action.HOLD_CORRECTIVE, d.reasons, d.checks, risk_score=d.risk_score, confidence=d.confidence, explanation=d.explanation + " Corrective action in the port" + (" with customs present." if t.sealed else "."), governing_ratio=d.governing_ratio), m)
                t.state = "RED"
                t.was_red = True
                self._hold(t, p, self.now + timedelta(minutes=CORRECTIVE_MIN + (self.cfg.customs_break_seal_min if t.sealed else 0.0)), None, corrective=True)
                return True
            self._record(t, p, D.Decision("PORT", D.Outcome.GREEN, D.Action.CONTINUE, [], d.checks, risk_score=d.risk_score, confidence=d.confidence, explanation="Re-weighed on the port legal-grade deck: within limits.", issue_token=True, governing_ratio=d.governing_ratio), m)
            self._issue(t, p, "port", m, self.policy.validity_port_h, None, online=online)
            col.enter(t, 0.0)
            t.mode = "static"
            return True

        self._record(t, p, d, m, offline=not online)
        if d.outcome == D.Outcome.GREEN:
            self._issue(t, p, token_source, m, self.policy.validity_road_h, None, online=online)
            col.enter(t, 0.0)
            t.mode = "static"
            return True
        # Confirmed overload or breach, or a failed scale: an authorised officer must approve the ticket and release order.
        t.was_red = True
        self.counters["confirmed_overload"] += 1
        case = self._open_case(t, p, m, d)
        self._hold(t, p, self.now + timedelta(minutes=OFFICER_DELAY_MIN), case)
        return True

    def _measure_origin_retry(self, t: Truck) -> D.Measurement:
        gross, axles = self._reading(t, self.policy.origin_error_pct)
        return D.Measurement(gross_kg=gross, axle_loads_kg=axles, height_m=t.height, width_m=t.width, length_m=t.length, quality=1.0)

    def _set_ratio(self, t: Truck, ratio: float) -> None:
        was_lifted = t.lifted
        t.lifted = False
        t.axles = self._load_axles(t.config, ratio, random.Random(5))
        if was_lifted:
            t.height = min(t.height, self.policy.max_height_m - 0.05)

    def _hold(self, t: Truck, p: Plaza, until: datetime, case: str | None, corrective: bool = False) -> None:
        t.mode = "held"
        t.hold_until = until
        t.hold_case = case
        t.state = "RED"
        p.held.append(t)
        self.hold_all.append(t)

    def release_truck(self, t: Truck, p: Plaza, note: str | None = None) -> None:
        """Corrective action done, or an officer signed: load corrected, new token, the truck rejoins."""
        if t in p.held:
            p.held.remove(t)
        if t in self.hold_all:
            self.hold_all.remove(t)
        t.hold_until = None
        t.hold_case = None
        limit = self.policy.allowance_factor()
        margin = self.policy.margin_pct("road") / 100.0
        self._set_ratio(t, min(self._true_ratio(t), limit - margin - 0.02, 0.93))
        t.height = min(t.height, self.policy.max_height_m - 0.02)
        m = D.Measurement(gross_kg=t.gross, axle_loads_kg=list(t.axles), height_m=t.height, width_m=t.width, length_m=t.length, quality=1.0)
        d = D.Decision("STATIC" if p.kind != "port" else "PORT", D.Outcome.GREEN, D.Action.CONTINUE, [], [D.Check("corrective", "Corrected load re-weighed", "pass")], risk_score=20.0, confidence=0.9, explanation=note or "Corrected load re-weighed within limits; release order on record.", issue_token=True)
        self._record(t, p, d, m)
        online = self._online(p)
        self._issue(t, p, "port" if p.kind == "port" else "static", m, self.policy.validity_port_h if p.kind == "port" else self.policy.validity_road_h, None, online=online)
        t.state = "GREEN"
        t.mode = "static"
        t.track = None
        col = p.tracks["collector"]
        col.enter(t, 0.0)

    def _open_case(self, t: Truck, p: Plaza, m: D.Measurement, d: D.Decision) -> str:
        case_id = f"CASE-{uuid.uuid4().hex[:10].upper()}"
        cfg_eff = t.config
        if m.lifted_axle:
            from ..domain.vehicle import effective_config_with_lift

            cfg_eff = effective_config_with_lift(t.config)
        limit = gross_limit_for(cfg_eff, self.policy)
        over = 0.0
        if m.gross_kg is not None and d.governing_ratio:
            over = max(0.0, (d.governing_ratio - 1.0)) * limit
        fee = D.overload_fee_usd(over, self.policy)
        origin = self._origin(t)
        if self.persist:
            write_behind.add(OfficerCase(id=case_id, created_at=self.now, site=p.id, plate=t.plate, truck_ref=t.id, measured_gross_kg=m.gross_kg, limit_kg=limit, overload_kg=round(over), fee_usd=fee, reason=d.explanation, sealed_transit=t.sealed, status="PENDING", origin=origin))
        self.alert("critical" if over > 2000 else "warning", "overload", p.id, f"Confirmed on static scale: {t.plate}", d.explanation + " Awaiting an authorised officer." + (" Sealed transit cargo: customs alerted." if t.sealed else ""), key=f"case:{case_id}")
        return case_id

    def decide_case(self, case_id: str, approve: bool, officer: str, signature: str | None = None) -> bool:
        """A human officer decision releases a held truck straight away."""
        with self.lock:
            for t in list(self.hold_all):
                if t.hold_case == case_id:
                    p = self.plazas[self._hold_site(t)]
                    self.release_truck(t, p, note=f"Overload ticket and release order approved by {officer}. Corrected load re-weighed." if approve else f"Ticket rejected by {officer}: static reading set aside, truck released.")
                    if self.scenario and self.scenario.get("truck") == t.id:
                        self._scenario_log(f"Officer {officer} {'approved' if approve else 'rejected'} the ticket. Truck released with a new token.", "GREEN")
                    return True
        return False

    def _hold_site(self, t: Truck) -> str:
        for p in self.plazas.values():
            if t in p.held:
                return p.id
        return next(iter(self.plazas))

    def _step_holds(self) -> None:
        for t in list(self.hold_all):
            if t.hold_until is not None and self.now >= t.hold_until:
                p = self.plazas[self._hold_site(t)]
                if not p.tracks["collector"].can_enter(0.0):
                    continue
                case = t.hold_case
                self.release_truck(t, p, note="Corrective action complete and re-weighed." if case is None else "Demo duty officer approved the ticket and release order (simulated). Corrected load re-weighed.")
                if case and self.persist:
                    cid, now = case, self.now

                    def _auto(db, cid=cid, now=now):
                        row = db.get(OfficerCase, cid)
                        if row is not None and row.status == "PENDING":
                            row.status, row.officer, row.decided_at, row.release_order = "AUTO_DEMO", "Demo duty officer (simulated)", now, f"RO-DEMO-{cid[-6:]}"

                    write_behind.call(_auto)

    # ------------------------------------------------------------------ records
    def _origin(self, t: Truck) -> str:
        return t.source_tag or ("scenario" if t.hero else "sim")

    def _record(self, t: Truck, p: Plaza, d: D.Decision, m: D.Measurement | None, token_id: str | None = None, offline: bool = False) -> None:
        out = d.outcome.value
        t.state = out
        t.decision = out
        t.decision_text = d.explanation
        if m is not None and m.gross_kg is not None:
            t.last_gross = m.gross_kg
        p.decisions[out] += 1
        p.processed += 1
        p.last_gantry = out
        p.last_gantry_at = self.elapsed_s
        self.counters[out.lower()] += 1
        b = self.bin_now()
        b[out.lower()] += 1
        p.seq += 1
        ev_id = f"{p.id[:3].upper()}-{p.seq:07d}-{self.lifetime['decisions']:07d}"
        self.lifetime["decisions"] += 1
        body = {"id": ev_id, "at": self.now.isoformat(), "truck": t.id, "plate": t.plate, "stream": t.stream, "site": p.id, "site_name": p.name, "stage": d.stage, "outcome": out, "action": d.action.value, "risk": d.risk_score, "confidence": d.confidence, "explanation": d.explanation, "gross_kg": round(m.gross_kg) if m and m.gross_kg else None, "token": token_id or t.token_id, "fail_safe": d.fail_safe, "offline": offline, "hero": t.hero}
        sign_t0 = time.perf_counter()
        signer = self.registry.signers.get(p.id)
        sig = signer.sign({"id": ev_id, "at": body["at"], "plate": t.plate, "site": p.id, "outcome": out}) if signer else None
        self.lat_samples.append((time.perf_counter() - sign_t0) * 1000.0 + (self.rng.lognormvariate(math.log(14.0), 0.4) if not offline else 0.0))
        t.history.append({"at": body["at"], "site": p.name, "stage": d.stage, "outcome": out, "action": d.action.value, "explanation": d.explanation, "gross_kg": body["gross_kg"], "checks": [c.__dict__ for c in d.checks], "risk": d.risk_score, "offline": offline, "event": ev_id})
        row = None
        if self.persist:
            row = ClearanceEvent(id=ev_id, at=self.now, truck_ref=t.id, plate=t.plate, stream=t.stream, site=p.id, stage=d.stage, outcome=out, action=d.action.value, risk=d.risk_score, confidence=d.confidence, explanation=d.explanation, checks=[c.__dict__ for c in d.checks], measured_gross_kg=m.gross_kg if m else None, axle_loads_kg=[round(a) for a in m.axle_loads_kg] if m and m.axle_loads_kg else None, token_id=token_id or t.token_id, fail_safe=d.fail_safe, offline=offline, signature=sig, kid=p.id, origin=self._origin(t))
        self.mq_gen += 1
        if self._online(p):
            self.mq_delivered += 1
            if row is not None:
                write_behind.add(row)
            self.bus.publish(f"rcs/v1/{p.id}/clearance", {"id": ev_id, "outcome": out})
        else:
            p.outbox.append((ev_id, row))
        self.events_out.append(body)
        self.recent_events.appendleft(body)
        if d.fail_safe:
            self.counters["fail_safe"] += 1
        if self.scenario and self.scenario.get("truck") == t.id:
            self._scenario_log(f"{p.name}: {out}. {d.explanation}", out)
        if d.outcome == D.Outcome.RED and d.stage == "PORT":
            self.alert("warning", "overload", p.id, f"Port overload: {t.plate}", d.explanation, key=f"pov:{t.plate}", quiet_min=10)

    def _issue(self, t: Truck, p: Plaza, source: str, m: D.Measurement, validity: float, expected: float | None, online: bool | None = None):
        online = self._online(p) if online is None else online
        axles = m.axle_loads_kg or []
        config = t.config
        gross = m.gross_kg if m.gross_kg is not None else t.gross
        rec = self.registry.issue(
            site=p.id, source=source, now=self.now, online=online, origin=self._origin(t), validity_hours=validity, plate=t.plate, trailer=t.trailer, tag=t.rfid, container=t.container,
            container_ok=True if t.container else None, eseal=t.eseal, gross=gross, expected=expected, axle_loads=axles, config=config, h=m.height_m, w=m.width_m, l=m.length_m, permit=t.permit,
            destination=t.destination or ROUTE_DEST.get(t.route), route=t.route or None, driver=t.driver, release={k: v for k, v in (t.release or {}).items()} if t.release else None,
        )
        t.token_id = rec.token_id
        t.token_status = rec.status
        self.counters["tokens"] += 1
        self.bin_now()["tokens"] += 1
        self.bus.publish(f"rcs/v1/{p.id}/token", {"id": rec.token_id, "source": source})
        if self.scenario and self.scenario.get("truck") == t.id:
            self._scenario_log(f"Load Compliance Token {rec.token_id} signed by {p.id} ({source}, Ed25519).", "TOKEN")
        if t.add_load_after_token and source in ("port", "origin"):
            # Cargo added after the first weighing. A scenario can set this; audits and consistency checks must catch it.
            self._set_ratio_keep(t, self._true_ratio(t) * (1.0 + t.add_load_after_token))
            t.add_load_after_token = 0.0
        return rec

    def _set_ratio_keep(self, t: Truck, ratio: float) -> None:
        factor = ratio / max(self._true_ratio(t), 1e-6)
        t.axles = [a * factor for a in t.axles]

    def alert(self, severity: str, kind: str, site: str | None, title: str, detail: str = "", key: str | None = None, quiet_min: float = 30.0) -> None:
        key = key or f"{kind}:{site}"
        last = self.alert_seen.get(key)
        if last is not None and (self.now - last).total_seconds() < quiet_min * 60.0:
            return
        self.alert_seen[key] = self.now
        body = {"at": self.now.isoformat(), "severity": severity, "kind": kind, "site": site, "title": title, "detail": detail}
        self.alerts_out.append(body)
        self.recent_alerts.appendleft(body)
        self.counters["alerts"] += 1
        if self.persist:
            write_behind.add(AlertRow(at=self.now, severity=severity, kind=kind, site=site, title=title, detail=detail, origin="sim"))
        self.bus.publish(f"rcs/v1/{site or 'system'}/alert", {"kind": kind, "severity": severity})

    # ------------------------------------------------------------------ failures
    def set_sensor(self, site: str, sensor: str, status: str) -> dict:
        with self.lock:
            p = self.plazas[site]
            s = p.sensors[sensor]
            if sensor == "network":
                self.set_link(site, status == "ok")
                s.status = status
            elif status not in ("ok",) or s.status != status:
                s.status = status
            if sensor == "network":
                pass
            elif status != "ok":
                self.alert("critical" if sensor in ("edge", "wim", "lane_scale", "port_scale") else "warning", "sensor", site, f"{s.name} {status} at {p.name}", "Readings that depend on it now fail safe to amber or the existing process.", key=f"s:{site}:{sensor}", quiet_min=1)
            else:
                self.alert("info", "sensor", site, f"{s.name} restored at {p.name}", "", key=f"sr:{site}:{sensor}", quiet_min=1)
            return {"site": site, "sensor": sensor, "status": s.status}

    def set_link(self, site: str, up: bool, duration_min: float | None = None) -> None:
        with self.lock:
            p = self.plazas[site]
            if up and not p.link_up:
                p.link_up = True
                p.scheduled_restore = None
                if "network" in p.sensors:
                    p.sensors["network"].status = "ok"
                p.syncing = True
                p.sync_started = self.now
                p.sync_backlog = len(p.outbox)
                self.alert("info", "network", site, f"Link restored at {p.name}", f"Synchronizing {p.sync_backlog} queued records.", key=f"net+:{site}", quiet_min=1)
            elif not up and p.link_up:
                p.link_up = False
                p.link_down_since = self.now
                p.syncing = False
                if "network" in p.sensors:
                    p.sensors["network"].status = "fault"
                self.alert("critical", "network", site, f"Network outage at {p.name}", "The edge unit is running offline: cached tokens, local decisions, queued records.", key=f"net-:{site}", quiet_min=1)
            if not up and duration_min:
                p.scheduled_restore = self.now + timedelta(minutes=duration_min)

    def _step_sync(self, dt: float) -> None:
        for p in self.plazas.values():
            online = self._online(p)
            if not online or not p.outbox:
                if p.syncing and not p.outbox:
                    p.syncing = False
                    p.last_recovery_s = (self.now - p.sync_started).total_seconds() if p.sync_started else 0.0
                    self.alert("info", "network", p.id, f"Sync complete at {p.name}", f"{p.sync_backlog} records in {p.last_recovery_s:.0f} s of simulated time. Integrity checked by sequence number.", key=f"sync:{p.id}", quiet_min=1)
                    self._activate_offline_tokens(p)
                continue
            n = max(1, int(SYNC_EVENTS_PER_SIM_S * dt))
            for _ in range(min(n, len(p.outbox))):
                ev_id, row = p.outbox.popleft()
                self.mq_delivered += 1
                if row is not None:
                    write_behind.add(row)
                self.bus.publish(f"rcs/v1/{p.id}/clearance", {"id": ev_id, "replayed": True})

    def _activate_offline_tokens(self, p: Plaza) -> None:
        for rec in list(self.registry.tokens.values()):
            if rec.kid == p.id and rec.status == "ISSUED":
                self.registry.set_status(rec.token_id, "ACTIVE", "Registry received the offline-issued token", self.now, actor="sync", site=p.id)

    def _random_outages(self, dt: float) -> None:
        cfg = self.cfg
        rate = cfg.outage_per_day / 86400.0
        for p in self.plazas.values():
            # A timed restore applies whatever the random outage rate is, and to manual outages too.
            if not p.link_up and p.scheduled_restore is not None and self.now >= p.scheduled_restore:
                self.set_link(p.id, True)
            if rate > 0 and p.kind != "origin" and p.link_up and self.rng.random() < rate * dt:
                self.set_link(p.id, False, duration_min=cfg.outage_duration_min * self.rng.uniform(0.7, 1.3))

    def _slow_tick(self) -> None:
        """Once per simulated minute: sensor telemetry, drift, calibration, availability sampling."""
        minute = (self.now - self.day_start).total_seconds() / 60.0
        hour = minute / 60.0
        ambient = 29.0 + 4.0 * math.sin((hour - 9.0) / 24.0 * 2 * math.pi)
        r = self.rng
        for p in self.plazas.values():
            for s in p.sensors.values():
                s.temperature_c = ambient + (10.0 * max(0.0, math.sin((hour - 7.0) / 12.0 * math.pi)) if s.kind in ("wim", "temperature", "scale") else 6.0)
                if s.status == "ok":
                    s.quality = min(1.0, max(0.6, s.quality + r.gauss(0, 0.004) - (s.quality - 0.97) * 0.05))
                    s.drift_pct = max(-3.0, min(3.0, s.drift_pct + r.gauss(0, 0.0015)))
                    s.latency_ms = max(0.8, r.gauss(4.0 if s.kind != "edge" else 18.0, 0.8))
                    s.last_ok = self.now
                    s.comm_ok = True
                    s.value = self._sensor_value(s, ambient)
                else:
                    s.quality = 0.0
                    s.comm_ok = False
                if s.calibration_due is not None and s.calibration_due < self.now:
                    self.alert("warning", "calibration", p.id, f"Calibration overdue at {p.name}: {s.name}", "Quarterly calibration is required (Reg 6).", key=f"calib:{p.id}:{s.id}", quiet_min=1440)
                if abs(s.drift_pct) > 1.0 and not s.drift_alerted:
                    s.drift_alerted = True
                    self.alert("warning", "sensor_drift", p.id, f"Sensor drift at {p.name}: {s.name}", f"Drift {s.drift_pct:+.2f}%. Schedule recalibration.", key=f"drift:{p.id}:{s.id}")
            # Queue and availability samples
            q = p.lane_queue + p.static_queue
            p.queue_samples.append(q)
            self.queue_sum += q
            self.queue_n += 1
            b = self.bin_now()
            b["queue"] += q
            b["q_n"] += 1
            avail = 1.0 if (p.edge_up and self._online(p)) else 0.0
            b["avail_sum"] += avail
            b["avail_n"] += 1
            p.alive_s += 60.0
            if not self._online(p):
                p.downtime_s += 60.0
            if not p.edge_up:
                p.edge_downtime_s += 60.0
        self.registry.expire_sweep(self.now)
        if self.now.date() != self.day_start.date():
            self._day_rollover()

    def _sensor_value(self, s: Sensor, ambient: float) -> float:
        r = self.rng
        if s.kind == "temperature":
            return round(s.temperature_c, 1)
        if s.kind == "wim":
            return round(r.uniform(40, 110), 1)
        if s.kind == "camera":
            return round(r.uniform(0.92, 0.995), 3)
        if s.kind == "rfid":
            return round(r.uniform(-62, -48), 1)
        if s.kind == "lidar":
            return round(r.uniform(3.9, 4.2), 2)
        if s.kind == "adc":
            return round(r.uniform(1.2, 3.6), 2)
        if s.kind == "power":
            return round(r.uniform(96, 100), 1)
        if s.kind == "loop":
            return round(r.uniform(70, 88), 1)
        return round(s.latency_ms, 1)

    def _day_rollover(self) -> None:
        self.day_start = self.now.replace(hour=0, minute=0, second=0, microsecond=0)
        self.counters = Counter()
        self.stream_counts = Counter()
        self.bins = self._new_bins()
        self.queue_sum = self.queue_n = 0
        self.delay_sum_s = self.shadow_sum_s = 0.0
        self.exited_today = self.tokened_first = self.first_seen = 0
        self.fleet_mismatches = Counter()
        for p in self.plazas.values():
            p.decisions = Counter()
            p.processed = p.lane_visits = p.static_visits = p.audits = 0
            p.bay_busy_s = 0.0

    # ------------------------------------------------------------------ main loop
    def step(self, dt_sim: float) -> None:
        """Advances simulated time by dt_sim seconds, sub-stepping so that movement stays stable at high speed."""
        with self.lock:
            t0 = time.perf_counter()
            remaining = dt_sim
            while remaining > 1e-9:
                dt = min(remaining, 2.0)
                self._substep(dt)
                remaining -= dt
            self.last_step_ms = (time.perf_counter() - t0) * 1000.0

    def _substep(self, dt: float) -> None:
        self.now += timedelta(seconds=dt)
        self.elapsed_s += dt
        hour = int((self.now - self.day_start).total_seconds() // 3600) % 24
        rate = self.cfg.trucks_per_day / 86400.0 * float(self.arrival_w[hour]) * (0.35 if self.scenario else 1.0)
        self.pending_spawn += rate * dt
        while self.pending_spawn >= 1.0:
            self.pending_spawn -= 1.0
            self.spawn()
        for tr in self.edges.values():
            self._step_track(tr, dt)
        for p in self.plazas.values():
            for tr in p.tracks.values():
                self._step_track(tr, dt)
        self._step_bays(dt)
        self._step_holds()
        self._step_sync(dt)
        self._random_outages(dt)
        if self.scenario_hook:
            self.scenario_hook()
        self._slow_acc += dt
        if self._slow_acc >= 60.0:
            self._slow_acc -= 60.0
            self._slow_tick()

    # ------------------------------------------------------------------ views
    def frame(self) -> dict:
        with self.lock:
            rows = []
            for t in self.trucks.values():
                x, z, h = self._pos(t)
                rows.append([t.id, round(x, 1), round(z, 1), round(h, 3), STATE_CODE[t.state], 1 if t.hero else 0, t.mode[0], len(t.axles)])
            return {"t": "frame", "now": self.now.isoformat(), "trucks": rows, "gantries": {p.id: self._gantry(p) for p in self.plazas.values() if p.kind == "road" or p.kind == "port"}, "running": self.running and not self.paused, "speed": self.speed}

    def _gantry(self, p: Plaza) -> str:
        if not p.edge_up:
            return "AMBER"
        if self.elapsed_s - p.last_gantry_at < 20.0:
            return p.last_gantry
        return "GREEN"

    def _pos(self, t: Truck) -> tuple[float, float, float]:
        if t.mode == "held":
            for p in self.plazas.values():
                if t in p.held:
                    i = p.held.index(t)
                    d = p.geom.devices["hold"]
                    return d["x"] + i * 4.0, d["z"] + i * 7.0, d["heading"]
        if t.track is None:
            return 0.0, 0.0, 0.0
        x, z, h = t.track.line.at(t.s)
        if t.track.plaza is None and t.track.lanes > 1:
            x += -math.sin(h) * t.lane_offset * 1.0
            z += math.cos(h) * t.lane_offset * 1.0
        return x, z, h

    def truck_detail(self, truck_id: str) -> dict | None:
        with self.lock:
            t = self.trucks.get(truck_id)
            if not t:
                return None
            token = self.registry.tokens.get(t.token_id) if t.token_id else None
            return {
                "id": t.id, "tractor_plate": t.plate, "trailer_plate": t.trailer, "rfid": t.rfid, "stream": t.stream, "container": t.container, "eseal": t.eseal, "fleet": t.fleet,
                "gross_true_kg": None, "gross_measured_kg": round(t.last_gross) if t.last_gross else None, "axle_config": t.config, "axles_in_contact": sum(1 for a in t.axles if a > 0), "token_id": t.token_id, "token_status": token.status if token else ("NONE" if not t.token_id else "CLOSED"),
                "token_source": token.payload["source"] if token else None, "decision": t.decision, "decision_text": t.decision_text, "state": t.state, "location": self._where(t), "next": t.next_destination(), "route": t.route, "destination": ROUTE_DEST.get(t.route),
                "delay_min": round((t.delay_s + ((self.now - t.side_entered).total_seconds() if t.side_entered else 0)) / 60.0, 1), "history": t.history[-12:], "mode": t.mode, "hero": t.hero, "enrolled": t.enrolled, "hold_case": t.hold_case,
            }

    def _where(self, t: Truck) -> str:
        if t.mode == "held":
            return "Held for corrective action or officer review"
        if t.track is None:
            return "In transit"
        tid = t.track.id
        if t.track.plaza is not None:
            part = tid.split(".")[1]
            names = {"approach": "approach", "to_gantry": "gantry section", "main_out": "mainline, cleared", "merge": "merge", "lane_approach": "lane approach", "lane_zone": "lane measuring zone", "lane_exit": "lane exit", "queue": "static or re-weigh queue", "collector": "exit collector"}
            if part.startswith("bay"):
                kind = "static scale deck" if t.track.plaza.kind == "road" else "re-weigh deck" if t.track.plaza.kind == "port" else "scale"
                return f"{t.track.plaza.name}: {kind} {int(part[3:]) + 1}"
            return f"{t.track.plaza.name}: {names.get(part, part)}"
        return "On the highway, section " + tid.replace("_", " to ", 1).replace("mk", "Mariakani").replace("dk", "Dongo Kundu").replace("mt", "Mtwapa").replace("j1", "port junction").replace("j2", "corridor junction")

    def station_view(self, pid: str) -> dict:
        with self.lock:
            p = self.plazas[pid]
            cfg = self.cfg
            total_time = max(self.elapsed_s, 60.0)
            lane_h = sum(1 for t in p.lane_passes if (self.now - t).total_seconds() <= 3600)
            utilization_bays = p.bay_busy_s / max(1.0, len(p.bays) * total_time)
            lane_cap = cfg.lane_capacity_per_h()
            return {
                "id": p.id, "name": p.name, "kind": p.kind, "online": self._online(p), "edge_up": p.edge_up, "syncing": p.syncing, "outbox": len(p.outbox), "last_recovery_s": p.last_recovery_s,
                "link_down_since": p.link_down_since.isoformat() if not p.link_up and p.link_down_since else None,
                "processed": p.processed, "decisions": dict(p.decisions), "lane_visits": p.lane_visits, "static_visits": p.static_visits, "audits": p.audits,
                "lane_queue": p.lane_queue, "static_queue": p.static_queue, "held": len(p.held), "bays_total": len(p.bays), "bays_busy": sum(1 for b in p.bays if b is not None),
                "bay_utilization": round(utilization_bays, 4), "lane_throughput_h": lane_h, "lane_capacity_h": round(lane_cap, 1), "lane_utilization": round(lane_h / max(lane_cap, 1.0), 4),
                "avg_lane_min": round(sum(p.lane_times) / len(p.lane_times) / 60.0, 2) if p.lane_times else None, "avg_static_min": round(sum(p.static_times) / len(p.static_times) / 60.0, 2) if p.static_times else None,
                "availability_pct": round(100.0 * (1.0 - p.downtime_s / max(p.alive_s, 60.0)), 3), "gantry": self._gantry(p), "current_lane_truck": p.current_lane_truck, "last_lane_result": p.last_lane_result,
                "has_lane": p.geom.has_lane, "lane_open": p.lane_open,
                "trucks_here": [t.id for tr in p.tracks.values() for t in tr.trucks][:40],
                "lane_trucks": [{"id": t.id, "plate": t.plate, "s": round(t.s / max(p.tracks[k].line.length, 1), 3), "part": k, "state": t.state} for k in ("lane_approach", "lane_zone", "lane_exit") if k in p.tracks for t in p.tracks[k].trucks],
                "sensors_failed": [s.name for s in p.sensors.values() if s.status != "ok"],
            }

    def sensors_view(self, pid: str) -> dict:
        with self.lock:
            p = self.plazas[pid]
            return {
                "id": p.id, "name": p.name, "kind": p.kind, "online": self._online(p), "edge_up": p.edge_up, "syncing": p.syncing, "outbox": len(p.outbox), "last_recovery_s": p.last_recovery_s,
                "scheduled_restore": p.scheduled_restore.isoformat() if p.scheduled_restore else None,
                "sensors": [
                    {"id": s.id, "name": s.name, "kind": s.kind, "status": s.status, "sampling_khz": s.sampling_khz, "signal_quality": round(s.quality, 3), "temperature_c": round(s.temperature_c, 1), "drift_pct": round(s.drift_pct, 3), "comm_ok": s.comm_ok, "latency_ms": round(s.latency_ms, 1), "value": s.value, "unit": s.unit, "last_ok": s.last_ok.isoformat() if s.last_ok else None, "calibration_due": s.calibration_due.isoformat() if s.calibration_due else None}
                    for s in p.sensors.values()
                ],
            }

    def kpi(self) -> dict:
        with self.lock:
            c = self.counters
            exited = max(self.exited_today, 0)
            avg_clear = self.delay_sum_s / exited / 60.0 if exited else 0.0
            saved_h = (self.shadow_sum_s - self.delay_sum_s) / 3600.0
            sites = [p for p in self.plazas.values() if p.kind != "origin"]
            uptime = sum(1.0 - p.downtime_s / max(p.alive_s, 60.0) for p in sites) / max(len(sites), 1) * 100.0
            lats = list(self.lat_samples)
            lats.sort()
            return {
                "t": "kpi",
                "now": self.now.isoformat(),
                "elapsed_h": round(self.elapsed_s / 3600.0, 2),
                "running": self.running and not self.paused,
                "paused": self.paused,
                "speed": self.speed,
                "entered": c["entered"],
                "processed": c["green"] + c["amber"] + c["red"],
                "trucks_processed": c["exited"] + len(self.trucks),
                "trucks_active": len(self.trucks),
                "exited": c["exited"],
                "auto_cleared": c["auto_cleared"],
                "green": c["green"],
                "amber": c["amber"],
                "red": c["red"],
                "lane": c["lane"],
                "static": c["static"],
                "port_reweigh": c["port_reweigh"],
                "tokens_issued": c["tokens"],
                "tokens_active": self.registry.active_count(),
                "avg_clearance_min": round(avg_clear, 2),
                "avg_queue": round(self.queue_sum / self.queue_n, 3) if self.queue_n else 0.0,
                "truck_hours_saved": round(saved_h, 1),
                "token_coverage_pct": round(self.tokened_first / self.first_seen * 100.0, 1) if self.first_seen else 0.0,
                "uptime_pct": round(uptime, 3),
                "alerts_open": c["alerts"],
                "fail_safe": c["fail_safe"],
                "audits": c["audits"],
                "token_mismatch": c["token_mismatch"],
                "confirmed_overload": c["confirmed_overload"],
                "false_clears": c["false_clears"],
                "streams": dict(self.stream_counts),
                "stations": [
                    {"id": p.id, "name": p.name, "kind": p.kind, "online": self._online(p), "edge_up": p.edge_up, "processed": p.processed, "green": p.decisions["GREEN"], "amber": p.decisions["AMBER"], "red": p.decisions["RED"], "lane_queue": p.lane_queue, "static_queue": p.static_queue, "lane_visits": p.lane_visits, "static_visits": p.static_visits, "bay_utilization": round(p.bay_busy_s / max(1.0, len(p.bays) * max(self.elapsed_s, 60.0)), 4), "outbox": len(p.outbox), "syncing": p.syncing, "faults": sum(1 for s in p.sensors.values() if s.status != "ok")}
                    for p in self.plazas.values()
                ],
                "system": {
                    "messages": self.bus.published,
                    "events_generated": self.mq_gen,
                    "events_delivered": self.mq_delivered,
                    "queue_depth": sum(len(p.outbox) for p in self.plazas.values()),
                    "api_latency_p50_ms": round(lats[len(lats) // 2], 2) if lats else 0.0,
                    "api_latency_p95_ms": round(lats[int(len(lats) * 0.95)], 2) if lats else 0.0,
                    "failed_requests": self.failed_requests,
                    "registry_down": self.registry_down,
                    "kra_down": adapters.kra_down,
                    "step_ms": round(self.last_step_ms, 2),
                    "write_behind_written": write_behind.written if self.persist else 0,
                    "write_behind_errors": write_behind.errors if self.persist else 0,
                },
                "conservation": {"entered": self.lifetime["entered"], "exited": self.lifetime["exited"], "active": len(self.trucks), "balanced": self.lifetime["entered"] == self.lifetime["exited"] + len(self.trucks)},
                "scenario": self.scenario_view(),
            }

    def series(self) -> list[dict]:
        with self.lock:
            out = []
            now_i = int((self.now - self.day_start).total_seconds() / 900)
            for b in self.bins[: now_i + 1]:
                seen = b["seen"]
                out.append({"t": f"{b['i'] // 4:02d}:{(b['i'] % 4) * 15:02d}", "arrivals": b["arrivals"], "port": b["port"], "origin": b["origin"], "untokened": b["untokened"], "green": b["green"], "amber": b["amber"], "red": b["red"], "tokens": b["tokens"], "coverage": round(b["tokened_seen"] / seen * 100.0, 1) if seen else None, "avg_delay_min": round(b["delay_s"] / b["exits"] / 60.0, 2) if b["exits"] else None, "queue": round(b["queue"] / b["q_n"], 2) if b["q_n"] else 0.0, "availability": round(b["avail_sum"] / b["avail_n"] * 100.0, 1) if b["avail_n"] else None})
            return out

    # ------------------------------------------------------------------ scenarios
    def scenario_view(self) -> dict | None:
        if not self.scenario:
            return None
        s = self.scenario
        return {k: s[k] for k in ("id", "title", "truck", "status", "log", "summary")}

    def _scenario_log(self, text: str, kind: str = "INFO") -> None:
        if self.scenario:
            self.scenario["log"].append({"at": self.now.isoformat(), "text": text, "kind": kind})

    def _scenario_finish(self) -> None:
        if not self.scenario:
            return
        self.scenario["status"] = "complete"
        self.scenario_hook = None
        if self.saved_speed is not None:
            self.speed = self.saved_speed
            self.saved_speed = None

    def start_scenario(self, sid: str, speed: float = 6.0) -> dict:
        from .scenarios import SCENARIO_DEFS

        with self.lock:
            spec = SCENARIO_DEFS[sid]
            if self.saved_speed is None:
                self.saved_speed = self.speed
            self.speed = speed
            self.running, self.paused = True, False
            self.scenario = {"id": sid, "title": spec["title"], "summary": spec["summary"], "truck": None, "status": "running", "log": []}
            truck = spec["start"](self)
            self.scenario["truck"] = truck.id
            self._scenario_log(spec["summary"], "INFO")
            return self.scenario_view()

    def stop_scenario(self) -> None:
        with self.lock:
            self._scenario_finish()
            self.scenario = None

    def spawn_hero(self, vehicle: dict | None = None, **kw) -> Truck:
        with self.lock:
            kw.setdefault("hero", True)
            kw.setdefault("exact", True)
            vehicle = vehicle or self._draw_vehicle(kw.get("stream", "port"))
            return self.spawn(vehicle=vehicle, **kw)

    def inject_at_plaza(self, t: Truck, pid: str) -> None:
        """Moves a just-spawned truck to the entry of a plaza, with a route that ends at the exit of the section."""
        with self.lock:
            if t.track is not None:
                t.track.trucks.remove(t)
                t.track = None
            plan = t.plan
            i = plan.index("@" + pid) if "@" + pid in plan else None
            if i is None:
                t.plan = [f"@{pid}"]
                i = 0
            else:
                t.plan = plan[i:]
            t.plan_i = 0
            self._advance_plan(t, first=True)


def seed_registry_signers(registry: Registry) -> None:
    """Fresh keys for tests; the application loads wrapped keys from the database instead."""
    from ..domain.tokens import new_keypair

    for pid in PLAZAS:
        priv, _ = new_keypair()
        registry.add_signer(pid, priv)
