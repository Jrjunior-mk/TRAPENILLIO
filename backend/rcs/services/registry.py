"""Clearance registry: Load Compliance Token lifecycle with per-site edge cache semantics.

A station that loses its link keeps working from its cache: it knows tokens issued before the outage and cannot see
tokens or revocations from after it. When the link returns it syncs. Those semantics are tested in test_failover.py.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from ..db import write_behind
from ..domain.decision import TokenView
from ..domain.tokens import Signer, build_payload, can_transition, parse_iso, verify_signature
from ..domain.vehicle import group_loads
from ..models import Token as TokenRow
from ..models import TokenEvent


@dataclass
class TokenRec:
    token_id: str
    payload: dict
    signature: str
    kid: str
    status: str
    issued_at: datetime
    valid_until: datetime
    origin: str
    prev_status: str = "ACTIVE"
    status_changed_at: datetime | None = None
    reason: str | None = None
    verifications: int = 0

    @property
    def plate(self) -> str:
        return self.payload["tractor_plate"]

    def view(self, status: str | None, now: datetime, public_key: bytes | None) -> TokenView:
        p = self.payload
        d = p.get("dimensions_m") or {}
        sig_ok = verify_signature(p, self.signature, public_key) if public_key else False
        return TokenView(
            token_id=self.token_id, gross_kg=p["measured_gross_kg"], source=p["source"], trust_tier=p["trust_tier"],
            signature_valid=sig_ok, status=status or self.status, expired=now > self.valid_until,
            plate=p["tractor_plate"], tag=p.get("rfid_tag"), trailer=p.get("trailer_plate"), axle_config=p.get("axle_config"),
            height_m=d.get("height"), width_m=d.get("width"), length_m=d.get("length"),
        )


@dataclass
class Registry:
    """In-memory working set of live tokens; every change is written through to the database."""

    signers: dict[str, Signer] = field(default_factory=dict)
    public_keys: dict[str, bytes] = field(default_factory=dict)
    tokens: dict[str, TokenRec] = field(default_factory=dict)
    by_plate: dict[str, str] = field(default_factory=dict)
    persist: bool = True
    issued_total: int = 0
    verified_total: int = 0

    def add_signer(self, site: str, priv: bytes) -> None:
        s = Signer(site, priv)
        self.signers[site] = s
        self.public_keys[site] = s.public_raw

    def issue(self, *, site: str, source: str, now: datetime, online: bool, origin: str, validity_hours: float, plate: str, trailer: str | None,
              tag: str | None, container: str | None, container_ok: bool | None, eseal: str | None, gross: float, expected: float | None,
              axle_loads: list[float], config: str, h: float | None, w: float | None, l: float | None, permit: str | None, destination: str | None,
              route: str | None, driver: str | None, release: dict | None, actor: str | None = None) -> TokenRec:
        groups = group_loads(axle_loads, config) if len(axle_loads) == sum(int(x) for x in config.split("-")) else []
        payload = build_payload(
            tractor_plate=plate, trailer_plate=trailer, rfid_tag=tag, container_number=container, container_check_ok=container_ok, eseal_id=eseal,
            measured_gross_kg=gross, expected_gross_kg=expected, axle_loads_kg=axle_loads, axle_group_loads_kg=groups, height_m=h, width_m=w, length_m=l,
            axle_config=config, permit_ref=permit, origin_station=site, source=source, issued_at=now, validity_hours=validity_hours,
            destination=destination, route=route, driver_ref=driver, release_snapshot=release,
        )
        # PENDING is the instant between assembling and signing. An edge-issued token stays ISSUED until the registry has it.
        sig = self.signers[site].sign(payload)
        status = "ACTIVE" if online else "ISSUED"
        rec = TokenRec(payload["token_id"], payload, sig, site, status, now, parse_iso(payload["valid_until"]), origin, status_changed_at=now)
        self.tokens[rec.token_id] = rec
        # Superseding: a renewed token replaces the previous live one for this plate.
        old_id = self.by_plate.get(plate)
        if old_id and old_id != rec.token_id and old_id in self.tokens:
            old = self.tokens[old_id]
            if can_transition(old.status, "EXPIRED"):
                self.set_status(old_id, "EXPIRED", "Superseded by renewed token", now, actor="registry", site=site, drop=True)
            else:  # a revoked token keeps its status on record and leaves the working set
                self.tokens.pop(old_id, None)
        self.by_plate[plate] = rec.token_id
        self.issued_total += 1
        if self.persist:
            write_behind.add(_row(rec))
            write_behind.add(TokenEvent(token_id=rec.token_id, at=now, kind="ISSUED", site=site, result=status, actor=actor or "edge", detail={"source": source, "online": online}, origin=origin))
        return rec

    def lookup(self, plate: str, tag: str | None, now: datetime, online: bool, cache_since: datetime | None) -> tuple[TokenView | None, str | None]:
        """Token as seen from a site. Offline, the site only knows the state at the moment its link dropped."""
        token_id = self.by_plate.get(plate) if plate else None
        rec = self.tokens.get(token_id) if token_id else None
        if rec is None and tag:
            for r in self.tokens.values():
                if r.payload.get("rfid_tag") == tag:
                    rec = r
                    break
        if rec is None:
            return None, None
        status = rec.status
        if not online and cache_since is not None:
            if rec.issued_at >= cache_since:
                return None, "not_in_cache"
            if rec.status_changed_at and rec.status_changed_at >= cache_since:
                status = rec.prev_status
        return rec.view(status, now, self.public_keys.get(rec.kid)), None

    def record_verification(self, token_id: str, site: str, now: datetime, result: str, detail: dict, origin: str, offline: bool) -> None:
        rec = self.tokens.get(token_id)
        if rec:
            rec.verifications += 1
        self.verified_total += 1
        if self.persist:
            write_behind.add(TokenEvent(token_id=token_id, at=now, kind="VERIFIED_OFFLINE" if offline else "VERIFIED", site=site, result=result, actor="edge", detail=detail, origin=origin))

    def set_status(self, token_id: str, status: str, reason: str | None, now: datetime, actor: str, site: str | None = None, drop: bool = False) -> TokenRec | None:
        rec = self.tokens.get(token_id)
        if rec is None:
            return None
        if status != rec.status and not can_transition(rec.status, status):
            raise ValueError(f"Token cannot go from {rec.status} to {status}")
        rec.prev_status, rec.status = rec.status, status
        rec.status_changed_at = now
        rec.reason = reason
        if self.persist:
            tid, st, why = token_id, status, reason

            def _upd(db):
                row = db.get(TokenRow, tid)
                if row is not None:
                    row.status, row.status_reason = st, why

            write_behind.call(_upd)
            write_behind.add(TokenEvent(token_id=token_id, at=now, kind="STATUS", site=site, result=status, actor=actor, detail={"reason": reason}, origin=rec.origin))
        if drop:
            self.tokens.pop(token_id, None)
            if self.by_plate.get(rec.plate) == token_id:
                self.by_plate.pop(rec.plate, None)
        return rec

    def active_count(self) -> int:
        return sum(1 for r in self.tokens.values() if r.status in ("ACTIVE", "ISSUED"))

    def expire_sweep(self, now: datetime) -> int:
        expired = [t for t, r in self.tokens.items() if r.valid_until < now and r.status in ("ACTIVE", "ISSUED", "FLAGGED", "SUSPENDED")]
        for t in expired:
            self.set_status(t, "EXPIRED", "Validity window ended", now, actor="registry", drop=True)
        return len(expired)


def _row(rec: TokenRec) -> TokenRow:
    p = rec.payload
    return TokenRow(token_id=rec.token_id, payload=p, signature=rec.signature, kid=rec.kid, status=rec.status, status_reason=rec.reason, tractor_plate=p["tractor_plate"],
                    rfid_tag=p.get("rfid_tag"), container_number=p.get("container_number"), source=p["source"], trust_tier=p["trust_tier"], origin_station=p["origin_station"],
                    gross_kg=p["measured_gross_kg"], issued_at=rec.issued_at, valid_until=rec.valid_until, origin=rec.origin)
