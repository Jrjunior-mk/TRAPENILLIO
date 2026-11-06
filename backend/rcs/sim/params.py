"""Simulation configuration: one parameter set shared by L1, L2, L3, L4 and the live digital twin."""
from __future__ import annotations

from pydantic import BaseModel, Field, model_validator

from ..domain.policy import Policy


class SimConfig(BaseModel):
    # Traffic
    trucks_per_day: float = Field(8000, ge=100, le=40000)
    arrival_distribution: str = Field("time_of_day", pattern="^(time_of_day|uniform|vessel_bursts)$")
    peak_factor: float = Field(1.5, ge=1.0, le=3.0)
    port_share_pct: float = Field(65, ge=0, le=100)
    origin_share_pct: float = Field(25, ge=0, le=100)
    untokened_share_pct: float = Field(10, ge=0, le=100)
    # Loading
    avg_loading_pct: float = Field(85, ge=40, le=100)
    load_spread_pct: float = Field(12, ge=1, le=30)
    overload_pct: float = Field(1.5, ge=0, le=30)
    # Tokens and audits
    token_coverage_pct: float = Field(90, ge=0, le=100)
    audit_pct: float = Field(3, ge=0, le=100)
    # Scale errors (relative standard deviation, percent). L1 can overwrite these.
    port_error_pct: float = Field(1.0, ge=0.05, le=15)
    origin_error_pct: float = Field(1.0, ge=0.05, le=15)
    road_error_pct: float = Field(2.5, ge=0.05, le=20)
    lane_error_pct: float = Field(1.0, ge=0.05, le=15)
    static_error_pct: float = Field(0.2, ge=0.01, le=5)
    measurement_margin_k: float = Field(2.0, ge=0, le=5)
    # Service
    static_stop_min: float = Field(6.0, ge=2.5, le=60)  # includes stop_overhead_min
    stop_overhead_min: float = Field(2.0, ge=0, le=20)
    static_lanes: int = Field(8, ge=1, le=20)
    lane_pass_min: float = Field(1.5, ge=0.2, le=15)
    lane_speed_kmh: float = Field(10, ge=3, le=15)
    lane_headway_m: float = Field(27, ge=15, le=60)
    lanes_per_station: int = Field(1, ge=0, le=4)
    port_reweigh_lanes: int = Field(6, ge=1, le=20)
    port_reweigh_min: float = Field(4.0, ge=1, le=30)
    customs_officers: int = Field(2, ge=1, le=10)
    customs_break_seal_min: float = Field(30, ge=5, le=240)
    sealed_share_pct: float = Field(30, ge=0, le=100)
    # Failures
    outage_per_day: float = Field(0.5, ge=0, le=24)
    outage_duration_min: float = Field(30, ge=1, le=720)
    # Violations (assumed: to be measured, RCS v2 s10.3)
    dimension_violation_pct: float = Field(0.3, ge=0, le=20)
    lifted_axle_pct: float = Field(0.2, ge=0, le=20)
    token_fraud_pct: float = Field(0.1, ge=0, le=20)
    misdeclaration_pct: float = Field(0.5, ge=0, le=30)
    # Policy
    allowance_pct: float = Field(0, ge=0, le=5)
    port_legal_grade: bool = False
    lane_legal_grade: bool = False
    tolerance_first_point_pct: float = Field(8.0, ge=1, le=30)
    tolerance_road_token_pct: float = Field(11.0, ge=1, le=30)
    seed: int = 20261106

    @model_validator(mode="after")
    def _shares_positive(self) -> "SimConfig":
        total = self.port_share_pct + self.origin_share_pct + self.untokened_share_pct
        if total <= 0:
            raise ValueError("Truck stream shares must add up to more than zero")
        return self

    def shares(self) -> tuple[float, float, float]:
        total = self.port_share_pct + self.origin_share_pct + self.untokened_share_pct
        return self.port_share_pct / total, self.origin_share_pct / total, self.untokened_share_pct / total

    def enrolment(self) -> tuple[float, float]:
        """Token coverage is the share of ALL trucks carrying a first-point token.

        Port and origin trucks enrol first. Coverage above their combined share comes from spot traffic
        that has signed up with an approved loading-site scale. Returns P(token | port or origin), P(token | spot).
        """
        p, o, u = self.shares()
        t = self.token_coverage_pct / 100.0
        anchored = p + o
        if anchored <= 0:
            return 0.0, min(1.0, t / max(u, 1e-9))
        first = min(1.0, t / anchored)
        rest = max(0.0, t - anchored)
        return first, (min(1.0, rest / u) if u > 0 else 0.0)

    def lane_service_s(self) -> float:
        """Headway-limited lane service: 27 m at 10 km/h is 9.7 s, about 370 trucks an hour."""
        return self.lane_headway_m / (self.lane_speed_kmh / 3.6)

    def lane_capacity_per_h(self) -> float:
        return 3600.0 / self.lane_service_s()

    def static_service_min(self) -> float:
        return max(0.5, self.static_stop_min - self.stop_overhead_min)

    def policy(self) -> Policy:
        return Policy(
            port_error_pct=self.port_error_pct,
            origin_error_pct=self.origin_error_pct,
            road_error_pct=self.road_error_pct,
            lane_error_pct=self.lane_error_pct,
            static_error_pct=self.static_error_pct,
            margin_k=self.measurement_margin_k,
            allowance_pct=self.allowance_pct,
            port_legal_grade=self.port_legal_grade,
            lane_legal_grade=self.lane_legal_grade,
            tolerance_first_point_pct=self.tolerance_first_point_pct,
            tolerance_road_token_pct=self.tolerance_road_token_pct,
            audit_rate_tier1_pct=self.audit_pct,
            audit_rate_tier2_pct=self.audit_pct,
            audit_rate_tier3_pct=self.audit_pct,
        )


PARAM_PROVENANCE: dict[str, str] = {
    "arrival_distribution": "ASSUMED: the time-of-day shape is a model assumption until gate and weighbridge logs are available",
    "measurement_margin_k": "ASSUMED: k=2 reproduces the 5% road and 2% lane margins in RCS v1 s7 and RCS v2 s9",
    "lanes_per_station": "DESIGN, RCS v2 s5.1 (one lane per station)",
    "trucks_per_day": "SOURCE (public figure for Mariakani, RCS v1 s1); treated as corridor volume",
    "peak_factor": "ASSUMED, RCS v2 s10.3 (1.5)",
    "port_share_pct": "ASSUMED: stream mix must be measured by classification counts (RCS v2 s10.3)",
    "origin_share_pct": "ASSUMED: stream mix must be measured by classification counts",
    "untokened_share_pct": "ASSUMED: stream mix must be measured by classification counts",
    "avg_loading_pct": "ASSUMED, RCS v2 s9 (75-90%)",
    "load_spread_pct": "ASSUMED, RCS v2 s9 (12%)",
    "overload_pct": "DERIVED from the reported 98.5% compliance (RCS v1 s2)",
    "token_coverage_pct": "ASSUMED, enrolment plan target (RCS v2 s10.3)",
    "audit_pct": "PROPOSED, RCS v2 s6.4 (3%)",
    "port_error_pct": "ASSUMED, RCS v2 s9 (1%)",
    "origin_error_pct": "ASSUMED, RCS v2 s10.3 (1%)",
    "road_error_pct": "ASSUMED, RCS v2 s9 (2.5%)",
    "lane_error_pct": "TARGET, RCS v2 s5 (1%)",
    "static_stop_min": "ASSUMED, RCS v2 s9 (6 min)",
    "static_lanes": "ASSUMED, RCS v2 s10.3 (8 lanes)",
    "lane_pass_min": "ASSUMED, RCS v2 s9 (1.5 min)",
    "lane_speed_kmh": "DESIGN, RCS v2 s5.1 (10 km/h)",
    "lane_headway_m": "DESIGN, RCS v2 s5.1 (27 m)",
    "outage_per_day": "ASSUMED, demonstration value: must be measured",
    "outage_duration_min": "ASSUMED, demonstration value: must be measured",
    "dimension_violation_pct": "ASSUMED, demonstration value: must be measured (RCS v2 s10.3)",
    "lifted_axle_pct": "ASSUMED, demonstration value: must be measured (RCS v2 s10.3)",
    "token_fraud_pct": "ASSUMED, demonstration value: not in the RCS v2 model, covered there by audits",
    "misdeclaration_pct": "ASSUMED, demonstration value: must be measured from KRA samples",
    "port_reweigh_lanes": "ASSUMED, demonstration value: must be measured with KPA",
    "port_reweigh_min": "ASSUMED, demonstration value",
    "customs_break_seal_min": "ASSUMED, demonstration value",
}
