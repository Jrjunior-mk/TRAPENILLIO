"""Integration: real FastAPI app, real migrations on a temporary database, real auth, real workflows."""
import os
import tempfile
import time
from pathlib import Path

import pytest

_tmp = tempfile.mkdtemp(prefix="rcs-test-")
os.environ.setdefault("RCS_DATABASE_URL", f"sqlite:///{Path(_tmp, 'test.db').as_posix()}")  # set it to test on PostgreSQL
os.environ["RCS_AUTOSTART_LIVE"] = "false"
os.environ["RCS_WORKER_PROCESSES"] = "0"
os.environ["RCS_MASTER_KEY"] = "dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdC0="

from fastapi import WebSocketDisconnect  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from rcs.db import write_behind  # noqa: E402
from rcs.main import app  # noqa: E402
from rcs.seed import DEMO_PASSWORD  # noqa: E402
from rcs.state import state  # noqa: E402


@pytest.fixture(scope="module")
def anon():
    with TestClient(app) as c:
        yield c


def login(anon, user):
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"username": user, "password": DEMO_PASSWORD})
    assert r.status_code == 200, r.text
    return c


@pytest.fixture(scope="module")
def admin(anon):
    return login(anon, "admin")


def test_ws_ticket_is_required_and_single_use(anon, admin):
    assert anon.post("/api/ws/ticket").status_code == 401
    with pytest.raises(WebSocketDisconnect):
        with anon.websocket_connect("/api/ws/live?ticket=not-a-ticket"):
            pass
    ticket = admin.post("/api/ws/ticket").json()["ticket"]
    with anon.websocket_connect(f"/api/ws/live?ticket={ticket}") as ws:
        assert ws.receive_json()["t"] == "kpi"
    with pytest.raises(WebSocketDisconnect):
        with anon.websocket_connect(f"/api/ws/live?ticket={ticket}"):
            pass


@pytest.fixture(scope="module")
def plate(admin):
    return admin.get("/api/trucks", params={"limit": 200}).json()["items"][0]["plate"]


def vehicle(admin, plate):
    return admin.get(f"/api/trucks/{plate}").json()["vehicle"]


# ---------------------------------------------------------------- auth and RBAC
def test_requires_authentication(anon):
    fresh = TestClient(app)
    assert fresh.get("/api/live/kpi").status_code == 401
    assert fresh.get("/api/tokens").status_code == 401


def test_wrong_password_rejected_and_audited(anon, admin):
    r = TestClient(app).post("/api/auth/login", json={"username": "admin", "password": "nope"})
    assert r.status_code == 401
    assert any(i["action"] == "auth.login_failed" for i in admin.get("/api/audit").json()["items"])


def test_session_cookie_is_httponly(anon):
    r = TestClient(app).post("/api/auth/login", json={"username": "viewer", "password": DEMO_PASSWORD})
    assert "httponly" in r.headers["set-cookie"].lower() and "samesite=lax" in r.headers["set-cookie"].lower()


def test_logout_invalidates_session(anon):
    c = login(anon, "viewer")
    assert c.get("/api/auth/me").status_code == 200
    c.post("/api/auth/logout")
    assert c.get("/api/auth/me").status_code == 401


def test_rbac(anon):
    viewer = login(anon, "viewer")
    assert viewer.post("/api/live/control", json={"action": "pause"}).status_code == 403
    assert viewer.put("/api/decisions/policy", json={"allowance_pct": 5}).status_code == 403
    assert viewer.post("/api/clearance/port", json={"plate": "KDA 100A"}).status_code == 403
    kpa = login(anon, "kpa")
    assert kpa.post("/api/clearance/road", json={"plate": "KDA 100A"}).status_code == 403
    assert kpa.get("/api/audit").status_code == 403


def test_transporter_sees_only_its_fleet(anon):
    t = login(anon, "transporter")
    r = t.get("/api/trucks", params={"limit": 200}).json()
    assert r["items"] and all(v["fleet_id"] == 1 for v in r["items"])
    other = TestClient(app)
    other.post("/api/auth/login", json={"username": "admin", "password": DEMO_PASSWORD})
    foreign = other.get("/api/trucks", params={"fleet_id": 2, "limit": 1}).json()["items"][0]["plate"]
    assert t.get(f"/api/trucks/{foreign}").status_code == 403
    assert t.get("/api/portals/transporter", params={"fleet_id": 2}).json()["fleet"]["id"] == 1


def test_driver_name_is_encrypted_at_rest_and_gated(anon, admin, plate):
    assert "driver_name" in admin.get(f"/api/trucks/{plate}").json()["vehicle"]
    kpa = login(anon, "kpa")
    assert "driver_name" not in kpa.get(f"/api/trucks/{plate}").json()["vehicle"]
    from sqlalchemy import select

    from rcs.db import session_factory
    from rcs.models import Vehicle

    with session_factory()() as db:
        row = db.scalar(select(Vehicle).where(Vehicle.tractor_plate == plate))
        assert "Demo" not in (row.driver_name_enc or "")


# ---------------------------------------------------------------- full clearance workflow
def _port_body(v, gross=41000, **kw):
    return {"plate": v["plate"], "plate_read": v["plate"], "rfid_read": v["rfid"], "trailer_read": v["trailer"], "container": "CSQU3054383", "gross_kg": gross, "declared_cargo_kg": gross - v["tractor_tare"] - v["trailer_tare"] - 3800, "container_tare_kg": 3800, "height_m": v["height"], "width_m": v["width"], "length_m": v["length"], **kw}


def _six_axle_plate(admin):
    return next(x for x in admin.get("/api/trucks", params={"limit": 200}).json()["items"] if x["config"] == "1-2-3")


def test_token_full_lifecycle(admin):
    v = _six_axle_plate(admin)
    r = admin.post("/api/clearance/port", json=_port_body(v)).json()
    assert r["decision"]["outcome"] == "GREEN", r
    tid = r["token"]["token_id"]
    assert "MOCK" in r["adapters"] and r["release"]["adapter"] == "MOCK"

    write_behind.flush()
    d = admin.get(f"/api/tokens/{tid}").json()
    assert d["status"] == "ACTIVE" and d["signature_check"]["valid"]
    assert d["payload"]["measured_gross_kg"] == 41000 and d["history"][-1]["kind"] == "ISSUED"

    sig = admin.get(f"/api/tokens/{tid}/signature").json()
    assert sig["valid"] and sig["tamper_test"]["valid"] is False

    reg = admin.get("/api/tokens", params={"q": tid}).json()
    assert reg["total"] == 1

    # A downstream station honours it.
    road = {"plate": v["plate"], "plate_read": v["plate"], "rfid_read": v["rfid"], "trailer_read": v["trailer"], "gross_kg": 41500, "height_m": v["height"], "width_m": v["width"], "length_m": v["length"], "site": "mariakani", "audit": False}
    r2 = admin.post("/api/clearance/road", json=road).json()
    assert r2["decision"]["outcome"] == "GREEN" and r2["token_checked"] == tid

    # Mismatch.
    r3 = admin.post("/api/clearance/road", json={**road, "gross_kg": 47000}).json()
    assert r3["decision"]["outcome"] == "AMBER" and "weight differs" in r3["decision"]["explanation"]

    v_ok = admin.post("/api/tokens/verify", json={"token_id": tid, "plate": v["plate"], "gross_kg": 41000, "height_m": v["height"]}).json()
    assert v_ok["honoured"]
    v_bad = admin.post("/api/tokens/verify", json={"token_id": tid, "plate": "KZZ 999Z", "gross_kg": 41000}).json()
    assert not v_bad["honoured"]

    # Revoke: the next verification is affected, and the audit chain records it.
    assert admin.post(f"/api/tokens/{tid}/status", json={"status": "REVOKED", "reason": "Integration test"}).json()["status"] == "REVOKED"
    r4 = admin.post("/api/clearance/road", json=road).json()
    assert r4["decision"]["outcome"] == "AMBER" and "revoked" in r4["decision"]["explanation"]
    assert not admin.post("/api/tokens/verify", json={"token_id": tid}).json()["honoured"]
    assert admin.post(f"/api/tokens/{tid}/status", json={"status": "ACTIVE", "reason": "Should fail"}).status_code == 409
    write_behind.flush()
    assert any(h["kind"] == "MANUAL_VERIFY" for h in admin.get(f"/api/tokens/{tid}").json()["history"])
    a = admin.get("/api/audit").json()
    assert a["chain"]["valid"] and any(i["action"] == "token.revoked" for i in a["items"])


def test_port_overload_red_no_token(admin):
    v = _six_axle_plate(admin)
    r = admin.post("/api/clearance/port", json=_port_body(v, gross=56000)).json()
    assert r["decision"]["outcome"] == "RED" and r["token"] is None


def test_port_validation_errors(admin):
    assert admin.post("/api/clearance/port", json={"plate": "KZZ 000Z", "gross_kg": 40000}).status_code == 404
    assert admin.post("/api/clearance/port", json={"plate": "x", "gross_kg": -1}).status_code == 422


def test_port_missing_scale_reading_fails_safe(admin):
    v = _six_axle_plate(admin)
    body = _port_body(v)
    del body["gross_kg"]
    r = admin.post("/api/clearance/port", json=body).json()
    assert r["decision"]["outcome"] == "AMBER" and r["decision"]["fail_safe"]


def test_origin_ticket_flow(admin):
    v = _six_axle_plate(admin)
    body = {"plate": v["plate"], "plate_read": v["plate"], "rfid_read": v["rfid"], "trailer_read": v["trailer"], "gross_kg": 38000, "height_m": 4.1, "width_m": 2.5, "length_m": 17.0, "site": "origin_quarry"}
    ok = admin.post("/api/clearance/origin", json=body).json()
    assert ok["decision"]["outcome"] == "GREEN" and ok["token"]["source"] == "origin"
    bad = admin.post("/api/clearance/origin", json={**body, "calibration_valid": False}).json()
    assert bad["token"] is None


def test_register_vehicle_validation_and_conflict(admin):
    b = {"tractor_plate": "KDZ 777Z", "trailer_plate": "ZF 7777", "rfid_tag": "E2TEST0001", "axle_config": "1-2-3", "tractor_tare_kg": 8800, "trailer_tare_kg": 7200, "height_m": 4.1, "width_m": 2.5, "length_m": 17, "driver_name": "Demo Driver"}
    assert admin.post("/api/trucks", json=b).status_code == 200
    assert admin.post("/api/trucks", json=b).status_code == 409
    assert admin.post("/api/trucks", json={**b, "tractor_plate": "not a plate"}).status_code == 422
    assert admin.post("/api/trucks", json={**b, "tractor_plate": "KDZ 778Z", "rfid_tag": "E2TEST0001"}).status_code == 409
    assert admin.get("/api/trucks/KDZ 777Z").json()["vehicle"]["plate"] == "KDZ 777Z"


def test_decision_console_dry_run(admin):
    r = admin.post("/api/decisions/evaluate", json={"stage": "ROAD", "gross_kg": 40000, "token_gross_kg": 40000}).json()
    assert r["outcome"] == "GREEN" and r["dry_run"]
    r2 = admin.post("/api/decisions/evaluate", json={"stage": "ROAD"}).json()
    assert r2["outcome"] == "AMBER" and r2["fail_safe"]


def test_policy_update_changes_decisions(admin):
    before = admin.post("/api/decisions/evaluate", json={"stage": "LANE", "gross_kg": 49500}).json()["outcome"]
    assert admin.put("/api/decisions/policy", json={"lane_legal_grade": True}).status_code == 200
    after = admin.post("/api/decisions/evaluate", json={"stage": "LANE", "gross_kg": 49500}).json()["outcome"]
    admin.put("/api/decisions/policy", json={"lane_legal_grade": False})
    assert before == "RED" and after == "GREEN"


# ---------------------------------------------------------------- live twin through the API
def test_twin_network_and_frames(admin):
    n = admin.get("/api/twin/network").json()
    assert {p["id"] for p in n["plazas"]} >= {"port_node", "dongo_kundu", "mariakani", "mtwapa"} and n["schematic"]
    state.engine.step(1800)
    f = admin.get("/api/live/frame").json()
    assert f["trucks"]
    d = admin.get(f"/api/twin/trucks/{f['trucks'][0][0]}").json()
    for key in ("tractor_plate", "trailer_plate", "rfid", "stream", "container", "axle_config", "token_status", "decision", "location", "next"):
        assert key in d
    k = admin.get("/api/live/kpi").json()
    assert k["trucks_processed"] > 0 and k["conservation"]["balanced"]


def test_control_and_config_affect_engine(admin):
    admin.post("/api/live/control", json={"action": "pause"})
    assert admin.get("/api/live/kpi").json()["paused"]
    admin.post("/api/live/control", json={"action": "resume"})
    r = admin.put("/api/live/config", json={"token_coverage_pct": 55})
    assert r.status_code == 200 and state.engine.cfg.token_coverage_pct == 55
    assert admin.put("/api/live/config", json={"token_coverage_pct": 500}).status_code == 422
    admin.put("/api/live/config", json={"token_coverage_pct": 90})


def test_sensor_fault_through_api_fails_safe(admin):
    assert admin.post("/api/faults/mariakani/sensor/wim", json={"status": "disabled"}).status_code == 200
    s = admin.get("/api/sensors/mariakani").json()
    assert next(x for x in s["sensors"] if x["id"] == "wim")["status"] == "disabled"
    v = _six_axle_plate(admin)
    t = state.engine.spawn_hero(stream="untokened", enrolled=False, route="spot_kaloleni", ratio=0.75)
    for _ in range(600):
        if t.history:
            break
        state.engine.step(5)
    assert t.history[0]["outcome"] == "AMBER"
    admin.post("/api/faults/mariakani/sensor/wim", json={"status": "ok"})


def test_outage_and_sync_through_api(admin):
    r = admin.post("/api/faults/mtwapa/network", json={"up": False}).json()
    assert r["online"] is False
    assert admin.post("/api/faults/mtwapa/network", json={"up": True}).json()["online"] is True


def test_lane_view_and_inject(admin):
    v = admin.get("/api/lane/mariakani").json()
    assert v["design"]["capacity_per_h"] == pytest.approx(370, abs=5) and len(v["cases"]) == 8
    r = admin.post("/api/lane/mariakani/inject", json={"case": "overloaded"}).json()
    t = state.engine.trucks[r["truck"]]
    for _ in range(1000):
        if any(h["stage"] == "LANE" for h in t.history):
            break
        state.engine.step(3)
    assert next(h for h in t.history if h["stage"] == "LANE")["outcome"] == "RED"
    assert admin.get("/api/lane/mariakani").json()["last_lane_result"]["gross_kg"] > 10000


def test_edge_pipeline_endpoint(admin):
    r = admin.post("/api/sensors/pipeline/run", json={"speed_kmh": 80}).json()
    assert len(r["stages"]) == 10 and r["axles_detected"] == 6 and abs(r["error_pct"]) < 5


def test_scenario_endpoint(admin):
    assert len(admin.get("/api/twin/scenarios").json()["scenarios"]) == 8
    v = admin.post("/api/twin/scenarios/s1_compliant_port/start", json={"speed": 6}).json()
    assert v["truck"]
    assert admin.post("/api/twin/scenarios/stop").status_code == 200


def test_officer_case_flow(admin):
    e = state.engine
    t = e.spawn_hero(stream="untokened", enrolled=False, route="spot_kaloleni", ratio=1.1)
    for _ in range(2000):
        if t.hold_case:
            break
        e.step(5)
    case = t.hold_case
    write_behind.flush()
    k = admin.get("/api/portals/kenha").json()
    assert any(c["id"] == case for c in k["cases"])
    r = admin.post(f"/api/cases/{case}/decide", json={"approve": True}).json()
    assert r["status"] == "APPROVED" and r["release_order"] and r["signed"] and r["truck_released"]
    assert admin.post(f"/api/cases/{case}/decide", json={"approve": True}).status_code == 409


def test_portals_all_respond_with_mock_labels(admin):
    for name in ("kenha", "kpa", "kra", "ntsa", "transporter", "loader"):
        r = admin.get(f"/api/portals/{name}")
        assert r.status_code == 200, name
        assert "mock" in r.json()["note"].lower()


def test_dispute_flow(anon, admin):
    t = login(anon, "transporter")
    p = t.get("/api/trucks", params={"limit": 1}).json()["items"][0]["plate"]
    d = t.post("/api/disputes", json={"plate": p, "reason": "Axle reading looks wrong"}).json()
    assert d["status"] == "OPEN"
    assert t.post(f"/api/disputes/{d['id']}/resolve", json={"status": "UPHELD", "resolution": "x y z"}).status_code == 403
    assert admin.post(f"/api/disputes/{d['id']}/resolve", json={"status": "UPHELD", "resolution": "Re-weighed"}).json()["status"] == "UPHELD"


def test_alerts_ack_and_search(admin):
    state.engine.alert("warning", "test", None, "Integration alert", key="it", quiet_min=0)
    write_behind.flush()
    a = admin.get("/api/alerts").json()
    aid = a["items"][0]["id"]
    assert admin.post(f"/api/alerts/{aid}/ack").json()["ok"]
    assert admin.get("/api/search", params={"q": "mariakani"}).json()["items"][0]["type"] == "station"


def test_audit_chain_detects_tampering(admin):
    from rcs.db import session_factory
    from rcs.models import AuditLog
    from rcs.security import verify_audit_chain

    with session_factory()() as db:
        assert verify_audit_chain(db)["valid"]
        row = db.get(AuditLog, 1)
        original = row.actor
        row.actor = "someone-else"
        db.flush()
        assert not verify_audit_chain(db)["valid"]
        row.actor = original
        db.rollback()


def test_retention_run(admin):
    assert admin.put("/api/admin/retention", json={"clearance_days": 90, "anonymize_plates_after_days": 30, "alert_days": 180, "audit_days": 730}).status_code == 200
    assert "anonymized" in admin.post("/api/admin/retention/run").json()


# ---------------------------------------------------------------- simulation jobs
def wait_job(admin, jid, timeout=240):
    t0 = time.time()
    while time.time() - t0 < timeout:
        e = admin.get(f"/api/sim/experiments/{jid}").json()
        if e["status"] != "RUNNING":
            return e
        time.sleep(0.25)
    raise AssertionError("job timed out")


def test_l1_apply_links_into_live_engine(admin):
    r = admin.post("/api/sim/l1/run", json={"passes": 80}).json()
    assert r["kind"] == "MODELLED" and r["histogram"]["counts"]
    before = state.engine.policy.road_error_pct
    a = admin.post("/api/sim/l1/apply", json={"passes": 60, "road_roughness": "C"}).json()
    assert state.engine.policy.road_error_pct == a["errors"]["road_error_pct"] != before
    admin.put("/api/live/config", json={"road_error_pct": 2.5, "port_error_pct": 1.0, "lane_error_pct": 1.0, "origin_error_pct": 1.0})


def test_l2_job_and_exports(admin):
    jid = admin.post("/api/sim/l2/run", json={"days": 1, "config": {"trucks_per_day": 1500}}).json()["job_id"]
    e = wait_job(admin, jid)
    assert e["status"] == "DONE", e["message"]
    assert set(e["result"]["scenarios"]) >= {"as_is", "v2_all"}
    csv = admin.get(f"/api/sim/experiments/{jid}/export.csv")
    assert csv.status_code == 200 and "MODELLED" in csv.text
    pdf = admin.get(f"/api/sim/experiments/{jid}/export.pdf")
    assert pdf.status_code == 200 and pdf.content[:4] == b"%PDF"


def test_monte_carlo_job(admin):
    jid = admin.post("/api/sim/monte-carlo", json={"replications": 2, "days": 1, "warmup_days": 0, "scenarios": ["as_is", "v2_all"], "config": {"trucks_per_day": 800}}).json()["job_id"]
    e = wait_job(admin, jid)
    assert e["status"] == "DONE", e["message"]
    assert e["result"]["scenarios"]["v2_all"]["metrics"]["truck_hours_saved_per_day"]["n"] == 2
    assert b"%PDF" in admin.get(f"/api/sim/experiments/{jid}/export.pdf").content[:8]


def test_l3_and_l4_jobs(admin):
    e3 = wait_job(admin, admin.post("/api/sim/l3/run", json={"l2_days": 1, "config": {"trucks_per_day": 1500}}).json()["job_id"])
    assert e3["status"] == "DONE" and e3["result"]["heatmap_density_veh_km"] and "SUMO" in e3["result"]["scope"]
    e4 = wait_job(admin, admin.post("/api/sim/l4/run", json={"params": {"hours": 2, "outage_per_day": 0, "device_failures_per_day": 0}, "config": {"trucks_per_day": 1500}}).json()["job_id"])
    assert e4["status"] == "DONE" and e4["result"]["data_integrity_pct"] > 99


def test_openapi_documented(admin):
    spec = admin.get("/openapi.json").json()
    assert len(spec["paths"]) > 50


# ---------------------------------------------------------------- review regressions
def test_timestamps_are_timezone_aware(admin):
    state.engine.alert("info", "test", None, "Timestamp check", key="ts", quiet_min=0)
    write_behind.flush()
    item = admin.get("/api/alerts").json()["items"][0]
    assert item["at"].endswith("+00:00")
    assert admin.get("/api/audit").json()["items"][0]["at"].endswith("+00:00")


def test_portal_scoping(anon):
    t = login(anon, "transporter")
    for name in ("kpa", "kra", "ntsa", "loader"):
        assert t.get(f"/api/portals/{name}").status_code == 403, name
    assert login(anon, "loader").get("/api/portals/ntsa").status_code == 403
    assert login(anon, "loader").get("/api/portals/loader", params={"site": "origin_cement"}).json()["site"]["id"] == "origin_quarry"


def test_transporter_cannot_read_other_fleet_records(anon, admin):
    foreign = admin.get("/api/trucks", params={"fleet_id": 2, "limit": 1}).json()["items"][0]
    token = admin.post("/api/clearance/port", json=_port_body(foreign)).json().get("token")
    if token:
        t = login(anon, "transporter")
        assert t.get(f"/api/tokens/{token['token_id']}/signature").status_code == 403
        assert t.post("/api/tokens/verify", json={"token_id": token["token_id"]}).status_code == 403


def test_green_first_point_event_carries_its_token(admin):
    v = _six_axle_plate(admin)
    r = admin.post("/api/clearance/port", json=_port_body(v)).json()
    write_behind.flush()
    ev = admin.get("/api/clearance/events", params={"plate": v["plate"], "stage": "PORT"}).json()["items"][0]
    assert ev["token_id"] == r["token"]["token_id"]


def test_policy_rejects_nonsense(admin):
    assert admin.put("/api/decisions/policy", json={"tandem_group_kg": -5}).status_code == 422
    assert admin.put("/api/decisions/policy", json={"allowance_pct": 9}).status_code == 422


def test_same_status_is_a_conflict(admin):
    v = _six_axle_plate(admin)
    tid = admin.post("/api/clearance/port", json=_port_body(v)).json()["token"]["token_id"]
    write_behind.flush()
    assert admin.post(f"/api/tokens/{tid}/status", json={"status": "ACTIVE", "reason": "No change"}).status_code == 409


def test_network_sensor_status_and_timed_restore(admin):
    e = state.engine
    assert admin.post("/api/faults/mtwapa/network", json={"up": False, "duration_min": 5}).status_code == 200
    assert admin.get("/api/sensors/mtwapa").json()["scheduled_restore"]
    e.cfg = e.cfg.model_copy(update={"outage_per_day": 0})
    e.step(400)
    assert e.plazas["mtwapa"].link_up
    admin.post("/api/faults/mtwapa/sensor/network", json={"status": "disabled"})
    assert next(s for s in admin.get("/api/sensors/mtwapa").json()["sensors"] if s["id"] == "network")["status"] == "disabled"
    admin.post("/api/faults/mtwapa/sensor/network", json={"status": "ok"})
    assert e.plazas["mtwapa"].link_up


def test_reset_clears_simulated_rows_and_keeps_operator_tokens(admin):
    write_behind.flush()
    admin.post("/api/live/control", json={"action": "reset"})
    after = admin.get("/api/tokens", params={"limit": 200}).json()["items"]
    assert after and all(t["origin"] == "operator" for t in after)
    assert admin.get("/api/live/kpi").json()["entered"] == 0
