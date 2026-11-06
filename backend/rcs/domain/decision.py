"""Clearance decision engine: the operational brain. Pure functions, no I/O.

Rules follow RCS v2 s6.4 and RCS v1 s7:
* Clear only if the reading plus the validated margin is at or below the limit.
* A tokened truck on the road only has to prove it is unchanged since its first trusted weighing.
* Screening never replaces the static scale as proof of overload (Reg 4(6), Reg 18(3)); an authorised
  officer approves overload tickets and release orders (Reg 3(4)).
* Missing data, sensor faults and processing failures never produce a green.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum

from .policy import Policy
from .vehicle import effective_config_with_lift, group_loads, groups_for, gross_limit_for


class Outcome(str, Enum):
    GREEN = "GREEN"
    AMBER = "AMBER"
    RED = "RED"


class Action(str, Enum):
    CONTINUE = "CONTINUE"
    DIVERT_LANE = "DIVERT_LANE"
    STATIC_SCALE = "STATIC_SCALE"
    PORT_REWEIGH = "PORT_REWEIGH"
    HOLD_CORRECTIVE = "HOLD_CORRECTIVE"
    OFFICER_REVIEW = "OFFICER_REVIEW"
    DENY_TOKEN = "DENY_TOKEN"


@dataclass
class Measurement:
    gross_kg: float | None = None
    axle_loads_kg: list[float] | None = None
    height_m: float | None = None
    width_m: float | None = None
    length_m: float | None = None
    axles_detected: int | None = None
    lifted_axle: bool = False
    quality: float | None = None
    speed_kmh: float | None = None
    sensor_fault: str | None = None


@dataclass
class IdentityReads:
    plate_read: str | None = None
    tag_read: str | None = None
    trailer_read: str | None = None
    plate_registered: str | None = None
    tag_registered: str | None = None
    trailer_registered: str | None = None
    axle_config_registered: str | None = None


@dataclass
class TokenView:
    token_id: str
    gross_kg: float
    source: str  # port | origin | road | lane | static
    trust_tier: int
    signature_valid: bool = True
    status: str = "ACTIVE"
    expired: bool = False
    plate: str | None = None
    tag: str | None = None
    trailer: str | None = None
    axle_config: str | None = None
    height_m: float | None = None
    width_m: float | None = None
    length_m: float | None = None


@dataclass
class Check:
    code: str
    label: str
    status: str  # pass | warn | fail | na
    detail: str = ""


@dataclass
class Decision:
    stage: str
    outcome: Outcome
    action: Action
    reasons: list[str] = field(default_factory=list)
    checks: list[Check] = field(default_factory=list)
    risk_score: float = 0.0
    confidence: float = 0.0
    explanation: str = ""
    issue_token: bool = False
    fail_safe: bool = False
    governing_ratio: float | None = None
    requires_officer: bool = False

    def to_dict(self) -> dict:
        d = asdict(self)
        d["outcome"] = self.outcome.value
        d["action"] = self.action.value
        return d


def identity_confidence(ids: IdentityReads) -> tuple[float, list[str]]:
    """A green needs at least a plate match plus a second independent identifier (RCS v1 s6)."""
    score, notes = 0.0, []
    plate_ok = bool(ids.plate_read and ids.plate_registered and ids.plate_read == ids.plate_registered)
    tag_ok = bool(ids.tag_read and ids.tag_registered and ids.tag_read == ids.tag_registered)
    if plate_ok:
        score += 0.55
    elif ids.plate_read and ids.plate_registered:
        notes.append("ANPR plate does not match the registered record.")
        score -= 0.4
    else:
        notes.append("ANPR plate unavailable.")
    if tag_ok:
        score += 0.35
    elif ids.tag_read and ids.tag_registered:
        notes.append("RFID tag bound to a different vehicle.")
        score -= 0.4
    else:
        notes.append("RFID tag unavailable.")
    if ids.trailer_registered is None or ids.trailer_read == ids.trailer_registered:
        score += 0.10
    elif ids.trailer_read:
        notes.append("Trailer pairing differs from the registered pairing.")
        score -= 0.1
    else:
        notes.append("Trailer plate unread.")
    return max(0.0, min(1.0, score)), notes


def assess_weights(m: Measurement, config: str, policy: Policy) -> dict:
    """Returns the governing ratio: the largest of gross and each axle group, as a fraction of its limit."""
    gross_limit = gross_limit_for(config, policy)
    gov = (m.gross_kg or 0.0) / gross_limit
    worst = "gross"
    details = []
    if m.axle_loads_kg and len(m.axle_loads_kg) == sum(int(p) for p in config.split("-")):
        for g, load in zip(groups_for(config, policy), group_loads(m.axle_loads_kg, config)):
            r = load / g.limit_kg
            details.append({"group": g.kind, "axles": g.axles, "load_kg": round(load), "limit_kg": g.limit_kg, "ratio": round(r, 4)})
            if r > gov:
                gov, worst = r, g.kind
    return {"ratio": gov, "worst": worst, "gross_limit_kg": gross_limit, "groups": details}


def dimension_breach(m: Measurement, policy: Policy, permit: dict | None) -> list[str]:
    limits = {"height_m": policy.max_height_m, "width_m": policy.max_width_m, "length_m": policy.max_length_m}
    if permit:
        limits.update({k: v for k, v in permit.items() if k in limits and v})
    breaches = []
    for key, limit in limits.items():
        value = getattr(m, key)
        if value is not None and value > limit:
            breaches.append(f"{key.split('_')[0]} {value:.2f} m exceeds {limit:.2f} m")
    return breaches


def _dims_missing(m: Measurement) -> bool:
    return m.height_m is None or m.width_m is None or m.length_m is None


def _risk(flags: list[str], demerits: int, trust_tier: int | None, identity: float, ratio: float) -> float:
    score = 5.0
    score += 18.0 * (1.0 - identity)
    score += max(0.0, ratio - 0.85) * 120.0
    score += min(demerits, 12) * 2.5
    score += {1: 0, 2: 3, 3: 6, 4: 12}.get(trust_tier or 0, 10)
    score += 15.0 * len(flags)
    return round(min(score, 100.0), 1)


def _finish(d: Decision, flags: list[str], demerits: int, identity: float, ratio: float, tier: int | None) -> Decision:
    d.risk_score = _risk(flags, demerits, tier, identity, ratio)
    d.governing_ratio = round(ratio, 4)
    d.confidence = round(identity * 0.5 + 0.5 * (0.3 if d.fail_safe else 1.0), 3)
    if not d.explanation:
        d.explanation = " ".join(r if r.endswith(".") else r + "." for r in d.reasons) if d.reasons else "All checks passed."
    return d


def _weight_available(m: Measurement) -> bool:
    return not m.sensor_fault and m.gross_kg is not None


def decide_port(
    m: Measurement,
    ids: IdentityReads,
    policy: Policy,
    config: str,
    release_ok: bool | None,
    expected_gross_kg: float | None,
    container_ok: bool = True,
    permit: dict | None = None,
    demerits: int = 0,
    critical_flags: list[str] | None = None,
    truck_tare_kg: float | None = None,
) -> Decision:
    """Port gate-out node: green issues a token; amber goes to the port re-weigh lane; red is held."""
    flags = list(critical_flags or [])
    checks: list[Check] = []
    conf, notes = identity_confidence(ids)
    id_ok = conf >= policy.identity_min_confidence
    checks.append(Check("identity", "Tractor, trailer and RFID", "pass" if id_ok else "warn", f"Confidence {conf:.2f}. " + " ".join(notes)))
    checks.append(Check("container", "Container number and check digit", "pass" if container_ok else "warn"))
    if release_ok is None:
        checks.append(Check("release", "Customs, shipping line and KPA release", "warn", "Release status unavailable"))
    else:
        checks.append(Check("release", "Customs, shipping line and KPA release", "pass" if release_ok else "fail"))

    if not _weight_available(m):
        checks.append(Check("weight", "Port scale reading", "fail", m.sensor_fault or "No reading"))
        reason = f"Port scale reading unavailable ({m.sensor_fault or 'no data'}): failing safe to re-weigh"
        return _finish(Decision("PORT", Outcome.AMBER, Action.PORT_REWEIGH, [reason], checks, fail_safe=True), flags, demerits, conf, 0.0, 1)

    w = assess_weights(m, config, policy)
    ratio = w["ratio"]
    margin = 0.0 if policy.port_legal_grade else policy.margin_pct("port") / 100.0
    allow = policy.allowance_factor()
    reasons: list[str] = []

    if ratio - margin > allow:
        checks.append(Check("weight", "Weight against limit after margin", "fail", f"{ratio:.1%} of limit on {w['worst']}"))
        reason = f"Over the limit beyond the {margin:.1%} margin ({ratio:.1%} of {w['worst']} limit): held for corrective action"
        return _finish(Decision("PORT", Outcome.RED, Action.HOLD_CORRECTIVE, [reason], checks), flags, demerits, conf, ratio, 1)
    if ratio + margin > allow:
        reasons.append(f"Within the {margin:.1%} measurement margin of the limit ({ratio:.1%} of {w['worst']} limit)")
        checks.append(Check("weight", "Weight against limit after margin", "warn", f"{ratio:.1%} of limit"))
    else:
        checks.append(Check("weight", "Weight against limit after margin", "pass", f"{ratio:.1%} of limit, margin {margin:.1%}"))

    if expected_gross_kg:
        var = abs(m.gross_kg - expected_gross_kg) / expected_gross_kg * 100.0
        ok = var <= policy.expected_variance_tolerance_pct
        checks.append(Check("expected", "Measured against expected gross", "pass" if ok else "warn", f"Variance {var:.1f}% (tolerance {policy.expected_variance_tolerance_pct:.1f}%)"))
        if not ok:
            reasons.append(f"Measured weight differs from expected by {var:.1f}%: possible misdeclaration")
    else:
        checks.append(Check("expected", "Measured against expected gross", "warn", "Declared cargo or tare missing"))
        reasons.append("Expected gross weight cannot be computed")

    if policy.apply_container_limit and truck_tare_kg is not None:
        container_gross = m.gross_kg - truck_tare_kg
        ok = container_gross <= policy.container_limit_kg
        checks.append(Check("container_limit", "Container road limit", "pass" if ok else "fail", f"{container_gross:,.0f} kg against {policy.container_limit_kg:,.0f} kg"))
        if not ok:
            reasons.append(f"Container gross {container_gross:,.0f} kg exceeds the {policy.container_limit_kg:,.0f} kg limit")

    dims = dimension_breach(m, policy, permit)
    if dims:
        checks.append(Check("dimensions", "Dimensions", "fail", "; ".join(dims)))
        reasons.append("Dimension breach: " + "; ".join(dims))
    elif _dims_missing(m):
        checks.append(Check("dimensions", "Dimensions", "warn", "LiDAR dimensions unavailable"))
        reasons.append("Dimensions unavailable")
    else:
        checks.append(Check("dimensions", "Dimensions", "pass", f"{m.height_m:.2f} x {m.width_m:.2f} x {m.length_m:.2f} m"))

    if not id_ok:
        reasons.append("Identity confidence too low: " + " ".join(notes))
    if release_ok is not True:
        reasons.append("Release status missing or not granted")
    if not container_ok:
        reasons.append("Container number missing or fails the check digit")
    if flags:
        reasons.append("Critical flags: " + ", ".join(flags))

    if reasons:
        return _finish(Decision("PORT", Outcome.AMBER, Action.PORT_REWEIGH, reasons, checks), flags, demerits, conf, ratio, 1)
    return _finish(Decision("PORT", Outcome.GREEN, Action.CONTINUE, [], checks, issue_token=True), flags, demerits, conf, ratio, 1)


def decide_origin(
    m: Measurement,
    ids: IdentityReads,
    policy: Policy,
    config: str,
    scale_approved: bool,
    calibration_valid: bool,
    ticket_signature_valid: bool,
    site_suspended: bool = False,
    onboard_only: bool = False,
    demerits: int = 0,
) -> Decision:
    """Approved loading-site scale. Without an approved scale there is no token (RCS v2 s4)."""
    checks: list[Check] = []
    conf, notes = identity_confidence(ids)
    tier = 4 if onboard_only else 2
    id_ok = conf >= policy.identity_min_confidence
    checks.append(Check("identity", "Vehicle identity match", "pass" if id_ok else "warn", f"Confidence {conf:.2f}. " + " ".join(notes)))
    checks.append(Check("ticket", "Signed weighing ticket", "pass" if ticket_signature_valid else "fail"))
    checks.append(Check("scale", "Scale approval (Reg 5)", "pass" if scale_approved else "fail"))
    checks.append(Check("calibration", "Calibration within 3 months (Reg 6)", "pass" if calibration_valid else "fail"))
    reasons: list[str] = []
    if onboard_only:
        reasons.append("On-board record only: informs the risk score but cannot issue a token; verify in the lane")
    if not scale_approved:
        reasons.append("Scale not approved: no token can be issued")
    if not calibration_valid:
        reasons.append("Scale calibration expired: no token can be issued")
    if not ticket_signature_valid:
        reasons.append("Weighing ticket signature invalid")
    if site_suspended:
        reasons.append("Loading site suspended for drift or under-reporting")
    if not id_ok:
        reasons.append("Identity confidence too low")
    if not _weight_available(m):
        reasons.append("Scale reading unavailable")
        checks.append(Check("weight", "Scale reading", "fail", m.sensor_fault or "No reading"))
        return _finish(Decision("ORIGIN", Outcome.AMBER, Action.DENY_TOKEN, reasons, checks, fail_safe=True), [], demerits, conf, 0.0, tier)

    w = assess_weights(m, config, policy)
    ratio = w["ratio"]
    margin = policy.margin_pct("origin") / 100.0
    allow = policy.allowance_factor()
    if ratio - margin > allow:
        checks.append(Check("weight", "Weight after margin", "fail", f"{ratio:.1%} of limit"))
        reasons.append(f"Over the limit beyond the margin ({ratio:.1%} of {w['worst']} limit): offload before dispatch")
        return _finish(Decision("ORIGIN", Outcome.RED, Action.HOLD_CORRECTIVE, reasons, checks), [], demerits, conf, ratio, tier)
    if ratio + margin > allow:
        checks.append(Check("weight", "Weight after margin", "warn", f"{ratio:.1%} of limit"))
        reasons.append(f"Within the {margin:.1%} margin of the limit: no token, verify in the lane")
    else:
        checks.append(Check("weight", "Weight after margin", "pass", f"{ratio:.1%} of limit"))
    if reasons:
        return _finish(Decision("ORIGIN", Outcome.AMBER, Action.DENY_TOKEN, reasons, checks), [], demerits, conf, ratio, tier)
    return _finish(Decision("ORIGIN", Outcome.GREEN, Action.CONTINUE, [], checks, issue_token=True), [], demerits, conf, ratio, tier)


def token_problems(token: TokenView, m: Measurement, ids: IdentityReads, policy: Policy) -> tuple[list[str], float, float]:
    """Consistency test that downstream stations apply to a token. Returns problems, variance and tolerance."""
    problems: list[str] = []
    if not token.signature_valid:
        problems.append("signature invalid")
    if token.status not in ("ACTIVE", "ISSUED"):
        problems.append(f"token {token.status.lower()}")
    if token.expired:
        problems.append("token expired")
    if token.plate and ids.plate_read and token.plate != ids.plate_read:
        problems.append("plate differs from the token")
    if token.tag and ids.tag_read and token.tag != ids.tag_read:
        problems.append("tag differs from the token")
    for dim in ("height_m", "width_m", "length_m"):
        tv, mv = getattr(token, dim), getattr(m, dim)
        if tv and mv and abs(tv - mv) > 0.25:
            problems.append(f"{dim.split('_')[0]} differs from the token by {abs(tv - mv):.2f} m")
    tol = policy.tolerance_road_token_pct if token.source in ("road", "lane", "static") else policy.tolerance_first_point_pct
    var = abs((m.gross_kg or 0.0) - token.gross_kg) / token.gross_kg * 100.0
    if var > tol:
        problems.append(f"weight differs from the token by {var:.1f}% (tolerance {tol:.0f}%)")
    return problems, var, tol


def decide_road(
    m: Measurement,
    ids: IdentityReads,
    policy: Policy,
    config: str,
    token: TokenView | None,
    audit_selected: bool = False,
    permit: dict | None = None,
    demerits: int = 0,
    critical_flags: list[str] | None = None,
    lane_available: bool = True,
    token_lookup_failed: bool = False,
) -> Decision:
    """Road mainline node. Green with a valid token or a clean absolute reading; everything else diverts."""
    flags = list(critical_flags or [])
    checks: list[Check] = []
    divert = Action.DIVERT_LANE if lane_available else Action.STATIC_SCALE
    conf, notes = identity_confidence(ids)
    id_ok = conf >= policy.identity_min_confidence
    checks.append(Check("identity", "ANPR and RFID match", "pass" if id_ok else "warn", f"Confidence {conf:.2f}. " + " ".join(notes)))
    tier = token.trust_tier if token else 3
    reasons: list[str] = []
    fail_safe = False

    if not _weight_available(m):
        checks.append(Check("wim", "High-speed WIM reading", "fail", m.sensor_fault or "No reading"))
        reason = f"WIM reading unavailable ({m.sensor_fault or 'no data'}): failing safe to verification"
        return _finish(Decision("ROAD", Outcome.AMBER, divert, [reason], checks, fail_safe=True), flags, demerits, conf, 0.0, tier)
    if m.quality is not None and m.quality < policy.min_quality_score:
        checks.append(Check("quality", "Data quality gate", "fail", f"Quality {m.quality:.2f} below {policy.min_quality_score:.2f}"))
        reasons.append(f"Reading rejected by the quality gate (score {m.quality:.2f})")
        fail_safe = True
    else:
        checks.append(Check("quality", "Data quality gate", "pass", f"Quality {m.quality:.2f}" if m.quality is not None else "Not reported"))

    w = assess_weights(m, config, policy)
    ratio = w["ratio"]

    dims = dimension_breach(m, policy, permit)
    if dims:
        reasons.append("Dimension breach: " + "; ".join(dims))
        checks.append(Check("dimensions", "LiDAR dimensions", "fail", "; ".join(dims)))
    elif _dims_missing(m):
        reasons.append("LiDAR dimensions unavailable")
        checks.append(Check("dimensions", "LiDAR dimensions", "warn", "No scan"))
    else:
        checks.append(Check("dimensions", "LiDAR dimensions", "pass", f"{m.height_m:.2f} x {m.width_m:.2f} x {m.length_m:.2f} m"))

    registered_axles = sum(int(p) for p in (ids.axle_config_registered or config).split("-"))
    if m.axles_detected is None:
        reasons.append("Axle count unavailable")
        checks.append(Check("axles", "Axle count against registration", "warn", "No count"))
    elif m.axles_detected != registered_axles:
        reasons.append(f"Axle mismatch: {m.axles_detected} detected, {registered_axles} registered (possible lifted axle)")
        checks.append(Check("axles", "Axle count against registration", "fail", f"{m.axles_detected} of {registered_axles}"))
    else:
        checks.append(Check("axles", "Axle count against registration", "pass", f"{m.axles_detected} axles"))

    if not id_ok:
        reasons.append("Identity uncertain: " + " ".join(notes))
    if flags:
        reasons.append("Critical flags: " + ", ".join(flags))

    if token is not None:
        problems, var, tol = token_problems(token, m, ids, policy)
        if problems:
            checks.append(Check("token", "Load Compliance Token", "fail", "; ".join(problems)))
            reasons.append("Token check failed: " + "; ".join(problems))
        else:
            checks.append(Check("token", "Load Compliance Token", "pass", f"{token.token_id} from {token.source}, variance {var:.1f}% within {tol:.0f}%"))
    else:
        margin = policy.margin_pct("road") / 100.0
        allow = policy.allowance_factor()
        checks.append(Check("token", "Load Compliance Token", "warn", "Registry lookup failed" if token_lookup_failed else "No token on record"))
        if ratio + margin > allow:
            reasons.append(f"No token and weight inside the {margin:.1%} margin band ({ratio:.1%} of {w['worst']} limit)")
            checks.append(Check("weight", "Absolute rule after margin", "fail", f"{ratio:.1%} of limit"))
        else:
            checks.append(Check("weight", "Absolute rule after margin", "pass", f"{ratio:.1%} of limit, margin {margin:.1%}"))

    if reasons or fail_safe:
        return _finish(Decision("ROAD", Outcome.AMBER, divert, reasons, checks, fail_safe=fail_safe), flags, demerits, conf, ratio, tier)
    if audit_selected:
        checks.append(Check("audit", "Random audit", "warn", "Selected"))
        return _finish(Decision("ROAD", Outcome.AMBER, divert, ["Random audit selection: result feeds calibration and trust"], checks), flags, demerits, conf, ratio, tier)
    checks.append(Check("audit", "Random audit", "pass", "Not selected"))
    return _finish(Decision("ROAD", Outcome.GREEN, Action.CONTINUE, [], checks, issue_token=token is None), flags, demerits, conf, ratio, tier)


def decide_lane(
    m: Measurement,
    ids: IdentityReads,
    policy: Policy,
    config: str,
    token: TokenView | None,
    permit: dict | None = None,
    demerits: int = 0,
    critical_flags: list[str] | None = None,
) -> Decision:
    """Rolling Verification Lane. Green issues or renews a token; red and inconclusive go to the static scale."""
    flags = list(critical_flags or [])
    checks: list[Check] = []
    conf, notes = identity_confidence(ids)
    tier = token.trust_tier if token else 3

    if not _weight_available(m) or _dims_missing(m) or (m.quality is not None and m.quality < policy.min_quality_score):
        reason = m.sensor_fault or "incomplete parameter capture"
        checks.append(Check("capture", "Full parameter capture", "fail", reason))
        return _finish(Decision("LANE", Outcome.RED, Action.STATIC_SCALE, [f"Inconclusive verification ({reason}): static weighing required"], checks, fail_safe=True), flags, demerits, conf, 0.0, tier)

    checks.append(Check("capture", "Full parameter capture", "pass", f"Quality {m.quality if m.quality is not None else 1:.2f}"))
    effective_config = config
    red: list[str] = []
    if m.lifted_axle:
        effective_config = effective_config_with_lift(config)
        checks.append(Check("lifted", "Lifted-axle check (side LiDAR)", "warn", f"Registered {config}, operating as {effective_config}"))
    else:
        checks.append(Check("lifted", "Lifted-axle check (side LiDAR)", "pass", "All axles in contact"))

    w = assess_weights(m, effective_config, policy)
    ratio = w["ratio"]
    margin = 0.0 if policy.lane_legal_grade else policy.margin_pct("lane") / 100.0
    allow = policy.allowance_factor()

    dims = dimension_breach(m, policy, permit)
    if dims:
        red.append("Dimension or permit breach: " + "; ".join(dims))
        checks.append(Check("dimensions", "LiDAR dimension portal", "fail", "; ".join(dims)))
    else:
        checks.append(Check("dimensions", "LiDAR dimension portal", "pass", f"{m.height_m:.2f} x {m.width_m:.2f} x {m.length_m:.2f} m"))

    if ratio - margin > allow:
        red.append(f"Over the limit beyond the {margin:.1%} margin ({ratio:.1%} of {w['worst']} limit)")
        checks.append(Check("weight", "Weight after margin", "fail", f"{ratio:.1%} of limit on {w['worst']}"))
    else:
        token_ok = False
        if token is not None:
            problems, var, tol = token_problems(token, m, ids, policy)
            token_ok = not problems
            checks.append(Check("token", "Consistency with token", "pass" if token_ok else "fail", f"Variance {var:.1f}% (tolerance {tol:.0f}%)" + ("" if token_ok else ". " + "; ".join(problems))))
        if ratio + margin > allow:
            if token_ok:
                checks.append(Check("weight", "Weight after margin", "warn", f"{ratio:.1%} of limit, unchanged since the token"))
            else:
                red.append(f"Within the {margin:.1%} margin of the limit ({ratio:.1%}): a legal-grade reading is required")
                checks.append(Check("weight", "Weight after margin", "fail", f"{ratio:.1%} of limit"))
        else:
            checks.append(Check("weight", "Weight after margin", "pass", f"{ratio:.1%} of limit, margin {margin:.1%}"))

    if conf < policy.identity_min_confidence:
        red.append("Identity unresolved after the lane: " + " ".join(notes))
    if flags:
        red.append("Critical flags: " + ", ".join(flags))

    if red:
        return _finish(Decision("LANE", Outcome.RED, Action.STATIC_SCALE, red, checks), flags, demerits, conf, ratio, tier)
    return _finish(Decision("LANE", Outcome.GREEN, Action.CONTINUE, [], checks, issue_token=True), flags, demerits, conf, ratio, tier)


def decide_static(
    m: Measurement,
    ids: IdentityReads,
    policy: Policy,
    config: str,
    permit: dict | None = None,
    demerits: int = 0,
) -> Decision:
    """Static weighbridge: the legal authority. A confirmed overload always waits for an authorised officer."""
    checks: list[Check] = []
    conf, _ = identity_confidence(ids)
    if not _weight_available(m):
        checks.append(Check("static", "Static scale reading", "fail", m.sensor_fault or "No reading"))
        return _finish(Decision("STATIC", Outcome.RED, Action.OFFICER_REVIEW, ["Static scale unavailable: manual officer procedure"], checks, fail_safe=True, requires_officer=True), [], demerits, conf, 0.0, None)
    effective = effective_config_with_lift(config) if m.lifted_axle else config
    w = assess_weights(m, effective, policy)
    ratio = w["ratio"]
    allow = policy.allowance_factor()
    reasons = []
    dims = dimension_breach(m, policy, permit)
    if dims:
        reasons.append("Dimension breach confirmed: " + "; ".join(dims))
    if ratio > allow:
        reasons.append(f"Confirmed overload: {ratio:.1%} of {w['worst']} limit")
    checks.append(Check("static", "Legal reading", "fail" if ratio > allow else "pass", f"{ratio:.1%} of limit"))
    if reasons:
        return _finish(Decision("STATIC", Outcome.RED, Action.OFFICER_REVIEW, reasons, checks, requires_officer=True), [], demerits, conf, ratio, None)
    return _finish(Decision("STATIC", Outcome.GREEN, Action.CONTINUE, [], checks, issue_token=True), [], demerits, conf, ratio, None)


def overload_fee_usd(overload_kg: float, policy: Policy, repeat_in_journey: bool = False) -> float:
    """Illustrative only. A repeat overload in one journey triples the fee (Reg 14)."""
    fee = max(0.0, overload_kg) * policy.fee_usd_per_kg_over
    return round(fee * (3 if repeat_in_journey else 1), 2)


def audit_rate_pct(policy: Policy, tier: int | None, demerits: int = 0, clean_record: bool = False) -> float:
    """Audit rate follows risk: rises with demerit points, falls with a clean record, always for tier 4."""
    base = {1: policy.audit_rate_tier1_pct, 2: policy.audit_rate_tier2_pct, 3: policy.audit_rate_tier3_pct, 4: 100.0}.get(tier or 3, policy.audit_rate_tier3_pct)
    rate = base + min(demerits, 12) * 0.5
    if clean_record:
        rate *= 0.6
    return min(100.0, rate)
