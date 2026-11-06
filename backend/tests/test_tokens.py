"""Token generation, Ed25519 signature verification, expiry, lifecycle, cache semantics."""
from datetime import datetime, timedelta, timezone

import pytest

from rcs.domain.tokens import TIER_FOR_SOURCE, Signer, b64u, build_payload, can_transition, canonical_json, new_keypair, verify_signature
from rcs.services.registry import Registry

NOW = datetime(2026, 11, 6, 8, 0, tzinfo=timezone.utc)
FIELDS = dict(tractor_plate="KDA 123A", trailer_plate="ZD 1234", rfid_tag="E200", container_number="MSCU1234565", container_check_ok=True, eseal_id="ES1", measured_gross_kg=41000.0, expected_gross_kg=40500.0, axle_loads_kg=[7000.0, 6000.0, 6000.0, 7000.0, 7500.0, 7500.0], axle_group_loads_kg=[7000.0, 12000.0, 22000.0], height_m=4.1, width_m=2.5, length_m=17.0, axle_config="1-2-3", permit_ref=None, origin_station="port_node", source="port", issued_at=NOW, validity_hours=72, destination="Nairobi", route="port_nairobi", driver_ref="DRV-1", release_snapshot={"customs": True, "adapter": "MOCK"})


def reg() -> Registry:
    r = Registry(persist=False)
    r.add_signer("port_node", new_keypair()[0])
    r.add_signer("mariakani", new_keypair()[0])
    return r


def issue(r: Registry, site="port_node", plate="KDA 123A", now=NOW, online=True, validity=72.0):
    return r.issue(site=site, source="port", now=now, online=online, origin="sim", validity_hours=validity, plate=plate, trailer="ZD 1234", tag="E200", container="MSCU1234565", container_ok=True, eseal="ES1", gross=41000.0, expected=40500.0, axle_loads=[7000.0, 6000.0, 6000.0, 7000.0, 7500.0, 7500.0], config="1-2-3", h=4.1, w=2.5, l=17.0, permit=None, destination="Nairobi", route="port_nairobi", driver="DRV-1", release={"customs": True})


def test_payload_has_every_required_field():
    p = build_payload(**FIELDS)
    for key in ("token_id", "tractor_plate", "trailer_plate", "rfid_tag", "container_number", "eseal_id", "measured_gross_kg", "expected_gross_kg", "axle_loads_kg", "axle_group_loads_kg", "dimensions_m", "axle_config", "permit_ref", "origin_station", "source", "trust_tier", "issued_at", "valid_until", "destination", "route", "release_snapshot"):
        assert key in p
    assert p["trust_tier"] == TIER_FOR_SOURCE["port"] == 1
    assert p["variance_pct"] == pytest.approx(1.23)
    assert p["valid_until"] == "2026-11-09T08:00:00Z"


def test_token_ids_are_unique():
    assert build_payload(**FIELDS)["token_id"] != build_payload(**FIELDS)["token_id"]


def test_canonical_json_is_order_independent():
    assert canonical_json({"b": 1, "a": 2}) == canonical_json({"a": 2, "b": 1})


def test_signature_round_trip():
    priv, pub = new_keypair()
    p = build_payload(**FIELDS)
    assert verify_signature(p, Signer("x", priv).sign(p), pub)


@pytest.mark.parametrize("field,value", [("measured_gross_kg", 40000.0), ("tractor_plate", "KZZ 999Z"), ("valid_until", "2030-01-01T00:00:00Z"), ("trust_tier", 1 + 1)])
def test_any_change_breaks_the_signature(field, value):
    priv, pub = new_keypair()
    p = build_payload(**FIELDS)
    sig = Signer("x", priv).sign(p)
    assert not verify_signature({**p, field: value}, sig, pub)


def test_wrong_key_fails():
    priv, _ = new_keypair()
    _, other = new_keypair()
    p = build_payload(**FIELDS)
    assert not verify_signature(p, Signer("x", priv).sign(p), other)


def test_garbage_signature_fails_cleanly():
    _, pub = new_keypair()
    assert not verify_signature(build_payload(**FIELDS), b64u(b"junk"), pub)


def test_lifecycle_transitions():
    assert can_transition("PENDING", "ISSUED")
    assert can_transition("ISSUED", "ACTIVE")
    assert can_transition("ACTIVE", "SUSPENDED")
    assert can_transition("SUSPENDED", "ACTIVE")
    assert can_transition("ACTIVE", "FLAGGED")
    assert not can_transition("REVOKED", "ACTIVE")
    assert not can_transition("EXPIRED", "ACTIVE")


def test_registry_issue_lookup_verifies_signature():
    r = reg()
    rec = issue(r)
    view, why = r.lookup("KDA 123A", "E200", NOW, True, None)
    assert view.token_id == rec.token_id and view.signature_valid and why is None and view.status == "ACTIVE"


def test_tampered_stored_payload_is_detected_at_lookup():
    r = reg()
    rec = issue(r)
    rec.payload["measured_gross_kg"] = 1000.0
    assert not r.lookup("KDA 123A", "E200", NOW, True, None)[0].signature_valid


def test_token_expiry():
    r = reg()
    issue(r, validity=1.0)
    assert not r.lookup("KDA 123A", None, NOW + timedelta(minutes=30), True, None)[0].expired
    assert r.lookup("KDA 123A", None, NOW + timedelta(hours=2), True, None)[0].expired
    assert r.expire_sweep(NOW + timedelta(hours=2)) == 1
    assert r.lookup("KDA 123A", None, NOW + timedelta(hours=2), True, None) == (None, None)


def test_revocation_seen_online():
    r = reg()
    rec = issue(r)
    r.set_status(rec.token_id, "REVOKED", "test", NOW, actor="t")
    assert r.lookup("KDA 123A", None, NOW, True, None)[0].status == "REVOKED"


def test_cannot_reactivate_revoked():
    r = reg()
    rec = issue(r)
    r.set_status(rec.token_id, "REVOKED", "test", NOW, actor="t")
    with pytest.raises(ValueError):
        r.set_status(rec.token_id, "ACTIVE", "test", NOW, actor="t")


def test_renewal_supersedes_previous_token():
    r = reg()
    first = issue(r)
    second = issue(r, now=NOW + timedelta(minutes=5))
    assert first.token_id not in r.tokens
    assert r.lookup("KDA 123A", None, NOW + timedelta(minutes=5), True, None)[0].token_id == second.token_id


def test_offline_issue_stays_issued():
    assert issue(reg(), online=False).status == "ISSUED"
