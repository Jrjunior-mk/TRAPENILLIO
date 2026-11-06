"""Operator-driven clearance: the forms in Module C. Same decision functions and registry as the live engine."""
from __future__ import annotations

import random

from fastapi import HTTPException
from pydantic import BaseModel, Field

from ..domain import decision as D
from ..domain.vehicle import axle_count, container_valid, gross_limit_for, groups_for
from ..sim.live import LiveEngine, Truck
from ..sim.network import ROUTE_DEST
from .adapters import adapters


class CommonIn(BaseModel):
    plate: str = Field(min_length=3, max_length=16)
    plate_read: str | None = None
    rfid_read: str | None = None
    trailer_read: str | None = None
    gross_kg: float | None = Field(default=None, gt=0, le=200000)
    axle_loads_kg: list[float] | None = None
    height_m: float | None = Field(default=None, gt=0, le=10)
    width_m: float | None = Field(default=None, gt=0, le=6)
    length_m: float | None = Field(default=None, gt=0, le=40)
    site: str | None = None


class PortIn(CommonIn):
    container: str | None = None
    declared_cargo_kg: float | None = Field(default=None, ge=0)
    container_tare_kg: float | None = Field(default=3800, ge=0)
    destination: str | None = "Nairobi via Northern Corridor"


class OriginIn(CommonIn):
    site: str = "origin_quarry"
    ticket_signature_valid: bool = True
    scale_approved: bool | None = None
    calibration_valid: bool | None = None
    onboard_only: bool = False
    cargo: str | None = None
    destination: str | None = "Nairobi via Northern Corridor"


class RoadIn(CommonIn):
    site: str = "mariakani"
    axles_detected: int | None = None
    quality: float | None = Field(default=0.95, ge=0, le=1)
    audit: bool | None = None


class LaneIn(RoadIn):
    lifted_axle: bool = False


def _truck(engine: LiveEngine, plate: str, stream: str) -> Truck:
    v = engine.vehicles.get(plate.upper())
    if v is None:
        raise HTTPException(404, f"{plate} is not registered. Register the vehicle first.")
    return Truck(id=f"OP-{plate.replace(' ', '')}", plate=v["plate"], trailer=v.get("trailer"), rfid=v.get("rfid"), stream=stream, config=v["config"], route="port_nairobi" if stream == "port" else "cement_nairobi", plan=[], enrolled=True, tractor_tare=v["tractor_tare"], trailer_tare=v["trailer_tare"], height=v["height"], width=v["width"], length=v["length"], fleet=v.get("fleet"), fleet_id=v.get("fleet_id"), driver=v.get("driver"), permit=v.get("permit"), demerits=v.get("demerits", 0), exact=True, source_tag="operator")


def _axles(body: CommonIn, config: str, engine: LiveEngine) -> list[float] | None:
    n = axle_count(config)
    if body.axle_loads_kg:
        if len(body.axle_loads_kg) not in (n, n - 1):
            raise HTTPException(422, f"Expected {n} axle loads for configuration {config}")
        return body.axle_loads_kg
    if body.gross_kg is None:
        return None
    # Only gross was supplied: spread it in proportion to the group limits.
    gs = groups_for(config, engine.policy)
    limit = sum(g.limit_kg for g in gs)
    out: list[float] = []
    for g in gs:
        out += [body.gross_kg * g.limit_kg / limit / g.axles] * g.axles
    return out


def _measure(body: CommonIn, t: Truck, engine: LiveEngine, default_faults: str | None = None) -> D.Measurement:
    gross = body.gross_kg
    axles = _axles(body, t.config, engine)
    if gross is None and axles:
        gross = sum(axles)
    return D.Measurement(gross_kg=gross, axle_loads_kg=axles, height_m=body.height_m, width_m=body.width_m, length_m=body.length_m, quality=None, sensor_fault=default_faults if gross is None else None)


def _ids(body: CommonIn, t: Truck) -> D.IdentityReads:
    return D.IdentityReads(body.plate_read, body.rfid_read, body.trailer_read, t.plate, t.rfid, t.trailer, t.config)


def _reply(t: Truck, d: D.Decision, token, m: D.Measurement, extra: dict | None = None) -> dict:
    out = {"decision": d.to_dict(), "token": None, "gross_kg": m.gross_kg, "plate": t.plate, "demo_data": True}
    if token is not None:
        out["token"] = {"token_id": token.token_id, "status": token.status, "source": token.payload["source"], "signature": token.signature, "kid": token.kid, "valid_until": token.payload["valid_until"]}
    if extra:
        out.update(extra)
    return out


def process_port(engine: LiveEngine, body: PortIn) -> dict:
    with engine.lock:
        t = _truck(engine, body.plate, "port")
        p = engine.plazas["port_node"]
        t.container = body.container
        ok_num = container_valid(body.container)
        release = adapters.release_status(body.container)
        seal = adapters.eseal(body.container)
        t.eseal = seal["eseal_id"]
        t.release = release
        expected = None
        if body.declared_cargo_kg is not None:
            expected = t.tractor_tare + t.trailer_tare + (body.container_tare_kg or 0.0) + body.declared_cargo_kg
        m = _measure(body, t, engine, "No scale reading supplied")
        d = D.decide_port(m, _ids(body, t), engine.policy, t.config, adapters.release_ok(release), expected, container_ok=ok_num, permit=None, demerits=t.demerits, truck_tare_kg=t.tractor_tare + t.trailer_tare)
        token = None
        if d.outcome == D.Outcome.GREEN:
            t.destination = body.destination
            token = engine._issue(t, p, "port", m, engine.policy.validity_port_h, expected)
        engine._record(t, p, d, m)
        return _reply(t, d, token, m, {"release": release, "eseal": seal, "expected_gross_kg": expected, "container_check_ok": ok_num, "adapters": "MOCK: KRA, KPA and e-seal responses are mock data"})


def process_origin(engine: LiveEngine, body: OriginIn) -> dict:
    with engine.lock:
        if body.site not in engine.plazas or engine.plazas[body.site].kind != "origin":
            raise HTTPException(422, "Choose an origin weigh node")
        t = _truck(engine, body.plate, "origin")
        p = engine.plazas[body.site]
        m = _measure(body, t, engine, "No scale reading supplied")
        approved = p.scale_approved if body.scale_approved is None else body.scale_approved
        calibrated = p.calibration_valid if body.calibration_valid is None else body.calibration_valid
        d = D.decide_origin(m, _ids(body, t), engine.policy, t.config, approved, calibrated, body.ticket_signature_valid, site_suspended=p.suspended, onboard_only=body.onboard_only, demerits=t.demerits)
        token = None
        if d.outcome == D.Outcome.GREEN:
            t.destination = body.destination
            t.release = {"cargo": body.cargo, "ticket_signed": body.ticket_signature_valid, "adapter": "DEMO"}
            token = engine._issue(t, p, "origin", m, engine.policy.validity_origin_h, None)
        engine._record(t, p, d, m)
        return _reply(t, d, token, m)


def _token_for(engine: LiveEngine, t: Truck, ids: D.IdentityReads, site: str):
    p = engine.plazas[site]
    online = engine._online(p)
    return engine.registry.lookup(ids.plate_read or t.plate, ids.tag_read, engine.now, online, p.link_down_since if not online else None), online


def process_road(engine: LiveEngine, body: RoadIn) -> dict:
    with engine.lock:
        if body.site not in engine.plazas or engine.plazas[body.site].kind != "road":
            raise HTTPException(422, "Choose a road station")
        t = _truck(engine, body.plate, "untokened")
        p = engine.plazas[body.site]
        ids = _ids(body, t)
        m = _measure(body, t, engine, "No WIM reading supplied")
        m.axles_detected = body.axles_detected if body.axles_detected is not None else (axle_count(t.config) if m.gross_kg else None)
        m.quality = body.quality
        (token, why), online = _token_for(engine, t, ids, body.site)
        audit = body.audit if body.audit is not None else random.random() < D.audit_rate_pct(engine.policy, token.trust_tier if token else 3, t.demerits) / 100.0
        d = D.decide_road(m, ids, engine.policy, t.config, token, audit_selected=audit, demerits=t.demerits, lane_available=p.lane_open, token_lookup_failed=why is not None)
        if not p.edge_up:
            d = engine._edge_failsafe(p, "ROAD")
        engine._record(t, p, d, m, token_id=token.token_id if token else None, offline=not online)
        if token is not None:
            engine.registry.record_verification(token.token_id, p.id, engine.now, d.outcome.value, {"checks": [c.__dict__ for c in d.checks if c.code == "token"]}, "operator", offline=not online)
        issued = None
        if d.issue_token:
            issued = engine._issue(t, p, "road", m, engine.policy.validity_road_h, None, online=online)
        return _reply(t, d, issued, m, {"token_checked": token.token_id if token else None, "offline": not online})


def process_lane(engine: LiveEngine, body: LaneIn) -> dict:
    with engine.lock:
        if body.site not in engine.plazas or not engine.plazas[body.site].geom.has_lane:
            raise HTTPException(422, "Choose a station with a Rolling Verification Lane")
        t = _truck(engine, body.plate, "untokened")
        p = engine.plazas[body.site]
        ids = _ids(body, t)
        m = _measure(body, t, engine, "No lane reading supplied")
        m.quality = body.quality
        m.lifted_axle = body.lifted_axle
        (token, _), online = _token_for(engine, t, ids, body.site)
        d = D.decide_lane(m, ids, engine.policy, t.config, token, demerits=t.demerits)
        engine._record(t, p, d, m, token_id=token.token_id if token else None, offline=not online)
        issued = None
        if d.outcome == D.Outcome.GREEN:
            issued = engine._issue(t, p, "lane", m, engine.policy.validity_road_h, None, online=online)
        return _reply(t, d, issued, m)


SAMPLES = {
    "port": {"plate_hint": "first registered vehicle", "container": "MSCU6639870", "declared_cargo_kg": 21500, "container_tare_kg": 3800, "gross_kg": 41000, "height_m": 4.1, "width_m": 2.5, "length_m": 17.0},
    "origin": {"site": "origin_quarry", "gross_kg": 39000, "height_m": 4.0, "width_m": 2.5, "length_m": 16.8, "ticket_signature_valid": True, "cargo": "Ballast"},
    "road": {"site": "mariakani", "gross_kg": 38500, "height_m": 4.05, "width_m": 2.5, "length_m": 17.0, "quality": 0.95},
}
