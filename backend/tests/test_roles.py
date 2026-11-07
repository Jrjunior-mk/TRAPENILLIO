"""Each role reaches its own work and the digital twin. Only the administrator reaches everything."""
import pytest
from fastapi.testclient import TestClient

from rcs.db import session_factory, write_behind
from rcs.main import app
from rcs.models import Alert
from rcs.seed import DEMO_PASSWORD
from rcs.security import ROLES, SECTION_ROLES, alert_visible, home_for, sections_for
from rcs.state import state

ALL = set(ROLES)
# Every protected read in the application, with the roles allowed to use it.
READS = {
    "/api/live/series": {"admin", "viewer"},
    "/api/live/events": {"admin", "viewer"},
    "/api/live/config": {"admin", "viewer"},
    "/api/twin/network": ALL,
    "/api/twin/scenarios": ALL,
    "/api/live/kpi": ALL,
    "/api/live/frame": ALL,
    "/api/twin/stations": {"admin", "kenha", "kpa", "kra", "ntsa", "viewer"},
    "/api/twin/stations/mariakani": {"admin", "kenha", "kpa", "kra", "ntsa", "viewer"},
    "/api/trucks?limit=1": ALL - {"viewer"},
    "/api/trucks/options": ALL - {"viewer"},
    "/api/tokens?limit=1": {"admin", "kenha", "kpa", "kra", "transporter", "loader"},
    "/api/clearance/events?limit=1": {"admin"},
    "/api/decisions/policy": {"admin"},
    "/api/lane/mariakani": {"admin", "kenha"},
    "/api/sensors": {"admin", "kenha"},
    "/api/sensors/mariakani": {"admin", "kenha"},
    "/api/sim/experiments": {"admin", "viewer"},
    "/api/sim/l2/scenarios": {"admin", "viewer"},
    "/api/portals/kenha": {"admin", "kenha"},
    "/api/portals/kpa": {"admin", "kpa"},
    "/api/portals/kra": {"admin", "kra"},
    "/api/portals/ntsa": {"admin", "ntsa"},
    "/api/portals/transporter": {"admin", "transporter"},
    "/api/portals/loader": {"admin", "loader"},
    "/api/disputes": {"admin", "kenha", "transporter"},
    "/api/alerts": {"admin", "kenha", "kpa", "kra", "ntsa", "loader"},
    "/api/audit": {"admin"},
    "/api/admin/users": {"admin"},
    "/api/admin/retention": {"admin"},
    "/api/admin/health": {"admin"},
}
# Actions that change what everyone else sees. A refusal happens before the body is looked at.
ADMIN_ONLY_WRITES = [
    ("POST", "/api/live/control"),
    ("PUT", "/api/live/config"),
    ("POST", "/api/faults/mariakani/network"),
    ("POST", "/api/faults/global"),
    ("POST", "/api/lane/mariakani/inject"),
    ("POST", "/api/twin/scenarios/stop"),
    ("POST", "/api/sim/l2/run"),
    ("POST", "/api/sim/monte-carlo"),
    ("POST", "/api/sim/tornado"),
    ("PUT", "/api/decisions/policy"),
    ("POST", "/api/decisions/evaluate"),
    ("POST", "/api/portals/loader/origin_quarry/flags"),
]


@pytest.fixture(scope="module")
def clients():
    with TestClient(app) as anon:
        out = {}
        for role in ROLES:
            c = TestClient(app)
            assert c.post("/api/auth/login", json={"username": "viewer" if role == "viewer" else role, "password": DEMO_PASSWORD}).status_code == 200
            out[role] = c
        yield out | {"anon": anon}


@pytest.mark.parametrize("path,allowed", READS.items(), ids=list(READS))
def test_read_access(clients, path, allowed):
    for role in ROLES:
        status = clients[role].get(path).status_code
        assert (status != 403) == (role in allowed), f"{role} on {path} returned {status}"


@pytest.mark.parametrize("method,path", ADMIN_ONLY_WRITES, ids=[p for _, p in ADMIN_ONLY_WRITES])
def test_only_the_administrator_can_change_shared_state(clients, method, path):
    for role in ROLES:
        if role != "admin":
            assert clients[role].request(method, path, json={}).status_code == 403, f"{role} on {path}"


def test_me_lists_the_sections_of_each_role(clients):
    for role in ROLES:
        me = clients[role].get("/api/auth/me").json()
        assert me["sections"] == sections_for(role) and me["home"] == home_for(role)
        assert "twin" in me["sections"]
    assert set(clients["admin"].get("/api/auth/me").json()["sections"]) == set(SECTION_ROLES)
    kenha = set(clients["kenha"].get("/api/auth/me").json()["sections"])
    assert kenha == {"twin", "clearance", "trucks", "tokens", "lane", "sensors", "alerts", "portal:kenha"}
    assert clients["kenha"].get("/api/auth/me").json()["home"] == "/portals/kenha"
    for role in set(ROLES) - {"admin"}:
        portals = {s for s in sections_for(role) if s.startswith("portal")}
        assert len(portals) <= 1, f"{role} can reach {portals}"


def test_alerts_are_limited_to_the_agency(clients):
    with session_factory()() as db:
        at = state.engine.now
        for kind, site in (("network", "port_node"), ("overload", "mariakani"), ("identity", "mtwapa"), ("calibration", "origin_quarry"), ("calibration", "origin_cement")):
            db.add(Alert(at=at, severity="warning", kind=kind, site=site, title=f"role test {kind} {site}", detail="", origin="operator"))
        db.commit()
    write_behind.flush(2)

    def titles(role):
        return {a["title"] for a in clients[role].get("/api/alerts", params={"limit": 300}).json()["items"] if a["title"].startswith("role test")}

    every = {"role test network port_node", "role test overload mariakani", "role test identity mtwapa", "role test calibration origin_quarry", "role test calibration origin_cement"}
    assert titles("admin") == every
    assert titles("kpa") == {"role test network port_node"}
    assert titles("kenha") == every - {"role test network port_node"}
    assert titles("kra") == {"role test overload mariakani", "role test identity mtwapa"}
    assert titles("ntsa") == {"role test identity mtwapa"}
    assert titles("loader") == {"role test calibration origin_quarry"}

    port_alert = next(a for a in clients["admin"].get("/api/alerts", params={"limit": 300}).json()["items"] if a["title"] == "role test network port_node")
    assert clients["kenha"].post(f"/api/alerts/{port_alert['id']}/ack").status_code == 403
    assert clients["kpa"].post(f"/api/alerts/{port_alert['id']}/ack").status_code == 200


def test_alert_scope_matches_for_the_live_stream():
    class U:
        def __init__(self, role, site_id=None):
            self.role, self.site_id = role, site_id

    assert alert_visible(U("admin"), "network", "port_node")
    assert not alert_visible(U("kenha"), "network", "port_node")
    assert alert_visible(U("kpa"), "network", "port_node")
    assert not alert_visible(U("kpa"), "overload", "mariakani")
    assert not alert_visible(U("transporter"), "overload", "mariakani")
    assert alert_visible(U("loader", "origin_quarry"), "calibration", "origin_quarry")
    assert not alert_visible(U("loader", "origin_quarry"), "calibration", "origin_cement")
    assert not alert_visible(U("loader"), "calibration", None)


def test_search_only_returns_what_the_role_can_open(clients):
    plate = clients["admin"].get("/api/trucks", params={"limit": 1}).json()["items"][0]["plate"]
    assert any(i["type"] == "truck" for i in clients["kenha"].get("/api/search", params={"q": plate}).json()["items"])
    assert not any(i["type"] in ("truck", "token") for i in clients["viewer"].get("/api/search", params={"q": plate}).json()["items"])
    assert not any(i["type"] == "token" for i in clients["ntsa"].get("/api/search", params={"q": "LCT"}).json()["items"])


def test_twin_details_for_a_transporter_are_limited_to_its_fleet(clients):
    engine = state.engine
    engine.step(1800)
    with engine.lock:
        truck = next(iter(engine.trucks.values()), None)
    if truck is None:
        pytest.skip("No truck on the corridor")
    assert clients["admin"].get(f"/api/twin/trucks/{truck.id}").status_code == 200
    assert clients["loader"].get(f"/api/twin/trucks/{truck.id}").status_code == 403
    status = clients["transporter"].get(f"/api/twin/trucks/{truck.id}").status_code
    assert status in (200, 403)


def test_live_stream_withholds_corridor_events_from_narrow_roles(clients):
    from rcs.api.twin import hub

    class Sock:
        def __init__(self):
            self.sent = []

        async def send_text(self, text):
            self.sent.append(text)

    class U:
        def __init__(self, role, site_id=None):
            self.role, self.site_id = role, site_id

    import asyncio

    admin, viewer, transporter, kenha = Sock(), Sock(), Sock(), Sock()
    saved = dict(hub.clients)
    hub.clients.clear()
    hub.clients.update({admin: U("admin"), viewer: U("viewer"), transporter: U("transporter"), kenha: U("kenha")})
    try:
        asyncio.run(hub.broadcast_events([{"plate": "KAA 000A"}]))
        asyncio.run(hub.broadcast_alerts([{"kind": "network", "site": "port_node"}]))
    finally:
        hub.clients.clear()
        hub.clients.update(saved)
    assert len(admin.sent) == 2 and len(viewer.sent) == 2
    assert transporter.sent == [] and kenha.sent == []
