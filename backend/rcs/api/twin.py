"""Live twin control, stations, faults, lane, sensors, edge pipeline and the WebSocket stream."""
from __future__ import annotations

import asyncio
import json
import logging
import random
import secrets
import time

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db, session_factory
from ..models import User
from ..security import COOKIE, audit, current_user, require, user_from_token
from ..services.adapters import adapters
from ..sim.l1_sensor import edge_pipeline, synth_signal
from ..sim.network import network_json
from ..sim.params import PARAM_PROVENANCE, SimConfig
from ..sim.scenarios import SCENARIO_DEFS
from ..state import engine, state

log = logging.getLogger("rcs.ws")
router = APIRouter(prefix="/api")


class ControlIn(BaseModel):
    action: str = Field(pattern="^(start|pause|resume|reset|speed)$")
    speed: float | None = Field(default=None, ge=0.25, le=600)


@router.get("/twin/network", tags=["twin"])
def get_network(user: User = Depends(current_user)):
    return network_json()


@router.get("/live/kpi", tags=["live"])
def live_kpi(user: User = Depends(current_user)):
    return engine().kpi()


@router.get("/live/series", tags=["live"])
def live_series(user: User = Depends(current_user)):
    return {"series": engine().series(), "kind": "SIMULATED"}


@router.get("/live/events", tags=["live"])
def live_events(limit: int = 30, user: User = Depends(current_user)):
    with engine().lock:
        return {"events": list(engine().recent_events)[:limit], "alerts": list(engine().recent_alerts)[:20]}


@router.get("/live/frame", tags=["live"])
def live_frame(user: User = Depends(current_user)):
    return engine().frame()


@router.post("/live/control", tags=["live"])
def live_control(body: ControlIn, db: Session = Depends(get_db), user: User = Depends(require("live.control"))):
    e = engine()
    if body.action == "reset":
        state.reset_simulation()
    elif body.action == "speed":
        e.control("noop", body.speed)
    else:
        e.control(body.action, body.speed)
    audit(db, user.username, user.role, f"live.{body.action}", None, {"speed": body.speed})
    return e.kpi()


@router.get("/live/config", tags=["live"])
def get_config(user: User = Depends(current_user)):
    cfg = engine().cfg
    return {"config": cfg.model_dump(), "provenance": PARAM_PROVENANCE, "lane_capacity_per_h": round(cfg.lane_capacity_per_h(), 1), "lane_service_s": round(cfg.lane_service_s(), 2), "enrolment": cfg.enrolment()}


@router.put("/live/config", tags=["live"])
def put_config(body: dict, db: Session = Depends(get_db), user: User = Depends(require("live.control"))):
    try:
        cfg = SimConfig(**{**engine().cfg.model_dump(), **body})
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(422, f"Invalid configuration: {exc}") from exc
    engine().apply_config(cfg)
    state.persist_config("sim_config", cfg.model_dump())
    audit(db, user.username, user.role, "sim.config", None, body)
    return {"config": cfg.model_dump(), "lane_capacity_per_h": round(cfg.lane_capacity_per_h(), 1), "enrolment": cfg.enrolment()}


@router.get("/twin/trucks/{truck_id}", tags=["twin"])
def twin_truck(truck_id: str, user: User = Depends(current_user)):
    d = engine().truck_detail(truck_id)
    if d is None:
        raise HTTPException(404, "That truck has left the modelled corridor")
    return d


@router.get("/twin/stations", tags=["twin"])
def twin_stations(user: User = Depends(current_user)):
    e = engine()
    return {"stations": [e.station_view(pid) for pid in e.plazas]}


@router.get("/twin/stations/{pid}", tags=["twin"])
def twin_station(pid: str, user: User = Depends(current_user)):
    e = engine()
    if pid not in e.plazas:
        raise HTTPException(404, "Unknown station")
    return e.station_view(pid)


@router.get("/twin/scenarios", tags=["twin"])
def scenarios(user: User = Depends(current_user)):
    return {"scenarios": [{"id": k, "title": v["title"], "summary": v["summary"], "expect": v["expect"]} for k, v in SCENARIO_DEFS.items()], "active": engine().scenario_view()}


class ScenarioIn(BaseModel):
    speed: float = Field(6.0, ge=0.5, le=60)


@router.post("/twin/scenarios/{sid}/start", tags=["twin"])
def scenario_start(sid: str, body: ScenarioIn, db: Session = Depends(get_db), user: User = Depends(require("live.control"))):
    if sid not in SCENARIO_DEFS:
        raise HTTPException(404, "Unknown scenario")
    view = engine().start_scenario(sid, body.speed)
    audit(db, user.username, user.role, "scenario.start", sid)
    return view


@router.post("/twin/scenarios/stop", tags=["twin"])
def scenario_stop(user: User = Depends(require("live.control"))):
    engine().stop_scenario()
    return {"ok": True}


# ------------------------------------------------------------------ faults
class SensorStatusIn(BaseModel):
    status: str = Field(pattern="^(ok|fault|disabled)$")


@router.post("/faults/{site}/sensor/{sensor}", tags=["faults"])
def fault_sensor(site: str, sensor: str, body: SensorStatusIn, db: Session = Depends(get_db), user: User = Depends(require("faults.inject"))):
    e = engine()
    if site not in e.plazas or sensor not in e.plazas[site].sensors:
        raise HTTPException(404, "Unknown site or sensor")
    res = e.set_sensor(site, sensor, body.status)
    audit(db, user.username, user.role, "fault.sensor", f"{site}/{sensor}", {"status": body.status})
    return res


class LinkIn(BaseModel):
    up: bool
    duration_min: float | None = Field(default=None, ge=1, le=1440)


@router.post("/faults/{site}/network", tags=["faults"])
def fault_network(site: str, body: LinkIn, db: Session = Depends(get_db), user: User = Depends(require("faults.inject"))):
    e = engine()
    if site not in e.plazas:
        raise HTTPException(404, "Unknown site")
    e.set_link(site, body.up, body.duration_min)
    audit(db, user.username, user.role, "fault.network", site, body.model_dump())
    return e.station_view(site)


class GlobalFaultIn(BaseModel):
    registry_down: bool | None = None
    agency_down: bool | None = None


@router.post("/faults/global", tags=["faults"])
def fault_global(body: GlobalFaultIn, db: Session = Depends(get_db), user: User = Depends(require("faults.inject"))):
    e = engine()
    with e.lock:
        if body.registry_down is not None:
            was = e.registry_down
            e.registry_down = body.registry_down
            if body.registry_down and not was:
                for p in e.plazas.values():
                    if p.link_up:
                        p.link_down_since = e.now
                e.alert("critical", "system", None, "Token service unavailable", "Every site is verifying from its edge cache. Records queue locally.", key="registry", quiet_min=1)
            elif was and not body.registry_down:
                for p in e.plazas.values():
                    p.syncing, p.sync_started, p.sync_backlog = True, e.now, len(p.outbox)
                e.alert("info", "system", None, "Token service restored", "Queued records are synchronizing.", key="registry+", quiet_min=1)
        if body.agency_down is not None:
            adapters.kra_down = body.agency_down
            if body.agency_down:
                e.alert("critical", "system", "port_node", "Mock customs API unavailable", "Release status cannot be confirmed: port trucks fail safe to the re-weigh lane.", key="agency", quiet_min=1)
    audit(db, user.username, user.role, "fault.global", None, body.model_dump())
    return {"registry_down": e.registry_down, "agency_down": adapters.kra_down}


# ------------------------------------------------------------------ lane
LANE_CASES = {
    "normal": {"title": "Normal verification", "kw": {"ratio": 0.82}},
    "overloaded": {"title": "Overloaded truck", "kw": {"ratio": 1.09}},
    "dimension_breach": {"title": "Dimension breach", "kw": {"ratio": 0.8, "height": 4.72}},
    "lifted_axle": {"title": "Lifted axle", "kw": {"ratio": 0.85, "lifted": True}},
    "rfid_failure": {"title": "RFID failure", "kw": {"ratio": 0.8, "no_read": {"rfid"}}},
    "anpr_failure": {"title": "ANPR failure", "kw": {"ratio": 0.8, "no_read": {"anpr"}}},
    "sensor_malfunction": {"title": "Sensor malfunction", "kw": {"ratio": 0.8, "no_read": {"lane_scale"}}},
    "random_audit": {"title": "Random audit", "kw": {"ratio": 0.8}},
}


class LaneInject(BaseModel):
    case: str


@router.get("/lane/{station}", tags=["lane"])
def lane_view(station: str, user: User = Depends(current_user)):
    e = engine()
    if station not in e.plazas or not e.plazas[station].geom.has_lane:
        raise HTTPException(404, "That site has no Rolling Verification Lane")
    cfg = e.cfg
    view = e.station_view(station)
    view["design"] = {"target_speed_kmh": cfg.lane_speed_kmh, "max_speed_kmh": 15, "headway_m": cfg.lane_headway_m, "pass_min": cfg.lane_pass_min, "capacity_per_h": round(cfg.lane_capacity_per_h(), 1), "service_s": round(cfg.lane_service_s(), 2), "static_min_per_truck": cfg.static_service_min(), "static_capacity_per_h_per_lane": round(60.0 / cfg.static_service_min(), 1), "ratio_to_static_lane": round(cfg.lane_capacity_per_h() / (60.0 / cfg.static_service_min()), 1)}
    view["cases"] = [{"id": k, "title": v["title"]} for k, v in LANE_CASES.items()]
    with e.lock:
        ev = [x for x in e.recent_events if x["site"] == station and x["stage"] == "LANE"][:12]
    view["recent"] = ev
    return view


@router.post("/lane/{station}/inject", tags=["lane"])
def lane_inject(station: str, body: LaneInject, db: Session = Depends(get_db), user: User = Depends(require("lane.test"))):
    e = engine()
    if station not in e.plazas or not e.plazas[station].geom.has_lane:
        raise HTTPException(404, "That site has no Rolling Verification Lane")
    if body.case not in LANE_CASES:
        raise HTTPException(422, "Unknown lane test case")
    with e.lock:
        kw = dict(LANE_CASES[body.case]["kw"])
        t = e.spawn_hero(stream="untokened", enrolled=False, route="spot_kaloleni", force_audit={station}, **kw)
        t.plan = [f"@{station}", "mk_exit" if station == "mariakani" else ("dk_j2" if station == "dongo_kundu" else "mt_exit")]
        e.inject_at_plaza(t, station)
    audit(db, user.username, user.role, "lane.test", station, {"case": body.case, "truck": t.id})
    return {"truck": t.id, "plate": t.plate, "case": body.case, "title": LANE_CASES[body.case]["title"]}


# ------------------------------------------------------------------ sensors
@router.get("/sensors", tags=["sensors"])
def sensors_all(user: User = Depends(current_user)):
    e = engine()
    return {"sites": [e.sensors_view(pid) for pid in e.plazas], "demo": "Simulated sensor stream. No physical devices are attached."}


@router.get("/sensors/{site}", tags=["sensors"])
def sensors_site(site: str, user: User = Depends(current_user)):
    e = engine()
    if site not in e.plazas:
        raise HTTPException(404, "Unknown site")
    return e.sensors_view(site)


class PipelineIn(BaseModel):
    speed_kmh: float = Field(80, ge=5, le=100)
    sampling_khz: float = Field(5, ge=0.5, le=10)
    noise_pct: float = Field(0.6, ge=0, le=10)
    temperature_c: float = Field(35, ge=-5, le=70)
    lifted: bool = False
    load_ratio: float = Field(0.85, ge=0.2, le=1.3)


@router.post("/sensors/pipeline/run", tags=["sensors"])
def pipeline(body: PipelineIn, user: User = Depends(current_user)):
    """Runs the ten edge stages on a synthetic signal. The stage timings are real timings of this code on this machine."""
    limit_t = [8000.0, 9000.0, 9000.0, 8000.0, 8000.0, 8000.0]
    axles = [x * body.load_ratio * (0.98 + 0.04 * random.random()) for x in limit_t]
    registered = 6
    if body.lifted:
        lifted = axles.pop()
        axles[-1] += lifted / 2
        axles[-2] += lifted / 2
    raw = synth_signal(sum(axles), axles, body.speed_kmh, body.sampling_khz, body.noise_pct, body.temperature_c, seed=random.randrange(1 << 30))
    out = edge_pipeline(raw, registered, body.temperature_c)
    out["true_gross_kg"] = round(sum(axles))
    out["error_pct"] = round((out["gross_estimate_kg"] - sum(axles)) / sum(axles) * 100.0, 2)
    out["kind"] = "SIMULATED signal, real processing"
    out["design_sampling_khz"] = "5-10"
    return out


# ------------------------------------------------------------------ websocket
class Hub:
    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()

    async def broadcast(self, payload: dict) -> None:
        if not self.clients:
            return
        text = json.dumps(payload, separators=(",", ":"), default=str)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_text(text)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)


hub = Hub()


# Browsers do not send the Lax session cookie to an API on another site, so a frontend hosted separately
# trades its proxied session for a ticket. Tickets are single use, expire quickly and live in this process.
WS_TICKET_SECONDS = 30
_ws_tickets: dict[str, tuple[str, float]] = {}


@router.post("/ws/ticket", tags=["twin"])
def ws_ticket(user: User = Depends(current_user)):
    now = time.monotonic()
    for key, (_, expires) in list(_ws_tickets.items()):
        if expires < now:
            _ws_tickets.pop(key, None)
    ticket = secrets.token_urlsafe(32)
    _ws_tickets[ticket] = (user.id, now + WS_TICKET_SECONDS)
    return {"ticket": ticket, "expires_in": WS_TICKET_SECONDS}


@router.websocket("/ws/live")
async def ws_live(ws: WebSocket):
    Session_ = session_factory()
    ticket = ws.query_params.get("ticket")
    with Session_() as db:
        if ticket:
            entry = _ws_tickets.pop(ticket, None)
            user = db.get(User, entry[0]) if entry and entry[1] >= time.monotonic() else None
            if user is not None and not user.active:
                user = None
        else:
            user = user_from_token(db, ws.cookies.get(COOKIE))
    if user is None:
        await ws.close(code=4401)
        return
    await ws.accept()
    hub.clients.add(ws)
    try:
        await ws.send_text(json.dumps(engine().kpi(), default=str))
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(ws)


async def simulation_loop() -> None:
    """Fixed 10 Hz tick. Frames go out at 5 Hz and KPIs at 1 Hz. Decision events and alerts go out as they occur."""
    tick = 0.1
    n = 0
    loop = asyncio.get_running_loop()
    last = loop.time()
    while True:
        await asyncio.sleep(tick)
        e = engine()
        t = loop.time()
        wall = min(t - last, 0.5)
        last = t
        try:
            if e.running and not e.paused:
                await asyncio.to_thread(e.step, wall * e.speed)
            n += 1
            if hub.clients:
                if n % 2 == 0:
                    await hub.broadcast(e.frame())
                if n % 10 == 0:
                    await hub.broadcast(e.kpi())
                with e.lock:
                    events = list(e.events_out)
                    alerts = list(e.alerts_out)
                    e.events_out.clear()
                    e.alerts_out.clear()
                if events:
                    await hub.broadcast({"t": "events", "events": events[-30:]})
                if alerts:
                    await hub.broadcast({"t": "alerts", "alerts": alerts})
            else:
                with e.lock:
                    e.events_out.clear()
                    e.alerts_out.clear()
        except Exception:  # noqa: BLE001
            log.exception("simulation tick failed")
