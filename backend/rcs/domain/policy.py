"""Configurable clearance policy.

Values come from the two RCS source documents unless flagged in POLICY_PROVENANCE as assumptions.
None of these are claimed to be current law: the documents themselves ask for them to be re-verified.
"""
from __future__ import annotations

from pydantic import BaseModel, Field, model_validator


class Policy(BaseModel):
    # Third Schedule legal weights (RCS v2, Section 3)
    steering_axle_kg: float = 8000
    single_drive_axle_kg: float = 10000
    tandem_group_kg: float = 18000
    tridem_group_kg: float = 24000
    # Reported gross limits by axle count. 5 axles is NOT in the documents, see provenance.
    gross_limits_kg: dict[str, float] = Field(
        default_factory=lambda: {"2": 18000, "3": 26000, "4": 30000, "5": 42000, "6": 50000}
    )
    container_limit_kg: float = 34000
    apply_container_limit: bool = False
    # Dimension limits are not stated in the documents (assumed demonstration values).
    max_height_m: float = 4.3
    max_width_m: float = 2.65
    max_length_m: float = 22.0
    # Scale errors: relative standard deviation in percent.
    port_error_pct: float = 1.0
    origin_error_pct: float = 1.0
    road_error_pct: float = 2.5
    lane_error_pct: float = 1.0
    static_error_pct: float = 0.2
    # Measurement margin = k x scale error. k=2 gives the documents' 5% road and 2% lane/port margins.
    margin_k: float = 2.0
    # Token consistency tolerances (about 3 combined standard deviations).
    tolerance_first_point_pct: float = 8.0
    tolerance_road_token_pct: float = 11.0
    # Identity
    identity_min_confidence: float = 0.8
    # Declared vs measured variance tolerated at the port before re-weigh.
    expected_variance_tolerance_pct: float = 8.0
    # Second Schedule discretion allowance: policy decision, off by default.
    allowance_pct: float = 0.0
    port_legal_grade: bool = False
    lane_legal_grade: bool = False
    # Audit rates by trust tier (percent of mainline greens).
    audit_rate_tier1_pct: float = 3.0
    audit_rate_tier2_pct: float = 3.0
    audit_rate_tier3_pct: float = 3.0
    # Token validity windows (hours).
    validity_port_h: float = 72
    validity_origin_h: float = 48
    validity_road_h: float = 24
    min_quality_score: float = 0.6
    # Illustrative fee only: derived from the single documented point (5,000 kg over = about USD 2,990).
    fee_usd_per_kg_over: float = 0.598

    @model_validator(mode="after")
    def _sane(self) -> "Policy":
        for name in ("steering_axle_kg", "single_drive_axle_kg", "tandem_group_kg", "tridem_group_kg", "container_limit_kg", "max_height_m", "max_width_m", "max_length_m", "tolerance_first_point_pct", "tolerance_road_token_pct", "validity_port_h", "validity_origin_h", "validity_road_h"):
            if getattr(self, name) <= 0:
                raise ValueError(f"{name} must be positive")
        for name in ("port_error_pct", "origin_error_pct", "road_error_pct", "lane_error_pct", "static_error_pct", "margin_k", "fee_usd_per_kg_over"):
            if getattr(self, name) < 0:
                raise ValueError(f"{name} cannot be negative")
        if any(v <= 0 for v in self.gross_limits_kg.values()):
            raise ValueError("Gross limits must be positive")
        if not 0 <= self.allowance_pct <= 5:
            raise ValueError("The discretion allowance must be between 0 and 5% (Second Schedule)")
        for name in ("audit_rate_tier1_pct", "audit_rate_tier2_pct", "audit_rate_tier3_pct"):
            if not 0 <= getattr(self, name) <= 100:
                raise ValueError(f"{name} must be between 0 and 100")
        if not 0 <= self.identity_min_confidence <= 1 or not 0 <= self.min_quality_score <= 1:
            raise ValueError("Confidence and quality thresholds must be between 0 and 1")
        return self

    def margin_pct(self, scale: str) -> float:
        return self.margin_k * self.error_pct(scale)

    def error_pct(self, scale: str) -> float:
        return {
            "port": self.port_error_pct,
            "origin": self.origin_error_pct,
            "road": self.road_error_pct,
            "lane": self.lane_error_pct,
            "static": self.static_error_pct,
        }[scale]

    def allowance_factor(self) -> float:
        return 1.0 + self.allowance_pct / 100.0

    def group_limit(self, kind: str) -> float:
        return {
            "steer": self.steering_axle_kg,
            "single": self.single_drive_axle_kg,
            "tandem": self.tandem_group_kg,
            "tridem": self.tridem_group_kg,
        }[kind]

    def gross_limit(self, axle_count: int) -> float:
        key = str(axle_count)
        if key in self.gross_limits_kg:
            return self.gross_limits_kg[key]
        return self.gross_limits_kg[str(max(int(k) for k in self.gross_limits_kg))]


POLICY_PROVENANCE: dict[str, dict[str, str]] = {
    "steering_axle_kg": {"kind": "source", "ref": "RCS v2 s3, Third Schedule (verify before design freeze)"},
    "single_drive_axle_kg": {"kind": "source", "ref": "RCS v2 s3, Third Schedule"},
    "tandem_group_kg": {"kind": "source", "ref": "RCS v2 s3, Third Schedule"},
    "tridem_group_kg": {"kind": "source", "ref": "RCS v2 s3, Third Schedule"},
    "gross_limits_kg": {"kind": "source", "ref": "RCS v2 s3, reported limits; the 5-axle value is an assumption"},
    "container_limit_kg": {"kind": "source", "ref": "RCS v1 s2, to be re-verified; not applied by default"},
    "max_height_m": {"kind": "assumption", "ref": "Not in source documents, confirm with KeNHA"},
    "max_width_m": {"kind": "assumption", "ref": "Not in source documents, confirm with KeNHA"},
    "max_length_m": {"kind": "assumption", "ref": "Not in source documents, confirm with KeNHA"},
    "port_error_pct": {"kind": "assumption", "ref": "RCS v2 s9, to be measured"},
    "origin_error_pct": {"kind": "assumption", "ref": "RCS v2 s9, to be measured"},
    "road_error_pct": {"kind": "assumption", "ref": "RCS v2 s9, to be measured"},
    "lane_error_pct": {"kind": "assumption", "ref": "RCS v2 s9, target"},
    "static_error_pct": {"kind": "assumption", "ref": "Demonstration value"},
    "margin_k": {"kind": "assumption", "ref": "Expanded uncertainty k=2 (reproduces RCS v1 s7 and RCS v2 s9)"},
    "tolerance_first_point_pct": {"kind": "source", "ref": "RCS v2 s6.4, about 8%"},
    "tolerance_road_token_pct": {"kind": "source", "ref": "RCS v2 s6.4, about 11%"},
    "allowance_pct": {"kind": "policy", "ref": "Second Schedule: below 5%, policy decision for KeNHA"},
    "audit_rate_tier1_pct": {"kind": "source", "ref": "RCS v2 s4 (1-3%) and s6.4 (3% of mainline greens)"},
    "audit_rate_tier2_pct": {"kind": "source", "ref": "RCS v2 s4 (3-5%) and s6.4 (3% of mainline greens)"},
    "audit_rate_tier3_pct": {"kind": "source", "ref": "RCS v2 s4 (3%)"},
    "apply_container_limit": {"kind": "policy", "ref": "Off until the 34 t limit is re-verified (RCS v1 s2, RCS v2 s11)"},
    "port_legal_grade": {"kind": "policy", "ref": "Needs weights-and-measures approval (RCS v2 s9, Reg 5)"},
    "lane_legal_grade": {"kind": "policy", "ref": "Needs weights-and-measures approval (RCS v2 s5.1, Reg 5)"},
    "expected_variance_tolerance_pct": {"kind": "assumption", "ref": "Demonstration value: measure from KRA declaration samples"},
    "identity_min_confidence": {"kind": "assumption", "ref": "Demonstration value set so that green needs plate plus a second identifier (RCS v1 s6)"},
    "min_quality_score": {"kind": "assumption", "ref": "Demonstration value: tune during the pilot"},
    "validity_port_h": {"kind": "assumption", "ref": "RCS v2 s6.2 leaves the validity window to be agreed"},
    "validity_origin_h": {"kind": "assumption", "ref": "RCS v2 s6.2 leaves the validity window to be agreed"},
    "validity_road_h": {"kind": "assumption", "ref": "RCS v2 s10.3 lists it as a parameter to set"},
    "fee_usd_per_kg_over": {"kind": "assumption", "ref": "Linear from the one documented point; illustrative only"},
}
