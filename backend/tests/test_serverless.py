"""Function hosting: signed sessions any instance can verify, and API calls tunnelled over the tab's WebSocket."""
import base64
import json

import pytest
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient
from sqlalchemy import select

from rcs.config import get_settings
from rcs.db import session_factory
from rcs.main import app
from rcs.models import SessionRow
from rcs.seed import DEMO_PASSWORD
from rcs.security import COOKIE, read_token, sign_token


@pytest.fixture()
def hosted(monkeypatch):
    monkeypatch.setattr(get_settings(), "serverless", True)
    with TestClient(app) as anon:
        c = TestClient(app)
        assert c.post("/api/auth/login", json={"username": "admin", "password": DEMO_PASSWORD}).status_code == 200
        yield anon, c


def test_signed_token_rejects_tampering_expiry_and_the_wrong_purpose():
    token = sign_token("admin", "session", 60)
    assert read_token(token, "session") == "admin"
    assert read_token(token, "ws") is None
    assert read_token(sign_token("admin", "session", -1), "session") is None
    forged = base64.urlsafe_b64encode(json.dumps({"u": "admin", "p": "session", "exp": 9e12}).encode()).decode()
    assert read_token(f"{forged}.{token.rsplit('.', 1)[1]}", "session") is None
    for bad in (None, "", "nodot", "a.b", "!!.!!"):
        assert read_token(bad, "session") is None


def test_session_needs_no_server_side_row(hosted):
    _, c = hosted
    token = c.cookies.get(COOKIE)
    assert read_token(token, "session") == "admin"
    with session_factory()() as db:
        assert all(r.token_hash != token for r in db.scalars(select(SessionRow)))
    assert TestClient(app, cookies={COOKIE: token}).get("/api/auth/me").json()["username"] == "admin"
    assert TestClient(app, cookies={COOKIE: token + "x"}).get("/api/auth/me").status_code == 401


def test_a_ticket_cannot_be_used_as_a_session(hosted):
    _, c = hosted
    ticket = c.post("/api/ws/ticket").json()["ticket"]
    assert TestClient(app, cookies={COOKIE: ticket}).get("/api/auth/me").status_code == 401


def test_a_session_cannot_open_the_socket_as_a_ticket(hosted):
    anon, c = hosted
    with pytest.raises(WebSocketDisconnect):
        with anon.websocket_connect(f"/api/ws/live?ticket={c.cookies.get(COOKIE)}"):
            pass


def _reply(ws, request_id):
    for _ in range(200):
        m = ws.receive_json()
        if m.get("t") == "res" and m.get("id") == request_id:
            return m
    raise AssertionError("no reply")


def test_api_calls_tunnel_over_the_socket_with_the_users_rights(hosted):
    anon, c = hosted
    with anon.websocket_connect(f"/api/ws/live?ticket={c.post('/api/ws/ticket').json()['ticket']}") as ws:
        assert ws.receive_json()["t"] == "hello"
        ws.send_json({"t": "req", "id": 1, "method": "GET", "path": "/trucks?limit=1"})
        res = _reply(ws, 1)
        assert res["status"] == 200 and json.loads(res["body"])["items"]
        ws.send_json({"t": "req", "id": 2, "method": "GET", "path": "/no-such-route"})
        assert _reply(ws, 2)["status"] == 404
        ws.send_json({"t": "req", "id": 3, "method": "GET", "path": "//example.com/x"})
        assert _reply(ws, 3)["status"] == 500

    viewer = TestClient(app)
    viewer.post("/api/auth/login", json={"username": "viewer", "password": DEMO_PASSWORD})
    with anon.websocket_connect(f"/api/ws/live?ticket={viewer.post('/api/ws/ticket').json()['ticket']}") as ws:
        ws.send_json({"t": "req", "id": 4, "method": "GET", "path": "/admin/users"})
        assert _reply(ws, 4)["status"] == 403


def test_tunnel_is_off_outside_function_hosting(monkeypatch):
    with TestClient(app) as anon:
        c = TestClient(app)
        c.post("/api/auth/login", json={"username": "admin", "password": DEMO_PASSWORD})
        with anon.websocket_connect(f"/api/ws/live?ticket={c.post('/api/ws/ticket').json()['ticket']}") as ws:
            assert ws.receive_json()["t"] == "kpi"
            ws.send_json({"t": "req", "id": 1, "method": "GET", "path": "/trucks?limit=1"})
            for _ in range(5):
                assert ws.receive_json().get("t") != "res"
