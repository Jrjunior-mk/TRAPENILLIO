"""Auth, trucks, clearance, tokens, decision engine and policy."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Cookie, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db, write_behind
from ..domain import decision as D
from ..domain.policy import POLICY_PROVENANCE, Policy
from ..domain.tokens import LIFECYCLE, b64u, b64u_dec, can_transition, parse_iso, verify_signature
from ..domain.vehicle import AXLE_CONFIGS, effective_config_with_lift, gross_limit_for, groups_for
from ..models import ClearanceEvent, Fleet, Site, Token, TokenEvent, User, Vehicle
from ..security import COOKIE, ROLES, audit, create_session, current_user, decrypt_field, destroy_session, encrypt_field, has_permission, permissions_for, require, verify_password
from ..seed import vehicle_dict
from ..services import clearance as C
from ..services.adapters import adapters
from ..state import engine, state
from .common import event_json, iso

router = APIRouter(prefix="/api")


# ------------------------------------------------------------------ auth
class LoginIn(BaseModel):
    username: str
    password: str


def user_json(u: User) -> dict:
    return {"id": u.id, "username": u.username, "display_name": u.display_name, "role": u.role, "role_label": ROLES.get(u.role, u.role), "org": u.org, "fleet_id": u.fleet_id, "site_id": u.site_id, "permissions": permissions_for(u.role)}


@router.post("/auth/login", tags=["auth"])
def login(body: LoginIn, response: Response, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.username == body.username.strip().lower()))
    if not user or not user.active or not verify_password(body.password, user.password_hash):
        audit(db, body.username[:64], "anonymous", "auth.login_failed")
        raise HTTPException(401, "Incorrect username or password")
    token = create_session(db, user)
    s = get_settings()
    response.set_cookie(COOKIE, token, httponly=True, samesite="lax", secure=s.cookie_secure, max_age=s.session_hours * 3600, path="/")
    audit(db, user.username, user.role, "auth.login")
    return user_json(user)


@router.post("/auth/logout", tags=["auth"])
def logout(response: Response, db: Session = Depends(get_db), rcs_session: str | None = Cookie(default=None)):
    if rcs_session:
        destroy_session(db, rcs_session)
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/auth/me", tags=["auth"])
def me(user: User = Depends(current_user)):
    return user_json(user)


# ------------------------------------------------------------------ trucks
class VehicleIn(BaseModel):
    tractor_plate: str = Field(pattern=r"^[A-Z]{3} ?\d{3}[A-Z]$", description="Kenyan format, e.g. KDA 123A")
    trailer_plate: str | None = Field(default=None, pattern=r"^Z[A-Z] ?\d{4}$")
    rfid_tag: str | None = Field(default=None, min_length=6, max_length=32)
    axle_config: str = "1-2-3"
    tractor_tare_kg: float = Field(gt=1000, lt=20000)
    trailer_tare_kg: float = Field(ge=0, lt=20000)
    height_m: float = Field(gt=1, le=6)
    width_m: float = Field(gt=1, le=4)
    length_m: float = Field(gt=3, le=40)
    fleet_id: int | None = None
    permit_ref: str | None = None
    driver_name: str | None = None


def _scope(user: User, stmt):
    if has_permission(user, "truck.view_all"):
        return stmt
    if user.role == "transporter":
        return stmt.where(Vehicle.fleet_id == user.fleet_id)
    return stmt


def vehicle_json(v: Vehicle, fleet: str | None, include_pii: bool = False) -> dict:
    d = vehicle_dict(v, fleet)
    d.update({"id": v.id, "enrolled": v.enrolled, "driver_ref": v.driver_ref, "mock_ntsa": adapters.ntsa_vehicle(v.tractor_plate)})
    if include_pii:
        d["driver_name"] = decrypt_field(v.driver_name_enc)
    return d


@router.get("/trucks", tags=["trucks"])
def list_trucks(q: str | None = None, fleet_id: int | None = None, limit: int = Query(50, le=200), offset: int = 0, db: Session = Depends(get_db), user: User = Depends(current_user)):
    stmt = _scope(user, select(Vehicle, Fleet.name).join(Fleet, Vehicle.fleet_id == Fleet.id, isouter=True))
    if q:
        like = f"%{q.upper()}%"
        stmt = stmt.where(or_(Vehicle.tractor_plate.like(like), Vehicle.trailer_plate.like(like), Vehicle.rfid_tag.like(like)))
    if fleet_id:
        stmt = stmt.where(Vehicle.fleet_id == fleet_id)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.execute(stmt.order_by(Vehicle.tractor_plate).offset(offset).limit(limit)).all()
    return {"total": total, "items": [vehicle_json(v, f) for v, f in rows]}


@router.get("/trucks/options", tags=["trucks"])
def truck_options(db: Session = Depends(get_db), user: User = Depends(current_user)):
    return {"axle_configs": AXLE_CONFIGS, "fleets": [{"id": f.id, "name": f.name} for f in db.scalars(select(Fleet).order_by(Fleet.name))], "samples": C.SAMPLES, "sites": [{"id": s.id, "name": s.name, "kind": s.kind, "origin_type": s.origin_type} for s in db.scalars(select(Site))]}


@router.post("/trucks", tags=["trucks"])
def register_truck(body: VehicleIn, db: Session = Depends(get_db), user: User = Depends(require("truck.register"))):
    plate = body.tractor_plate if " " in body.tractor_plate else body.tractor_plate[:3] + " " + body.tractor_plate[3:]
    if body.axle_config not in AXLE_CONFIGS:
        raise HTTPException(422, f"Axle configuration must be one of {AXLE_CONFIGS}")
    if db.scalar(select(Vehicle).where(Vehicle.tractor_plate == plate)):
        raise HTTPException(409, f"{plate} is already registered")
    if body.rfid_tag and db.scalar(select(Vehicle).where(Vehicle.rfid_tag == body.rfid_tag)):
        raise HTTPException(409, "That RFID tag is bound to another vehicle")
    fleet_id = user.fleet_id if user.role == "transporter" else body.fleet_id
    v = Vehicle(tractor_plate=plate, trailer_plate=body.trailer_plate, rfid_tag=body.rfid_tag, axle_config=body.axle_config, tractor_tare_kg=body.tractor_tare_kg, trailer_tare_kg=body.trailer_tare_kg, height_m=body.height_m, width_m=body.width_m, length_m=body.length_m, fleet_id=fleet_id, permit_ref=body.permit_ref, driver_ref=f"DRV-{abs(hash(plate)) % 100000:05d}", driver_name_enc=encrypt_field(body.driver_name), created_at=datetime.now(timezone.utc))
    db.add(v)
    db.flush()
    audit(db, user.username, user.role, "truck.register", plate, commit=False)
    db.commit()
    fleet = db.get(Fleet, fleet_id) if fleet_id else None
    engine().add_vehicle(vehicle_dict(v, fleet.name if fleet else None))
    return vehicle_json(v, fleet.name if fleet else None)


@router.get("/trucks/{plate}", tags=["trucks"])
def truck_profile(plate: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    plate = plate.upper()
    v = db.scalar(select(Vehicle).where(Vehicle.tractor_plate == plate))
    if not v:
        raise HTTPException(404, f"{plate} is not registered")
    if not has_permission(user, "truck.view_all") and user.role == "transporter" and v.fleet_id != user.fleet_id:
        raise HTTPException(403, "This vehicle belongs to another fleet")
    write_behind.flush(3)
    fleet = db.get(Fleet, v.fleet_id) if v.fleet_id else None
    events = db.scalars(select(ClearanceEvent).where(ClearanceEvent.plate == plate).order_by(ClearanceEvent.at.desc()).limit(40)).all()
    tokens = db.scalars(select(Token).where(Token.tractor_plate == plate).order_by(Token.issued_at.desc()).limit(20)).all()
    live = None
    with engine().lock:
        for t in engine().trucks.values():
            if t.plate == plate:
                live = t.id
                break
    return {"vehicle": vehicle_json(v, fleet.name if fleet else None, include_pii=user.role in ("admin", "kenha", "ntsa")), "gross_limit_kg": gross_limit_for(v.axle_config, engine().policy), "groups": [{"kind": g.kind, "axles": g.axles, "limit_kg": g.limit_kg} for g in groups_for(v.axle_config, engine().policy)], "events": [event_json(e) for e in events], "tokens": [token_json(t) for t in tokens], "live_truck": live, "demo_data": True}


# ------------------------------------------------------------------ clearance
@router.post("/clearance/port", tags=["clearance"])
def clear_port(body: C.PortIn, db: Session = Depends(get_db), user: User = Depends(require("clear.port"))):
    out = C.process_port(engine(), body)
    audit(db, user.username, user.role, "clearance.port", body.plate, {"outcome": out["decision"]["outcome"], "token": (out["token"] or {}).get("token_id")})
    return out


@router.post("/clearance/origin", tags=["clearance"])
def clear_origin(body: C.OriginIn, db: Session = Depends(get_db), user: User = Depends(require("clear.origin"))):
    out = C.process_origin(engine(), body)
    audit(db, user.username, user.role, "clearance.origin", body.plate, {"outcome": out["decision"]["outcome"], "token": (out["token"] or {}).get("token_id")})
    return out


@router.post("/clearance/road", tags=["clearance"])
def clear_road(body: C.RoadIn, db: Session = Depends(get_db), user: User = Depends(require("clear.road"))):
    out = C.process_road(engine(), body)
    audit(db, user.username, user.role, "clearance.road", body.plate, {"outcome": out["decision"]["outcome"]})
    return out


@router.post("/clearance/lane", tags=["clearance"])
def clear_lane(body: C.LaneIn, db: Session = Depends(get_db), user: User = Depends(require("clear.road"))):
    out = C.process_lane(engine(), body)
    audit(db, user.username, user.role, "clearance.lane", body.plate, {"outcome": out["decision"]["outcome"]})
    return out


@router.get("/clearance/events", tags=["clearance"])
def clearance_events(site: str | None = None, outcome: str | None = None, plate: str | None = None, stream: str | None = None, stage: str | None = None, limit: int = Query(50, le=300), offset: int = 0, db: Session = Depends(get_db), user: User = Depends(current_user)):
    stmt = select(ClearanceEvent)
    if site:
        stmt = stmt.where(ClearanceEvent.site == site)
    if outcome:
        stmt = stmt.where(ClearanceEvent.outcome == outcome)
    if plate:
        stmt = stmt.where(ClearanceEvent.plate.like(f"%{plate.upper()}%"))
    if stream:
        stmt = stmt.where(ClearanceEvent.stream == stream)
    if stage:
        stmt = stmt.where(ClearanceEvent.stage == stage)
    if user.role == "transporter":
        plates = select(Vehicle.tractor_plate).where(Vehicle.fleet_id == user.fleet_id)
        stmt = stmt.where(ClearanceEvent.plate.in_(plates))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(ClearanceEvent.at.desc()).offset(offset).limit(limit)).all()
    return {"total": total, "items": [event_json(e) for e in rows]}


@router.get("/clearance/events/{event_id}", tags=["clearance"])
def clearance_event(event_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    e = db.get(ClearanceEvent, event_id)
    if not e:
        raise HTTPException(404, "Event not found")
    if user.role == "transporter":
        _check_fleet(db, user, e.plate)
    return event_json(e)


# ------------------------------------------------------------------ tokens
def token_json(t: Token, include_payload: bool = False) -> dict:
    p = t.payload
    live = engine().registry.tokens.get(t.token_id)
    status = live.status if live else t.status
    d = {"token_id": t.token_id, "status": status, "status_reason": live.reason if live else t.status_reason, "tractor_plate": t.tractor_plate, "trailer_plate": p.get("trailer_plate"), "rfid_tag": t.rfid_tag, "container_number": t.container_number, "eseal_id": p.get("eseal_id"), "source": t.source, "trust_tier": t.trust_tier, "origin_station": t.origin_station, "gross_kg": t.gross_kg, "expected_gross_kg": p.get("expected_gross_kg"), "variance_pct": p.get("variance_pct"), "issued_at": p.get("issued_at"), "valid_until": p.get("valid_until"), "origin": t.origin, "destination": p.get("destination")}
    if include_payload:
        d["payload"] = p
        d["signature"] = t.signature
        d["kid"] = t.kid
    return d


@router.get("/tokens", tags=["tokens"])
def list_tokens(q: str | None = None, status: str | None = None, source: str | None = None, tier: int | None = None, station: str | None = None, limit: int = Query(50, le=200), offset: int = 0, db: Session = Depends(get_db), user: User = Depends(require("token.view"))):
    write_behind.flush(2)
    stmt = select(Token)
    if q:
        like = f"%{q.upper()}%"
        stmt = stmt.where(or_(Token.token_id.like(like), Token.tractor_plate.like(like), Token.container_number.like(like), Token.rfid_tag.like(like)))
    if status:
        stmt = stmt.where(Token.status == status)
    if source:
        stmt = stmt.where(Token.source == source)
    if tier:
        stmt = stmt.where(Token.trust_tier == tier)
    if station:
        stmt = stmt.where(Token.origin_station == station)
    if user.role == "transporter":
        stmt = stmt.where(Token.tractor_plate.in_(select(Vehicle.tractor_plate).where(Vehicle.fleet_id == user.fleet_id)))
    if user.role == "loader" and user.site_id:
        stmt = stmt.where(Token.origin_station == user.site_id)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(Token.issued_at.desc()).offset(offset).limit(limit)).all()
    count_stmt = select(Token.status, func.count()).group_by(Token.status)
    if user.role == "transporter":
        count_stmt = count_stmt.where(Token.tractor_plate.in_(select(Vehicle.tractor_plate).where(Vehicle.fleet_id == user.fleet_id)))
    if user.role == "loader" and user.site_id:
        count_stmt = count_stmt.where(Token.origin_station == user.site_id)
    counts = dict(db.execute(count_stmt).all())
    return {"total": total, "items": [token_json(t) for t in rows], "counts": counts, "lifecycle": list(LIFECYCLE)}


@router.get("/tokens/keys", tags=["tokens"])
def token_keys(db: Session = Depends(get_db)):
    """Public verification keys. Anyone can check a token offline with these (Ed25519, canonical JSON)."""
    return {"alg": "Ed25519", "canonicalization": "JSON, sorted keys, no whitespace, UTF-8", "keys": [{"kid": s.id, "site": s.name, "public_key": s.public_key} for s in db.scalars(select(Site))]}


def _check_fleet(db: Session, user: User, plate: str) -> None:
    v = db.scalar(select(Vehicle).where(Vehicle.tractor_plate == plate))
    if not v or v.fleet_id != user.fleet_id:
        raise HTTPException(403, "This record belongs to another fleet")


def _token_row(db: Session, token_id: str) -> Token:
    t = db.get(Token, token_id)
    if t is None:
        write_behind.flush(3)
        t = db.get(Token, token_id)
    if t is None:
        raise HTTPException(404, "Token not found")
    return t


@router.get("/tokens/{token_id}", tags=["tokens"])
def token_detail(token_id: str, db: Session = Depends(get_db), user: User = Depends(require("token.view"))):
    write_behind.flush(2)
    t = _token_row(db, token_id)
    if user.role == "transporter":
        _check_fleet(db, user, t.tractor_plate)
    history = db.scalars(select(TokenEvent).where(TokenEvent.token_id == token_id).order_by(TokenEvent.at.desc(), TokenEvent.id.desc())).all()
    return {**token_json(t, include_payload=True), "history": [{"at": iso(h.at), "kind": h.kind, "site": h.site, "result": h.result, "actor": h.actor, "detail": h.detail} for h in history], "signature_check": _sig_check(db, t)}


def _sig_check(db: Session, t: Token) -> dict:
    site = db.get(Site, t.kid)
    if not site:
        return {"valid": False, "reason": "Unknown signing key"}
    return {"valid": verify_signature(t.payload, t.signature, b64u_dec(site.public_key)), "alg": "Ed25519", "kid": t.kid, "public_key": site.public_key, "signature": t.signature}


@router.get("/tokens/{token_id}/signature", tags=["tokens"])
def token_signature(token_id: str, db: Session = Depends(get_db), user: User = Depends(require("token.view"))):
    t = _token_row(db, token_id)
    if user.role == "transporter":
        _check_fleet(db, user, t.tractor_plate)
    base = _sig_check(db, t)
    tampered = dict(t.payload)
    tampered["measured_gross_kg"] = round(float(tampered["measured_gross_kg"]) - 1000.0, 1)
    site = db.get(Site, t.kid)
    base["tamper_test"] = {"changed": "measured_gross_kg minus 1,000 kg", "valid": verify_signature(tampered, t.signature, b64u_dec(site.public_key)) if site else False}
    return base


class StatusIn(BaseModel):
    status: str
    reason: str = Field(min_length=3, max_length=255)


@router.post("/tokens/{token_id}/status", tags=["tokens"])
def token_status(token_id: str, body: StatusIn, db: Session = Depends(get_db), user: User = Depends(require("token.manage"))):
    if body.status not in ("ACTIVE", "SUSPENDED", "REVOKED", "FLAGGED"):
        raise HTTPException(422, "Status must be ACTIVE, SUSPENDED, REVOKED or FLAGGED")
    e = engine()
    write_behind.flush(3)
    current = db.get(Token, token_id)
    if current is not None:
        live_rec = e.registry.tokens.get(token_id)
        if (live_rec.status if live_rec else current.status) == body.status:
            raise HTTPException(409, f"Token is already {body.status}")
    with e.lock:
        try:
            rec = e.registry.set_status(token_id, body.status, body.reason, e.now, actor=user.username)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
    t = _token_row(db, token_id)
    if rec is None:
        if not can_transition(t.status, body.status):
            raise HTTPException(409, f"Token is {t.status} and closed: it cannot go to {body.status}")
        t.status, t.status_reason = body.status, body.reason
        db.add(TokenEvent(token_id=token_id, at=e.now, kind="STATUS", result=body.status, actor=user.username, detail={"reason": body.reason}, origin=t.origin))
    audit(db, user.username, user.role, f"token.{body.status.lower()}", token_id, {"reason": body.reason}, commit=False)
    db.commit()
    write_behind.flush(3)
    e.alert("warning" if body.status != "ACTIVE" else "info", "token", t.origin_station, f"Token {body.status.lower()}: {t.tractor_plate}", f"{token_id}. {body.reason} (by {user.display_name})", key=f"tok:{token_id}:{body.status}", quiet_min=0.01)
    db.expire_all()
    return token_json(_token_row(db, token_id))


class VerifyIn(BaseModel):
    site: str = "mariakani"
    token_id: str | None = None
    plate: str | None = None
    rfid: str | None = None
    gross_kg: float | None = Field(default=None, gt=0)
    height_m: float | None = None
    width_m: float | None = None
    length_m: float | None = None
    axle_config: str | None = None


@router.post("/tokens/verify", tags=["tokens"])
def verify_token(body: VerifyIn, db: Session = Depends(get_db), user: User = Depends(require("token.view"))):
    """Applies the downstream rule: identity, validity, weight tolerance, dimensions, axle configuration, no critical flag."""
    e = engine()
    write_behind.flush(3)
    row = db.get(Token, body.token_id) if body.token_id else db.scalar(select(Token).where(Token.tractor_plate == (body.plate or "").upper()).order_by(Token.issued_at.desc()).limit(1))
    if body.site not in e.plazas:
        raise HTTPException(422, "Unknown site")
    if row is not None and user.role == "transporter":
        _check_fleet(db, user, row.tractor_plate)
    if row is None:
        return {"honoured": False, "checks": [{"code": "found", "label": "Token on record", "status": "fail", "detail": "No token found"}], "token_id": None}
    site = db.get(Site, row.kid)
    sig_ok = verify_signature(row.payload, row.signature, b64u_dec(site.public_key)) if site else False
    p = row.payload
    live = e.registry.tokens.get(row.token_id)
    status = live.status if live else row.status
    valid_until = parse_iso(p["valid_until"])
    checks = [
        {"code": "signature", "label": "Ed25519 signature", "status": "pass" if sig_ok else "fail", "detail": f"Signed by {row.kid}"},
        {"code": "status", "label": "Token status", "status": "pass" if status in ("ACTIVE", "ISSUED") else "fail", "detail": status},
        {"code": "validity", "label": "Validity window", "status": "pass" if e.now <= valid_until else "fail", "detail": f"Valid until {p['valid_until']}"},
    ]
    if body.plate:
        checks.append({"code": "plate", "label": "Plate matches", "status": "pass" if body.plate.upper() == row.tractor_plate else "fail", "detail": f"{body.plate.upper()} against {row.tractor_plate}"})
    if body.rfid:
        checks.append({"code": "rfid", "label": "RFID matches", "status": "pass" if body.rfid == row.rfid_tag else "fail", "detail": ""})
    if body.gross_kg:
        tol = e.policy.tolerance_road_token_pct if row.source in ("road", "lane", "static") else e.policy.tolerance_first_point_pct
        var = abs(body.gross_kg - row.gross_kg) / row.gross_kg * 100.0
        checks.append({"code": "weight", "label": "Weight consistency", "status": "pass" if var <= tol else "fail", "detail": f"Variance {var:.1f}% against a {tol:.0f}% tolerance"})
    dims = p.get("dimensions_m") or {}
    for key, val in (("height", body.height_m), ("width", body.width_m), ("length", body.length_m)):
        if val is not None and dims.get(key) is not None:
            checks.append({"code": key, "label": f"{key.title()} consistency", "status": "pass" if abs(val - dims[key]) <= 0.25 else "fail", "detail": f"{val:.2f} m against {dims[key]:.2f} m"})
    if body.axle_config:
        checks.append({"code": "axles", "label": "Axle configuration", "status": "pass" if body.axle_config == p.get("axle_config") else "fail", "detail": f"{body.axle_config} against {p.get('axle_config')}"})
    honoured = all(c["status"] == "pass" for c in checks)
    db.add(TokenEvent(token_id=row.token_id, at=e.now, kind="MANUAL_VERIFY", site=body.site, result="HONOURED" if honoured else "REJECTED", actor=user.username, detail={"checks": checks}, origin=row.origin))
    db.commit()
    return {"honoured": honoured, "checks": checks, "token_id": row.token_id, "tolerance_note": "Consistency tolerances are configurable in the decision policy."}


# ------------------------------------------------------------------ decision engine
class EvaluateIn(BaseModel):
    stage: str = Field(pattern="^(PORT|ORIGIN|ROAD|LANE|STATIC)$")
    config: str = "1-2-3"
    gross_kg: float | None = None
    axle_loads_kg: list[float] | None = None
    height_m: float | None = 4.1
    width_m: float | None = 2.5
    length_m: float | None = 17.0
    axles_detected: int | None = None
    lifted_axle: bool = False
    quality: float | None = 0.95
    sensor_fault: str | None = None
    plate_ok: bool = True
    rfid_ok: bool = True
    trailer_ok: bool = True
    release_ok: bool | None = True
    expected_gross_kg: float | None = None
    container_ok: bool = True
    token_gross_kg: float | None = None
    token_source: str = "port"
    token_status: str = "ACTIVE"
    token_expired: bool = False
    token_signature_valid: bool = True
    audit_selected: bool = False
    critical_flag: str | None = None
    demerits: int = 0
    scale_approved: bool = True
    calibration_valid: bool = True
    ticket_signature_valid: bool = True
    onboard_only: bool = False


@router.post("/decisions/evaluate", tags=["decisions"])
def evaluate(b: EvaluateIn, user: User = Depends(current_user)):
    """Dry run of the engine: nothing is recorded. Used by the decision console."""
    policy = engine().policy
    if b.config not in AXLE_CONFIGS:
        raise HTTPException(422, "Unknown axle configuration")
    axles = b.axle_loads_kg
    if not axles and b.gross_kg:
        gs = groups_for(b.config, policy)
        lim = sum(g.limit_kg for g in gs)
        axles = []
        for g in gs:
            axles += [b.gross_kg * g.limit_kg / lim / g.axles] * g.axles
    m = D.Measurement(gross_kg=b.gross_kg, axle_loads_kg=axles, height_m=b.height_m, width_m=b.width_m, length_m=b.length_m, axles_detected=b.axles_detected if b.axles_detected is not None else (sum(int(x) for x in b.config.split("-")) if b.gross_kg else None), lifted_axle=b.lifted_axle, quality=b.quality, speed_kmh=None, sensor_fault=b.sensor_fault)
    ids = D.IdentityReads("KDA 000A" if b.plate_ok else None, "E2" if b.rfid_ok else None, "ZD 0000" if b.trailer_ok else None, "KDA 000A", "E2", "ZD 0000", b.config)
    token = None
    if b.token_gross_kg:
        token = D.TokenView("LCT-DRYRUN", b.token_gross_kg, b.token_source, {"port": 1, "origin": 2}.get(b.token_source, 3), signature_valid=b.token_signature_valid, status=b.token_status, expired=b.token_expired, height_m=b.height_m, width_m=b.width_m, length_m=b.length_m)
    flags = [b.critical_flag] if b.critical_flag else None
    if b.stage == "PORT":
        d = D.decide_port(m, ids, policy, b.config, b.release_ok, b.expected_gross_kg, container_ok=b.container_ok, demerits=b.demerits, critical_flags=flags)
    elif b.stage == "ORIGIN":
        d = D.decide_origin(m, ids, policy, b.config, b.scale_approved, b.calibration_valid, b.ticket_signature_valid, onboard_only=b.onboard_only, demerits=b.demerits)
    elif b.stage == "ROAD":
        d = D.decide_road(m, ids, policy, b.config, token, audit_selected=b.audit_selected, demerits=b.demerits, critical_flags=flags)
    elif b.stage == "LANE":
        d = D.decide_lane(m, ids, policy, b.config, token, demerits=b.demerits, critical_flags=flags)
    else:
        d = D.decide_static(m, ids, policy, b.config, demerits=b.demerits)
    scale = {"PORT": "port", "ORIGIN": "origin", "ROAD": "road", "LANE": "lane", "STATIC": "static"}[b.stage]
    no_margin = b.stage == "STATIC" or (b.stage == "PORT" and policy.port_legal_grade) or (b.stage == "LANE" and policy.lane_legal_grade)
    limit_config = effective_config_with_lift(b.config) if b.lifted_axle and b.stage in ("LANE", "STATIC") else b.config
    return {**d.to_dict(), "gross_limit_kg": gross_limit_for(limit_config, policy), "margin_pct": 0.0 if no_margin else policy.margin_pct(scale), "dry_run": True}


@router.get("/decisions/policy", tags=["decisions"])
def get_policy(user: User = Depends(current_user)):
    return {"policy": engine().policy.model_dump(), "provenance": POLICY_PROVENANCE, "note": "Limits come from the source documents and must be re-verified. Editing them here changes demo behaviour only."}


@router.put("/decisions/policy", tags=["decisions"])
def put_policy(body: dict, db: Session = Depends(get_db), user: User = Depends(require("policy.edit"))):
    try:
        new = Policy(**{**engine().policy.model_dump(), **body})
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(422, f"Invalid policy: {exc}") from exc
    engine().set_policy(new)
    state.persist_config("policy", new.model_dump())
    audit(db, user.username, user.role, "policy.update", None, body)
    return {"policy": new.model_dump()}
