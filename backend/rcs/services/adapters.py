"""Mock agency adapters. NONE of these talk to a real system: KRA, KPA, NTSA and KeNHA access would need agreements.

Every response carries adapter="MOCK" so that the UI can label it. The class interfaces are where real adapters would go.
"""
from __future__ import annotations

import hashlib


def _stable_u(key: str) -> float:
    return int(hashlib.sha256(key.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


class MockAdapters:
    """Deterministic: the same container always returns the same mock answer, so demos are repeatable."""

    def __init__(self) -> None:
        self.kra_down = False
        self.force_unreleased: set[str] = set()

    def release_status(self, container: str | None) -> dict | None:
        if self.kra_down:
            return None
        if not container:
            return {"adapter": "MOCK", "customs": False, "shipping_line": False, "kpa": False, "icms_ref": None}
        hold = container in self.force_unreleased or _stable_u("rel" + container) < 0.002
        return {
            "adapter": "MOCK",
            "customs": not hold,
            "shipping_line": True,
            "kpa": True,
            "icms_ref": "MOCK-ICMS-" + hashlib.sha256(container.encode()).hexdigest()[:8].upper(),
        }

    def release_ok(self, status: dict | None) -> bool | None:
        if status is None:
            return None
        return bool(status["customs"] and status["shipping_line"] and status["kpa"])

    def declared_cargo(self, container: str | None, true_cargo_kg: float, misdeclared: bool = False) -> dict:
        if not container:
            return {"adapter": "MOCK", "declared_cargo_kg": None, "container_tare_kg": None}
        u = _stable_u("dec" + container)
        err = 1.0 + (u - 0.5) * 0.03
        if misdeclared:
            err *= 0.8
        return {"adapter": "MOCK", "declared_cargo_kg": round(true_cargo_kg * err), "container_tare_kg": 3800 if u < 0.5 else 2300}

    def eseal(self, container: str | None) -> dict:
        if not container:
            return {"adapter": "MOCK", "eseal_id": None, "status": "NONE"}
        return {"adapter": "MOCK", "eseal_id": "ES" + hashlib.sha256(container.encode()).hexdigest()[:8].upper(), "status": "SEALED"}

    def ntsa_vehicle(self, plate: str) -> dict:
        return {"adapter": "MOCK", "plate": plate, "registration_valid": _stable_u("ntsa" + plate) > 0.01, "insurance_valid": _stable_u("ins" + plate) > 0.02, "roadworthy": _stable_u("rw" + plate) > 0.02}


adapters = MockAdapters()
