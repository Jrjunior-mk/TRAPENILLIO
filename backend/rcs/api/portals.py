"""Agency portals, officer cases, calibration, disputes, alerts, audit, administration, global search."""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import case, delete, desc, func, or_, select, true
from sqlalchemy.orm import Session

from ..db import get_db, write_behind
from ..models import Alert, AuditLog, CalibrationRecord, ClearanceEvent, Dispute, Fleet, OfficerCase, Site, Token, User, Vehicle
from ..security import KRA_ALERT_KINDS, NTSA_ALERT_KINDS, PORT_SITE, ROLES, alert_visible, audit, current_user, has_permission, require, verify_audit_chain
from ..services.adapters import adapters
from ..state import engine, get_setting, state
from .common import case_json, event_json, iso
from .ops import token_json, vehicle_json

router = APIRouter(prefix="/api")
MOCK_NOTE = "All agency data on this page comes from clearly labelled mock adapters and synthetic records. No real agency system is connected."


# ---- portals
@router.get("/portals/kenha", tags=["portals"])
def portal_kenha(db: Session = Depends(get_db), user: User = Depends(require("portal.kenha"))):
    write_behind.flush(2)
    e = engine()
    cases = db.scalars(select(OfficerCase).order_by(case((OfficerCase.status == "PENDING", 0), else_=1), desc(OfficerCase.created_at)).limit(100)).all()
    wim = db.scalars(select(ClearanceEvent).where(ClearanceEvent.stage == "ROAD").order_by(desc(ClearanceEvent.at)).limit(30)).all()
    lane = db.scalars(select(ClearanceEvent).where(ClearanceEvent.stage == "LANE").order_by(desc(ClearanceEvent.at)).limit(20)).all()
    static = db.scalars(select(ClearanceEvent).where(ClearanceEvent.stage == "STATIC").order_by(desc(ClearanceEvent.at)).limit(20)).all()
    cal = db.scalars(select(CalibrationRecord).order_by(CalibrationRecord.due_at).limit(40)).all()
    return {"note": MOCK_NOTE, "cases": [case_json(c) for c in cases], "wim_events": [event_json(x) for x in wim], "lane_events": [event_json(x) for x in lane], "static_events": [event_json(x) for x in static], "calibration": [cal_json(c) for c in cal], "stations": [e.station_view(p) for p in e.plazas if e.plazas[p].kind == "road"], "legal_note": "Static weighing remains the legal authority for overload (Reg 4(6), Reg 18(3)). An authorised officer approves tickets and release orders (Reg 3(4))."}


def cal_json(c: CalibrationRecord) -> dict:
    now = datetime.now(timezone.utc)
    due = c.due_at if c.due_at.tzinfo else c.due_at.replace(tzinfo=timezone.utc)
    return {"id": c.id, "site": c.site, "device": c.device, "calibrator": c.calibrator, "certificate_no": c.certificate_no, "performed_at": iso(c.performed_at), "due_at": iso(c.due_at), "result": c.result, "is_demo": c.is_demo, "overdue": due < now, "days_left": (due - now).days}


@router.get("/portals/kpa", tags=["portals"])
def portal_kpa(db: Session = Depends(get_db), user: User = Depends(require("portal.kpa"))):
    write_behind.flush(2)
    e = engine()
    events = db.scalars(select(ClearanceEvent).where(ClearanceEvent.site == "port_node").order_by(desc(ClearanceEvent.at)).limit(40)).all()
    out = []
    for x in events:
        row = event_json(x)
        out.append(row)
    tokens = db.scalars(select(Token).where(Token.source == "port").order_by(desc(Token.issued_at)).limit(30)).all()
    token_rows = []
    for t in tokens:
        d = token_json(t)
        d["release_snapshot"] = t.payload.get("release_snapshot")
        token_rows.append(d)
    return {"note": MOCK_NOTE, "station": e.station_view("port_node"), "events": out, "tokens": token_rows, "reweigh_queue": e.plazas["port_node"].static_queue, "kra_mock_down": adapters.kra_down}


@router.get("/portals/kra", tags=["portals"])
def portal_kra(db: Session = Depends(get_db), user: User = Depends(require("portal.kra"))):
    write_behind.flush(2)
    tol = engine().policy.expected_variance_tolerance_pct
    tokens = db.scalars(select(Token).where(Token.source == "port").order_by(desc(Token.issued_at)).limit(60)).all()
    rows = []
    for t in tokens:
        p = t.payload
        expected = p.get("expected_gross_kg")
        rows.append({"token_id": t.token_id, "plate": t.tractor_plate, "container": t.container_number, "eseal_id": p.get("eseal_id"), "expected_kg": expected, "measured_kg": t.gross_kg, "variance_pct": p.get("variance_pct"), "release": p.get("release_snapshot"), "issued_at": p.get("issued_at")})
    misdeclared = db.scalars(select(ClearanceEvent).where(ClearanceEvent.site == "port_node", ClearanceEvent.explanation.like("%misdeclaration%")).order_by(desc(ClearanceEvent.at)).limit(30)).all()
    sealed = db.scalars(select(OfficerCase).where(OfficerCase.sealed_transit.is_(True)).order_by(desc(OfficerCase.created_at)).limit(20)).all()
    return {"note": MOCK_NOTE, "tolerance_pct": tol, "reconciliation": rows, "misdeclaration_alerts": [event_json(x) for x in misdeclared], "sealed_overloads": [case_json(c) for c in sealed]}


@router.get("/portals/ntsa", tags=["portals"])
def portal_ntsa(q: str | None = None, db: Session = Depends(get_db), user: User = Depends(require("portal.ntsa"))):
    stmt = select(Vehicle, Fleet.name).join(Fleet, Vehicle.fleet_id == Fleet.id, isouter=True)
    if q:
        stmt = stmt.where(Vehicle.tractor_plate.like(f"%{q.upper()}%"))
    rows = db.execute(stmt.order_by(desc(Vehicle.demerits), Vehicle.tractor_plate).limit(60)).all()
    fleets = db.scalars(select(Fleet).order_by(desc(Fleet.demerits))).all()
    return {"note": MOCK_NOTE, "vehicles": [vehicle_json(v, f) for v, f in rows], "fleets": [{"id": f.id, "name": f.name, "demerits": f.demerits, "clean_record": f.clean_record} for f in fleets]}


@router.get("/portals/transporter", tags=["portals"])
def portal_transporter(fleet_id: int | None = None, db: Session = Depends(get_db), user: User = Depends(require("portal.transporter"))):
    write_behind.flush(2)
    if user.role == "transporter":
        fleet_id = user.fleet_id
        if fleet_id is None:
            raise HTTPException(403, "This account is not linked to a fleet")
    fleet_id = fleet_id or 1
    fleet = db.get(Fleet, fleet_id)
    if not fleet:
        raise HTTPException(404, "Fleet not found")
    plates = select(Vehicle.tractor_plate).where(Vehicle.fleet_id == fleet_id)
    vehicles = db.scalars(select(Vehicle).where(Vehicle.fleet_id == fleet_id).order_by(Vehicle.tractor_plate).limit(100)).all()
    tokens = db.scalars(select(Token).where(Token.tractor_plate.in_(plates)).order_by(desc(Token.issued_at)).limit(40)).all()
    events = db.scalars(select(ClearanceEvent).where(ClearanceEvent.plate.in_(plates)).order_by(desc(ClearanceEvent.at)).limit(50)).all()
    disputes = db.scalars(select(Dispute).where(Dispute.fleet_id == fleet_id).order_by(desc(Dispute.created_at)).limit(30)).all()
    with engine().lock:
        on_road = [{"id": t.id, "plate": t.plate, "state": t.state, "next": t.next_destination()} for t in engine().trucks.values() if t.fleet_id == fleet_id][:40]
    outcome = dict(db.execute(select(ClearanceEvent.outcome, func.count()).where(ClearanceEvent.plate.in_(plates)).group_by(ClearanceEvent.outcome)).all())
    return {"note": MOCK_NOTE, "fleet": {"id": fleet.id, "name": fleet.name, "demerits": fleet.demerits, "clean_record": fleet.clean_record}, "vehicles": [vehicle_json(v, fleet.name) for v in vehicles], "tokens": [token_json(t) for t in tokens], "events": [event_json(e) for e in events], "disputes": [dispute_json(d) for d in disputes], "on_road": on_road, "outcomes": outcome}


@router.get("/portals/loader", tags=["portals"])
def portal_loader(site: str | None = None, db: Session = Depends(get_db), user: User = Depends(require("portal.loader"))):
    write_behind.flush(2)
    if user.role == "loader" and not user.site_id:
        raise HTTPException(403, "This account is not linked to a loading site")
    site = user.site_id if user.role == "loader" else (site or "origin_quarry")
    s = db.get(Site, site)
    if not s or s.kind != "origin":
        raise HTTPException(404, "Unknown origin node")
    tokens = db.scalars(select(Token).where(Token.origin_station == site).order_by(desc(Token.issued_at)).limit(40)).all()
    events = db.scalars(select(ClearanceEvent).where(ClearanceEvent.site == site).order_by(desc(ClearanceEvent.at)).limit(30)).all()
    cal = db.scalars(select(CalibrationRecord).where(CalibrationRecord.site == site)).all()
    p = engine().plazas[site]
    # Trust is earned: origin readings against the road or lane readings of the same tokens
    variances = [t.payload.get("variance_pct") for t in tokens if t.payload.get("variance_pct") is not None]
    return {"note": MOCK_NOTE, "site": {"id": s.id, "name": s.name, "origin_type": s.origin_type, "approved": p.scale_approved, "suspended": p.suspended, "calibration_valid": p.calibration_valid, "trust_tier": 2}, "tokens": [token_json(t) for t in tokens], "events": [event_json(e) for e in events], "calibration": [cal_json(c) for c in cal], "avg_variance_pct": round(sum(variances) / len(variances), 2) if variances else None, "sites": [{"id": x.id, "name": x.name} for x in db.scalars(select(Site).where(Site.kind == "origin"))]}


class SiteFlagsIn(BaseModel):
    scale_approved: bool | None = None
    calibration_valid: bool | None = None
    suspended: bool | None = None


@router.post("/portals/loader/{site}/flags", tags=["portals"])
def loader_flags(site: str, body: SiteFlagsIn, db: Session = Depends(get_db), user: User = Depends(require("site.manage"))):
    e = engine()
    if site not in e.plazas or e.plazas[site].kind != "origin":
        raise HTTPException(404, "Unknown origin node")
    with e.lock:
        p = e.plazas[site]
        if body.scale_approved is not None:
            p.scale_approved = body.scale_approved
        if body.calibration_valid is not None:
            p.calibration_valid = body.calibration_valid
        if body.suspended is not None:
            p.suspended = body.suspended
        if body.calibration_valid is False:
            e.alert("warning", "calibration", site, f"Calibration expired at {p.name}", "No origin tokens can be issued until it is renewed (Reg 6).", key=f"cal:{site}", quiet_min=1)
    audit(db, user.username, user.role, "site.flags", site, body.model_dump())
    return {"approved": p.scale_approved, "calibration_valid": p.calibration_valid, "suspended": p.suspended}


# ---- officer cases
class CaseDecision(BaseModel):
    approve: bool
    note: str | None = Field(default=None, max_length=500)


@router.post("/cases/{case_id}/decide", tags=["portals"])
def decide_case(case_id: str, body: CaseDecision, db: Session = Depends(get_db), user: User = Depends(require("case.decide"))):
    write_behind.flush(3)
    c = db.get(OfficerCase, case_id)
    if not c:
        raise HTTPException(404, "Case not found")
    if c.status != "PENDING":
        raise HTTPException(409, f"Case already {c.status}")
    e = engine()
    now = e.now
    c.status = "APPROVED" if body.approve else "REJECTED"
    c.officer = user.display_name
    c.decided_at = now
    c.note = body.note
    if body.approve:
        c.release_order = f"RO-{case_id[-8:]}"
    signer = e.registry.signers.get(c.site)
    if signer:
        c.signature = signer.sign({"case": c.id, "plate": c.plate, "status": c.status, "officer": user.username, "release_order": c.release_order, "at": now.isoformat()})
    audit(db, user.username, user.role, "case.approve" if body.approve else "case.reject", case_id, {"plate": c.plate, "release_order": c.release_order, "note": body.note}, commit=False)
    db.commit()
    released = e.decide_case(case_id, body.approve, user.display_name)
    return {**case_json(c), "truck_released": released}


# ---- calibration
class CalIn(BaseModel):
    site: str
    device: str = Field(min_length=2, max_length=60)
    calibrator: str = Field(min_length=2, max_length=120)
    certificate_no: str = Field(min_length=2, max_length=40)
    performed_at: datetime | None = None
    result: str = Field("PASS", pattern="^(PASS|FAIL)$")


@router.post("/calibration", tags=["portals"])
def add_calibration(body: CalIn, db: Session = Depends(get_db), user: User = Depends(require("calibration.edit"))):
    if not db.get(Site, body.site):
        raise HTTPException(404, "Unknown site")
    done = body.performed_at or datetime.now(timezone.utc)
    row = CalibrationRecord(site=body.site, device=body.device, calibrator=body.calibrator, certificate_no=body.certificate_no, performed_at=done, due_at=done + timedelta(days=91), result=body.result, is_demo=True)
    db.add(row)
    audit(db, user.username, user.role, "calibration.add", body.site, {"device": body.device, "cert": body.certificate_no}, commit=False)
    db.commit()
    e = engine()
    with e.lock:
        if body.site in e.plazas and body.result == "PASS":
            for s in e.plazas[body.site].sensors.values():
                s.drift_pct = 0.0
                s.drift_alerted = False
            if e.plazas[body.site].kind == "origin":
                e.plazas[body.site].calibration_valid = True
    return cal_json(row)


# ---- disputes
class DisputeIn(BaseModel):
    plate: str
    event_id: str | None = None
    reason: str = Field(min_length=5, max_length=2000)


def dispute_json(d: Dispute) -> dict:
    return {"id": d.id, "created_at": iso(d.created_at), "fleet_id": d.fleet_id, "plate": d.plate, "event_id": d.event_id, "reason": d.reason, "status": d.status, "resolution": d.resolution, "resolved_by": d.resolved_by}


@router.get("/disputes", tags=["portals"])
def list_disputes(db: Session = Depends(get_db), user: User = Depends(require("dispute.view"))):
    stmt = select(Dispute).order_by(desc(Dispute.created_at)).limit(100)
    if user.role == "transporter":
        stmt = stmt.where(Dispute.fleet_id == user.fleet_id)
    return {"items": [dispute_json(d) for d in db.scalars(stmt)]}


@router.post("/disputes", tags=["portals"])
def create_dispute(body: DisputeIn, db: Session = Depends(get_db), user: User = Depends(require("dispute.create"))):
    v = db.scalar(select(Vehicle).where(Vehicle.tractor_plate == body.plate.upper()))
    if not v:
        raise HTTPException(404, "Vehicle not found")
    if user.role == "transporter" and v.fleet_id != user.fleet_id:
        raise HTTPException(403, "This vehicle belongs to another fleet")
    row = Dispute(created_at=datetime.now(timezone.utc), fleet_id=v.fleet_id, plate=v.tractor_plate, event_id=body.event_id, reason=body.reason)
    db.add(row)
    audit(db, user.username, user.role, "dispute.create", v.tractor_plate, {"event": body.event_id}, commit=False)
    db.commit()
    return dispute_json(row)


class DisputeResolve(BaseModel):
    status: str = Field(pattern="^(UPHELD|REJECTED)$")
    resolution: str = Field(min_length=3, max_length=2000)


@router.post("/disputes/{did}/resolve", tags=["portals"])
def resolve_dispute(did: int, body: DisputeResolve, db: Session = Depends(get_db), user: User = Depends(require("dispute.resolve"))):
    d = db.get(Dispute, did)
    if not d:
        raise HTTPException(404, "Dispute not found")
    if d.status != "OPEN":
        raise HTTPException(409, f"Dispute already {d.status}")
    d.status, d.resolution, d.resolved_by = body.status, body.resolution, user.display_name
    audit(db, user.username, user.role, "dispute.resolve", str(did), {"status": body.status}, commit=False)
    db.commit()
    return dispute_json(d)


# ---- alerts and audit
def _alert_scope(user: User):
    """The database form of security.alert_visible."""
    if user.role == "kenha":
        return or_(Alert.site.is_(None), Alert.site != PORT_SITE)
    if user.role == "kpa":
        return Alert.site == PORT_SITE
    if user.role == "kra":
        return Alert.kind.in_(KRA_ALERT_KINDS)
    if user.role == "ntsa":
        return Alert.kind.in_(NTSA_ALERT_KINDS)
    if user.role == "loader":
        return Alert.site == user.site_id
    return true()


@router.get("/alerts", tags=["alerts"])
def alerts(severity: str | None = None, kind: str | None = None, open_only: bool = False, limit: int = Query(80, le=300), db: Session = Depends(get_db), user: User = Depends(require("alert.view"))):
    write_behind.flush(2)
    stmt = select(Alert).where(_alert_scope(user))
    if severity:
        stmt = stmt.where(Alert.severity == severity)
    if kind:
        stmt = stmt.where(Alert.kind == kind)
    if open_only:
        stmt = stmt.where(Alert.ack_at.is_(None))
    rows = db.scalars(stmt.order_by(desc(Alert.at), desc(Alert.id)).limit(limit)).all()
    counts = dict(db.execute(select(Alert.severity, func.count()).where(Alert.ack_at.is_(None), _alert_scope(user)).group_by(Alert.severity)).all())
    return {"items": [{"id": a.id, "at": iso(a.at), "severity": a.severity, "kind": a.kind, "site": a.site, "title": a.title, "detail": a.detail, "ack_by": a.ack_by, "ack_at": iso(a.ack_at)} for a in rows], "open_counts": counts}


@router.post("/alerts/{aid}/ack", tags=["alerts"])
def ack_alert(aid: int, db: Session = Depends(get_db), user: User = Depends(require("alert.ack"))):
    a = db.get(Alert, aid)
    if a and not alert_visible(user, a.kind, a.site):
        raise HTTPException(403, "This alert belongs to another agency")
    if not a:
        raise HTTPException(404, "Alert not found")
    a.ack_by, a.ack_at = user.display_name, datetime.now(timezone.utc)
    audit(db, user.username, user.role, "alert.ack", str(aid), None, commit=False)
    db.commit()
    return {"ok": True}


@router.get("/audit", tags=["alerts"])
def audit_logs(action: str | None = None, limit: int = Query(100, le=500), db: Session = Depends(get_db), user: User = Depends(require("audit.view"))):
    stmt = select(AuditLog)
    if action:
        stmt = stmt.where(AuditLog.action.like(f"{action}%"))
    rows = db.scalars(stmt.order_by(desc(AuditLog.id)).limit(limit)).all()
    return {"items": [{"id": r.id, "at": iso(r.at), "actor": r.actor, "role": r.role, "action": r.action, "target": r.target, "detail": r.detail, "hash": r.hash[:16]} for r in rows], "chain": verify_audit_chain(db)}


# ---- admin
@router.get("/admin/users", tags=["admin"])
def admin_users(db: Session = Depends(get_db), user: User = Depends(require("admin.users"))):
    return {"items": [{"id": u.id, "username": u.username, "display_name": u.display_name, "role": u.role, "role_label": ROLES.get(u.role), "org": u.org, "active": u.active} for u in db.scalars(select(User).order_by(User.id))], "roles": ROLES}


class UserActive(BaseModel):
    active: bool


@router.post("/admin/users/{uid}/active", tags=["admin"])
def admin_user_active(uid: int, body: UserActive, db: Session = Depends(get_db), user: User = Depends(require("admin.users"))):
    u = db.get(User, uid)
    if not u:
        raise HTTPException(404, "User not found")
    if u.id == user.id:
        raise HTTPException(409, "You cannot deactivate your own account")
    u.active = body.active
    audit(db, user.username, user.role, "user.active", u.username, body.model_dump(), commit=False)
    db.commit()
    return {"ok": True}


@router.get("/admin/retention", tags=["admin"])
def get_retention(db: Session = Depends(get_db), user: User = Depends(require("admin.retention"))):
    return {"settings": get_setting(db, "retention"), "note": "Retention and anonymization are design controls toward the Data Protection Act, 2019. They are not a compliance certification; counsel must review them."}


class RetentionIn(BaseModel):
    clearance_days: int = Field(ge=1, le=3650)
    anonymize_plates_after_days: int = Field(ge=1, le=3650)
    alert_days: int = Field(ge=1, le=3650)
    audit_days: int = Field(ge=30, le=3650)


@router.put("/admin/retention", tags=["admin"])
def put_retention(body: RetentionIn, db: Session = Depends(get_db), user: User = Depends(require("admin.retention"))):
    state.persist_config("retention", body.model_dump())
    audit(db, user.username, user.role, "retention.update", None, body.model_dump())
    return {"settings": body.model_dump()}


@router.post("/admin/retention/run", tags=["admin"])
def run_retention(db: Session = Depends(get_db), user: User = Depends(require("admin.retention"))):
    """Applies the settings: pseudonymizes old plates, deletes expired records. Measured against the simulated clock."""
    write_behind.flush(5)
    s = get_setting(db, "retention") or {}
    now = engine().now
    cutoff_anon = now - timedelta(days=s.get("anonymize_plates_after_days", 30))
    cutoff_del = now - timedelta(days=s.get("clearance_days", 90))
    cutoff_alert = now - timedelta(days=s.get("alert_days", 180))
    anonymized = 0
    for ev in db.scalars(select(ClearanceEvent).where(ClearanceEvent.at < cutoff_anon, ClearanceEvent.plate.notlike("ANON-%")).limit(5000)):
        ev.plate = "ANON-" + hashlib.sha256(ev.plate.encode()).hexdigest()[:10].upper()
        anonymized += 1
    deleted = db.execute(delete(ClearanceEvent).where(ClearanceEvent.at < cutoff_del)).rowcount
    deleted_alerts = db.execute(delete(Alert).where(Alert.at < cutoff_alert)).rowcount
    audit(db, user.username, user.role, "retention.run", None, {"anonymized": anonymized, "deleted_events": deleted, "deleted_alerts": deleted_alerts}, commit=False)
    db.commit()
    return {"anonymized": anonymized, "deleted_events": deleted, "deleted_alerts": deleted_alerts}


@router.get("/admin/health", tags=["admin"])
def health_detail(db: Session = Depends(get_db), user: User = Depends(require("admin.health"))):
    e = engine()
    k = e.kpi()
    return {"system": k["system"], "conservation": k["conservation"], "bus": e.bus.stats(), "write_behind": {"written": write_behind.written, "errors": write_behind.errors, "last_error": write_behind.last_error, "queue": write_behind.q.qsize()}, "database": db.bind.dialect.name, "stations": k["stations"], "audit_chain": verify_audit_chain(db) if has_permission(user, "audit.view") else None, "mqtt": "bridged to a broker" if e.bus.bridge else "in-process (MQTT-compatible topics)"}


# ---- search
@router.get("/search", tags=["search"])
def search(q: str = Query(min_length=2, max_length=40), db: Session = Depends(get_db), user: User = Depends(current_user)):
    like = f"%{q.upper()}%"
    out: list[dict] = []
    e = engine()
    with e.lock:
        for pid, p in e.plazas.items():
            if q.lower() in p.name.lower():
                out.append({"type": "station", "id": pid, "label": p.name, "href": f"/twin?station={pid}"})
        own_plates = set(db.scalars(select(Vehicle.tractor_plate).where(Vehicle.fleet_id == user.fleet_id))) if user.role == "transporter" else None
        for t in list(e.trucks.values()) if has_permission(user, "twin.details") or own_plates else []:
            if own_plates is not None and t.plate not in own_plates:
                continue
            if q.upper() in t.plate or (t.container and q.upper() in t.container):
                out.append({"type": "live truck", "id": t.id, "label": f"{t.plate} on the road ({t.state.lower()})", "href": f"/twin?truck={t.id}"})
                if len(out) > 8:
                    break
    stmt = select(Vehicle.tractor_plate).where(Vehicle.tractor_plate.like(like)).limit(6)
    if user.role == "transporter":
        stmt = stmt.where(Vehicle.fleet_id == user.fleet_id)
    for plate in db.scalars(stmt) if has_permission(user, "truck.view") else []:
        out.append({"type": "truck", "id": plate, "label": plate, "href": f"/trucks/{plate.replace(' ', '%20')}"})
    if has_permission(user, "token.view"):
        stmt = select(Token).where((Token.token_id.like(like)) | (Token.tractor_plate.like(like)) | (Token.container_number.like(like))).order_by(desc(Token.issued_at)).limit(6)
        if user.role == "transporter":
            stmt = stmt.where(Token.tractor_plate.in_(select(Vehicle.tractor_plate).where(Vehicle.fleet_id == user.fleet_id)))
        for t in db.scalars(stmt):
            out.append({"type": "token", "id": t.token_id, "label": f"{t.token_id} ({t.tractor_plate})", "href": f"/tokens?id={t.token_id}"})
    return {"items": out[:20]}
