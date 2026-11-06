"""Weight calculations, axle comparisons, expected gross, margins and every decision rule."""
import pytest

from rcs.domain import decision as D
from rcs.domain.policy import Policy
from rcs.domain.vehicle import axle_count, container_check_digit, container_valid, effective_config_with_lift, expected_gross_kg, group_loads, groups_for, gross_limit_for, make_container, variance_pct

P = Policy()
CFG = "1-2-3"
GOOD = D.IdentityReads("KDA 1", "T1", "ZD 1", "KDA 1", "T1", "ZD 1", CFG)
LIMIT = 50000


def axles(gross):
    """Axle loads in proportion to the group limits, so that gross and groups sit at the same ratio."""
    return [gross * 8 / 50] + [gross * 9 / 50] * 2 + [gross * 8 / 50] * 3


def meas(gross, **kw):
    base = dict(gross_kg=gross, axle_loads_kg=axles(gross), height_m=4.1, width_m=2.5, length_m=17.0, axles_detected=6, quality=0.95)
    base.update(kw)
    return D.Measurement(**base)


def token(gross, source="port", **kw):
    return D.TokenView("LCT-1", gross, source, {"port": 1, "origin": 2}.get(source, 3), plate="KDA 1", tag="T1", height_m=4.1, width_m=2.5, length_m=17.0, **kw)


# ---------------------------------------------------------------- weights
def test_axle_count_and_groups():
    assert axle_count("1-2-3") == 6
    assert [g.kind for g in groups_for("1-2-3", P)] == ["steer", "tandem", "tridem"]
    assert [g.limit_kg for g in groups_for("1-2-3", P)] == [8000, 18000, 24000]


def test_group_loads_sum_by_group():
    assert group_loads([7000, 8000, 8000, 7000, 7000, 7000], "1-2-3") == [7000, 16000, 21000]


def test_gross_limit_is_the_lower_of_table_and_group_sum():
    assert gross_limit_for("1-2-3", P) == 50000
    assert gross_limit_for("1-2-2", P) == 42000  # groups would allow 44 t
    assert gross_limit_for("1-1", P) == 18000


def test_expected_gross_weight():
    assert expected_gross_kg(8800, 7200, 3800, 21500) == 41300


def test_variance():
    assert variance_pct(108, 100) == pytest.approx(8.0)
    with pytest.raises(ValueError):
        variance_pct(1, 0)


def test_margin_is_k_times_error():
    assert P.margin_pct("road") == pytest.approx(5.0)
    assert P.margin_pct("lane") == pytest.approx(2.0)
    assert Policy(road_error_pct=4).margin_pct("road") == pytest.approx(8.0)


def test_group_overload_governs_even_when_gross_is_fine():
    m = D.Measurement(gross_kg=40000, axle_loads_kg=[7000, 5000, 5000, 9000, 9000, 9000])  # tridem 27 t against 24 t
    w = D.assess_weights(m, CFG, P)
    assert w["worst"] == "tridem"
    assert w["ratio"] == pytest.approx(27 / 24)


def test_lift_changes_effective_configuration():
    assert effective_config_with_lift("1-2-3") == "1-2-2"


def test_container_check_digit():
    assert container_check_digit("CSQU305438") == 3  # ISO 6346 reference example
    assert container_valid("CSQU3054383")
    assert not container_valid("CSQU3054384")
    assert not container_valid("BADNUMBER")
    assert not container_valid(None)
    assert container_valid(make_container("MSC", 123456))


# ---------------------------------------------------------------- identity
def test_green_identity_needs_plate_and_second_identifier():
    conf, _ = D.identity_confidence(GOOD)
    assert conf >= P.identity_min_confidence
    plate_only, _ = D.identity_confidence(D.IdentityReads("KDA 1", None, "ZD 1", "KDA 1", "T1", "ZD 1", CFG))
    assert plate_only < P.identity_min_confidence
    rfid_only, _ = D.identity_confidence(D.IdentityReads(None, "T1", "ZD 1", "KDA 1", "T1", "ZD 1", CFG))
    assert rfid_only < P.identity_min_confidence


def test_wrong_plate_lowers_confidence_below_missing_plate():
    wrong, _ = D.identity_confidence(D.IdentityReads("KXX 9", "T1", "ZD 1", "KDA 1", "T1", "ZD 1", CFG))
    missing, _ = D.identity_confidence(D.IdentityReads(None, "T1", "ZD 1", "KDA 1", "T1", "ZD 1", CFG))
    assert wrong < missing


# ---------------------------------------------------------------- port
def test_port_green_issues_token():
    d = D.decide_port(meas(40000), GOOD, P, CFG, True, 40500)
    assert d.outcome == D.Outcome.GREEN and d.issue_token


def test_port_near_limit_is_amber_reweigh():
    d = D.decide_port(meas(LIMIT * 0.99), GOOD, P, CFG, True, LIMIT * 0.99)
    assert d.outcome == D.Outcome.AMBER and d.action == D.Action.PORT_REWEIGH and not d.issue_token


def test_port_over_margin_is_red_hold():
    d = D.decide_port(meas(LIMIT * 1.05), GOOD, P, CFG, True, LIMIT * 1.05)
    assert d.outcome == D.Outcome.RED and d.action == D.Action.HOLD_CORRECTIVE


def test_port_weight_variance_flags_misdeclaration():
    d = D.decide_port(meas(40000), GOOD, P, CFG, True, 30000)
    assert d.outcome == D.Outcome.AMBER and "misdeclaration" in d.explanation


@pytest.mark.parametrize("release", [False, None])
def test_port_release_not_confirmed_never_green(release):
    assert D.decide_port(meas(40000), GOOD, P, CFG, release, 40000).outcome == D.Outcome.AMBER


def test_port_scale_failure_fails_safe():
    d = D.decide_port(D.Measurement(sensor_fault="scale down"), GOOD, P, CFG, True, 40000)
    assert d.outcome == D.Outcome.AMBER and d.fail_safe


def test_port_allowance_widens_threshold():
    p = Policy(allowance_pct=5)
    assert D.decide_port(meas(LIMIT * 1.0), GOOD, p, CFG, True, LIMIT).outcome == D.Outcome.GREEN


# ---------------------------------------------------------------- origin
def test_origin_green_needs_approved_calibrated_signed():
    assert D.decide_origin(meas(40000), GOOD, P, CFG, True, True, True).outcome == D.Outcome.GREEN


@pytest.mark.parametrize("kw", [dict(scale_approved=False, calibration_valid=True, ticket_signature_valid=True), dict(scale_approved=True, calibration_valid=False, ticket_signature_valid=True), dict(scale_approved=True, calibration_valid=True, ticket_signature_valid=False)])
def test_origin_without_trust_gets_no_token(kw):
    d = D.decide_origin(meas(40000), GOOD, P, CFG, **kw)
    assert d.outcome != D.Outcome.GREEN and not d.issue_token


def test_onboard_record_cannot_issue_token():
    assert not D.decide_origin(meas(40000), GOOD, P, CFG, True, True, True, onboard_only=True).issue_token


# ---------------------------------------------------------------- road
def test_road_valid_token_green_even_near_limit():
    """The whole point of RCS v2: the road reading only has to confirm the weight is unchanged."""
    d = D.decide_road(meas(LIMIT * 0.985), GOOD, P, CFG, token(LIMIT * 0.98))
    assert d.outcome == D.Outcome.GREEN and not d.issue_token


def test_road_no_token_clear_of_margin_green_and_issues_road_token():
    d = D.decide_road(meas(LIMIT * 0.8), GOOD, P, CFG, None)
    assert d.outcome == D.Outcome.GREEN and d.issue_token


def test_road_no_token_in_margin_band_diverts():
    d = D.decide_road(meas(LIMIT * 0.97), GOOD, P, CFG, None)
    assert d.outcome == D.Outcome.AMBER and d.action == D.Action.DIVERT_LANE


def test_road_tolerance_8pct_for_first_point_11pct_for_road_tokens():
    g = 40000
    assert D.decide_road(meas(g * 1.075), GOOD, P, CFG, token(g, "port")).outcome == D.Outcome.GREEN
    assert D.decide_road(meas(g * 1.09), GOOD, P, CFG, token(g, "port")).outcome == D.Outcome.AMBER
    assert D.decide_road(meas(g * 1.09), GOOD, P, CFG, token(g, "road")).outcome == D.Outcome.GREEN
    assert D.decide_road(meas(g * 1.12), GOOD, P, CFG, token(g, "road")).outcome == D.Outcome.AMBER


def test_tolerance_is_configurable():
    p = Policy(tolerance_first_point_pct=3)
    assert D.decide_road(meas(40000 * 1.05), GOOD, p, CFG, token(40000)).outcome == D.Outcome.AMBER


@pytest.mark.parametrize("kw", [dict(signature_valid=False), dict(status="REVOKED"), dict(status="SUSPENDED"), dict(expired=True)])
def test_road_bad_token_not_honoured(kw):
    assert D.decide_road(meas(40000), GOOD, P, CFG, token(40000, **kw)).outcome == D.Outcome.AMBER


def test_road_token_identity_mismatch():
    t = token(40000)
    t.plate = "KZZ 9"
    assert D.decide_road(meas(40000), GOOD, P, CFG, t).outcome == D.Outcome.AMBER


def test_road_dimension_change_against_token():
    assert D.decide_road(meas(40000, height_m=3.5), GOOD, P, CFG, token(40000)).outcome == D.Outcome.AMBER


def test_road_lifted_axle_diverts():
    d = D.decide_road(meas(40000, axles_detected=5), GOOD, P, CFG, token(40000))
    assert d.outcome == D.Outcome.AMBER and "Axle mismatch" in d.explanation


def test_road_dimension_breach_diverts():
    assert D.decide_road(meas(40000, height_m=4.6), GOOD, P, CFG, None).outcome == D.Outcome.AMBER


def test_road_audit_diverts_a_compliant_truck():
    d = D.decide_road(meas(40000), GOOD, P, CFG, token(40000), audit_selected=True)
    assert d.outcome == D.Outcome.AMBER and "audit" in d.explanation.lower()


@pytest.mark.parametrize("m", [D.Measurement(), D.Measurement(sensor_fault="WIM down"), D.Measurement(gross_kg=30000, quality=0.2, axles_detected=6, height_m=4, width_m=2.5, length_m=17), D.Measurement(gross_kg=30000, quality=0.95, axles_detected=6)])
def test_never_green_on_missing_data(m):
    d = D.decide_road(m, GOOD, P, CFG, token(30000))
    assert d.outcome != D.Outcome.GREEN


def test_never_green_with_unread_identity():
    d = D.decide_road(meas(40000), D.IdentityReads(None, None, None, "KDA 1", "T1", "ZD 1", CFG), P, CFG, token(40000))
    assert d.outcome == D.Outcome.AMBER


def test_lane_closed_diverts_to_static():
    d = D.decide_road(meas(LIMIT * 0.97), GOOD, P, CFG, None, lane_available=False)
    assert d.action == D.Action.STATIC_SCALE


# ---------------------------------------------------------------- lane
def test_lane_green_issues_token():
    d = D.decide_lane(meas(LIMIT * 0.95), GOOD, P, CFG, None)
    assert d.outcome == D.Outcome.GREEN and d.issue_token


def test_lane_margin_band_requires_static_until_approved():
    assert D.decide_lane(meas(LIMIT * 0.99), GOOD, P, CFG, None).action == D.Action.STATIC_SCALE
    assert D.decide_lane(meas(LIMIT * 0.99), GOOD, Policy(lane_legal_grade=True), CFG, None).outcome == D.Outcome.GREEN


def test_lane_near_limit_ok_when_consistent_with_token():
    assert D.decide_lane(meas(LIMIT * 0.99), GOOD, P, CFG, token(LIMIT * 0.985)).outcome == D.Outcome.GREEN


def test_lane_overload_red():
    assert D.decide_lane(meas(LIMIT * 1.06), GOOD, P, CFG, None).outcome == D.Outcome.RED


def test_lane_dimension_breach_red():
    assert D.decide_lane(meas(40000, height_m=4.7), GOOD, P, CFG, None).outcome == D.Outcome.RED


def test_lane_inconclusive_goes_static():
    d = D.decide_lane(D.Measurement(sensor_fault="scale"), GOOD, P, CFG, None)
    assert d.outcome == D.Outcome.RED and d.action == D.Action.STATIC_SCALE and d.fail_safe


def test_lane_lifted_axle_rechecks_against_effective_limit():
    loads = [7000, 8500, 8500, 10000, 10000]  # tridem load on two axles: 20 t against a tandem's 18 t
    m = D.Measurement(gross_kg=sum(loads), axle_loads_kg=loads, height_m=4.1, width_m=2.5, length_m=17, lifted_axle=True, quality=0.98)
    assert D.decide_lane(m, GOOD, P, CFG, None).outcome == D.Outcome.RED


def test_lane_never_replaces_static_as_proof():
    d = D.decide_lane(meas(LIMIT * 1.2), GOOD, P, CFG, None)
    assert d.action == D.Action.STATIC_SCALE and not d.requires_officer


# ---------------------------------------------------------------- static
def test_static_confirmed_overload_needs_officer():
    d = D.decide_static(meas(LIMIT * 1.03), GOOD, P, CFG)
    assert d.outcome == D.Outcome.RED and d.requires_officer and d.action == D.Action.OFFICER_REVIEW


def test_static_within_limit_clears_with_no_margin():
    assert D.decide_static(meas(LIMIT * 0.999), GOOD, P, CFG).outcome == D.Outcome.GREEN


def test_fee_is_illustrative_and_triples_on_repeat():
    assert D.overload_fee_usd(5000, P) == pytest.approx(2990.0)
    assert D.overload_fee_usd(5000, P, repeat_in_journey=True) == pytest.approx(8970.0)


def test_audit_rate_follows_risk():
    assert D.audit_rate_pct(P, 1) == pytest.approx(3.0)
    assert D.audit_rate_pct(P, 1, demerits=4) > D.audit_rate_pct(P, 1)
    assert D.audit_rate_pct(P, 1, clean_record=True) < D.audit_rate_pct(P, 1)
    assert D.audit_rate_pct(P, 4) == 100.0


def test_risk_score_rises_with_flags_and_demerits():
    clean = D.decide_road(meas(40000), GOOD, P, CFG, token(40000))
    flagged = D.decide_road(meas(40000), GOOD, P, CFG, token(40000), critical_flags=["watchlist"], demerits=6)
    assert flagged.risk_score > clean.risk_score and flagged.outcome == D.Outcome.AMBER


def test_container_limit_applies_only_when_enabled():
    m = meas(45000)
    assert D.decide_port(m, GOOD, P, CFG, True, 45000, truck_tare_kg=9000).outcome == D.Outcome.GREEN
    d = D.decide_port(m, GOOD, Policy(apply_container_limit=True), CFG, True, 45000, truck_tare_kg=9000)
    assert d.outcome == D.Outcome.AMBER and "Container gross" in d.explanation


def test_policy_validates_ranges():
    with pytest.raises(ValueError):
        Policy(allowance_pct=9)
    with pytest.raises(ValueError):
        Policy(tandem_group_kg=0)
