from __future__ import annotations

from datetime import datetime

from ..models import ClearanceEvent, OfficerCase


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def event_json(e: ClearanceEvent) -> dict:
    return {"id": e.id, "at": iso(e.at), "truck": e.truck_ref, "plate": e.plate, "stream": e.stream, "site": e.site, "stage": e.stage, "outcome": e.outcome, "action": e.action, "risk": e.risk, "confidence": e.confidence, "explanation": e.explanation, "checks": e.checks, "gross_kg": e.measured_gross_kg, "axle_loads_kg": e.axle_loads_kg, "token_id": e.token_id, "fail_safe": e.fail_safe, "offline": e.offline, "signed": bool(e.signature), "origin": e.origin}


def case_json(c: OfficerCase) -> dict:
    return {"id": c.id, "created_at": iso(c.created_at), "site": c.site, "plate": c.plate, "truck_ref": c.truck_ref, "measured_gross_kg": c.measured_gross_kg, "limit_kg": c.limit_kg, "overload_kg": c.overload_kg, "fee_usd": c.fee_usd, "fee_note": "Illustrative only: linear from one documented point", "reason": c.reason, "sealed_transit": c.sealed_transit, "status": c.status, "release_order": c.release_order, "officer": c.officer, "decided_at": iso(c.decided_at), "signed": bool(c.signature), "origin": c.origin}
