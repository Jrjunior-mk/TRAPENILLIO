"""Load Compliance Token: canonical payload, Ed25519 signature and verification."""
from __future__ import annotations

import base64
import json
import uuid
from datetime import datetime, timedelta, timezone

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

TIER_FOR_SOURCE = {"port": 1, "origin": 2, "road": 3, "lane": 3, "static": 3}
LIFECYCLE = ("PENDING", "ISSUED", "ACTIVE", "EXPIRED", "SUSPENDED", "REVOKED", "FLAGGED")
TRANSITIONS: dict[str, set[str]] = {
    "PENDING": {"ISSUED", "REVOKED"},
    "ISSUED": {"ACTIVE", "EXPIRED", "SUSPENDED", "REVOKED", "FLAGGED"},
    "ACTIVE": {"EXPIRED", "SUSPENDED", "REVOKED", "FLAGGED"},
    "SUSPENDED": {"ACTIVE", "REVOKED", "EXPIRED"},
    "FLAGGED": {"ACTIVE", "SUSPENDED", "REVOKED", "EXPIRED"},
    "EXPIRED": set(),
    "REVOKED": set(),
}


def can_transition(old: str, new: str) -> bool:
    return new in TRANSITIONS.get(old, set())


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64u_dec(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def canonical_json(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def new_keypair() -> tuple[bytes, bytes]:
    key = Ed25519PrivateKey.generate()
    return (
        key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()),
        key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw),
    )


class Signer:
    """One signing key per site, so an edge node can issue tokens while offline."""

    def __init__(self, kid: str, private_raw: bytes):
        self.kid = kid
        self._key = Ed25519PrivateKey.from_private_bytes(private_raw)
        self.public_raw = self._key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)

    def sign(self, payload: dict) -> str:
        return b64u(self._key.sign(canonical_json(payload)))


def verify_signature(payload: dict, signature: str, public_raw: bytes) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(public_raw).verify(b64u_dec(signature), canonical_json(payload))
        return True
    except (InvalidSignature, ValueError):
        return False


def iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(text: str) -> datetime:
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def build_payload(
    *,
    tractor_plate: str,
    trailer_plate: str | None,
    rfid_tag: str | None,
    container_number: str | None,
    container_check_ok: bool | None,
    eseal_id: str | None,
    measured_gross_kg: float,
    expected_gross_kg: float | None,
    axle_loads_kg: list[float],
    axle_group_loads_kg: list[float],
    height_m: float | None,
    width_m: float | None,
    length_m: float | None,
    axle_config: str,
    permit_ref: str | None,
    origin_station: str,
    source: str,
    issued_at: datetime,
    validity_hours: float,
    destination: str | None,
    route: str | None,
    driver_ref: str | None,
    release_snapshot: dict | None,
    token_id: str | None = None,
) -> dict:
    token_id = token_id or f"LCT-{issued_at.strftime('%y%m%d')}-{uuid.uuid4().hex[:10].upper()}"
    variance = None
    if expected_gross_kg:
        variance = round((measured_gross_kg - expected_gross_kg) / expected_gross_kg * 100, 2)
    return {
        "v": 1,
        "token_id": token_id,
        "tractor_plate": tractor_plate,
        "trailer_plate": trailer_plate,
        "rfid_tag": rfid_tag,
        "container_number": container_number,
        "container_check_ok": container_check_ok,
        "eseal_id": eseal_id,
        "measured_gross_kg": round(measured_gross_kg, 1),
        "expected_gross_kg": round(expected_gross_kg, 1) if expected_gross_kg else None,
        "variance_pct": variance,
        "axle_loads_kg": [round(a, 1) for a in axle_loads_kg],
        "axle_group_loads_kg": [round(a, 1) for a in axle_group_loads_kg],
        "dimensions_m": {"height": height_m, "width": width_m, "length": length_m},
        "axle_config": axle_config,
        "permit_ref": permit_ref,
        "origin_station": origin_station,
        "source": source,
        "trust_tier": TIER_FOR_SOURCE[source],
        "issued_at": iso(issued_at),
        "valid_until": iso(issued_at + timedelta(hours=validity_hours)),
        "destination": destination,
        "route": route,
        "driver_ref": driver_ref,
        "release_snapshot": release_snapshot,
    }
