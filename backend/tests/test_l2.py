"""Queue simulation, conservation, reproducibility, and validation against the RCS v2 source tables."""
import math

import numpy as np
import pytest

from rcs.domain import decision as D
from rcs.domain.policy import Policy
from rcs.sim.l1_sensor import L1Params, edge_pipeline, run_l1, scale_errors, synth_signal
from rcs.sim.l2_process import SCENARIOS, arrival_profile, compare, fcfs, run_replication
from rcs.sim.l3_traffic import L3Params, run_l3
from rcs.sim.l4_system import L4Params, run_l4
from rcs.sim.montecarlo import ci95, run_linked, run_monte_carlo, run_tornado
from rcs.sim.params import SimConfig

CLEAN = dict(outage_per_day=0, dimension_violation_pct=0, lifted_axle_pct=0, token_fraud_pct=0, misdeclaration_pct=0)


# ---------------------------------------------------------------- validation against the source documents
@pytest.mark.parametrize("coverage,lane,static", [(30, 17.3, 10.0), (50, 13.3, 7.1), (70, 9.3, 4.3), (90, 5.2, 1.5)])
def test_reproduces_rcs_v2_mixed_traffic_table(coverage, lane, static):
    r = run_replication(SimConfig(token_coverage_pct=coverage, **CLEAN), "v2_all", days=12, rep=3)
    assert r["first_station_lane_pct"] == pytest.approx(lane, abs=0.8)
    assert r["first_station_static_pct"] == pytest.approx(static, abs=0.8)


def test_reproduces_road_only_baseline_and_port_reweigh():
    assert run_replication(SimConfig(**CLEAN), "as_is", days=12, rep=3)["first_station_static_pct"] == pytest.approx(20.9, abs=1.0)
    v1 = run_replication(SimConfig(**CLEAN), "rcs_v1", days=12, rep=3)
    assert v1["first_station_static_pct"] == pytest.approx(23.3, abs=1.0)
    assert run_replication(SimConfig(**CLEAN), "v2_all", days=12, rep=3)["port_reweigh_pct"] == pytest.approx(14.9, abs=1.0)


def test_later_stations_send_almost_nothing_to_static():
    r = run_replication(SimConfig(**CLEAN), "v2_all", days=12, rep=3)
    assert r["later_station_lane_pct"] == pytest.approx(3.3, abs=0.4)
    assert r["later_station_static_pct"] < 0.2


def test_allowance_cuts_port_reweigh_sharply():
    r = run_replication(SimConfig(**CLEAN), "v2_approved", days=12, rep=3)
    assert r["port_reweigh_pct"] == pytest.approx(1.3, abs=0.5)


def test_loading_table_trend():
    shares = [run_replication(SimConfig(avg_loading_pct=x, **CLEAN), "as_is", days=6)["first_station_static_pct"] for x in (75, 85, 90)]
    assert shares[0] < shares[1] < shares[2]


def test_no_false_clears_among_tokened_trucks_without_fraud():
    assert run_replication(SimConfig(overload_pct=1.5, **CLEAN), "v2_all", days=8)["false_clear_pct"] < 0.05


def test_false_clear_target():
    assert run_replication(SimConfig(), "v2_all", days=8)["false_clear_pct"] <= 1.0


# ---------------------------------------------------------------- parameters drive the outcomes
def test_token_coverage_changes_downstream_outcomes():
    low = run_replication(SimConfig(token_coverage_pct=40), "v2_all", days=4)
    high = run_replication(SimConfig(token_coverage_pct=95), "v2_all", days=4)
    assert high["first_station_lane_pct"] < low["first_station_lane_pct"]
    assert high["first_station_static_pct"] < low["first_station_static_pct"]


def test_l1_accuracy_flows_into_l2_stops():
    good = scale_errors(L1Params(road_roughness="A"))
    bad = scale_errors(L1Params(road_roughness="C", calibration="overdue"))
    assert bad["road_error_pct"] > good["road_error_pct"]
    a = run_replication(SimConfig(**{**good, "token_coverage_pct": 30}), "v2_all", days=3)
    b = run_replication(SimConfig(**{**bad, "token_coverage_pct": 30}), "v2_all", days=3)
    assert b["first_station_lane_pct"] > a["first_station_lane_pct"]


def test_static_service_time_changes_queues():
    fast = run_replication(SimConfig(static_stop_min=4), "as_is", days=3)
    slow = run_replication(SimConfig(static_stop_min=12), "as_is", days=3)
    assert slow["max_static_queue"] > fast["max_static_queue"]
    assert slow["avg_delay_min"] > fast["avg_delay_min"]


# ---------------------------------------------------------------- queues
def test_fcfs_single_server_by_hand():
    start = fcfs(np.array([0.0, 1.0, 2.0]), 3.0, 1)
    assert start.tolist() == [0.0, 3.0, 6.0]


def test_fcfs_two_servers_by_hand():
    start = fcfs(np.array([0.0, 0.0, 0.0]), 3.0, 2)
    assert sorted(start.tolist()) == [0.0, 0.0, 3.0]


def erlang_c_wait(lam: float, mu: float, c: int) -> float:
    a = lam / mu
    rho = a / c
    s = sum(a**k / math.factorial(k) for k in range(c))
    top = a**c / (math.factorial(c) * (1 - rho))
    p_wait = top / (s + top)
    return p_wait / (c * mu - lam)


@pytest.mark.parametrize("c,rho", [(1, 0.7), (2, 0.8), (8, 0.85)])
def test_queue_kernel_matches_erlang_c(c, rho):
    """RCS v2 s10.5: compare with the Erlang C formula."""
    rng = np.random.default_rng(5)
    mu = 1.0 / 4.0
    lam = rho * c * mu
    n = 200000
    arrivals = np.cumsum(rng.exponential(1 / lam, n))
    service = rng.exponential(1 / mu, n)
    wait = fcfs(arrivals, service, c) - arrivals
    assert wait[5000:].mean() == pytest.approx(erlang_c_wait(lam, mu, c), rel=0.08)


@pytest.mark.parametrize("scenario", ["as_is", "v2_all"])
def test_simpy_and_fast_kernels_agree(scenario):
    cfg = SimConfig()
    a = run_replication(cfg, scenario, days=1, engine="fast")
    b = run_replication(cfg, scenario, days=1, engine="simpy")
    assert b["avg_delay_min"] == pytest.approx(a["avg_delay_min"], rel=0.01)
    assert b["static_visits"] == a["static_visits"] and b["lane_visits"] == a["lane_visits"]


# ---------------------------------------------------------------- conservation and reproducibility
@pytest.mark.parametrize("scenario", list(SCENARIOS))
def test_every_truck_leaves_exactly_once_simpy(scenario):
    r = run_replication(SimConfig(trucks_per_day=1500), scenario, days=1, engine="simpy")
    assert r["entered"] == r["exited"] == 1500


def test_reproducible_with_same_seed():
    a = run_replication(SimConfig(seed=9), "v2_all", days=2, rep=1)
    b = run_replication(SimConfig(seed=9), "v2_all", days=2, rep=1)
    assert a == b


def test_different_seed_differs():
    a = run_replication(SimConfig(seed=9), "v2_all", days=2)
    b = run_replication(SimConfig(seed=10), "v2_all", days=2)
    assert a["avg_delay_min"] != b["avg_delay_min"]


def test_common_random_numbers_pair_the_comparison():
    """Paired differences must have a narrower CI than the same difference taken across independent seeds."""
    paired, unpaired = [], []
    for rep in range(6):
        cfg = SimConfig(trucks_per_day=3000)
        base = run_replication(cfg, "as_is", days=2, rep=rep)["delay_hours_per_day"]
        paired.append(base - run_replication(cfg, "rcs_v1", days=2, rep=rep)["delay_hours_per_day"])
        unpaired.append(base - run_replication(cfg, "rcs_v1", days=2, rep=rep + 100)["delay_hours_per_day"])
    assert np.std(paired) < np.std(unpaired)


def test_warmup_excludes_early_trucks():
    r = run_replication(SimConfig(trucks_per_day=1000), "v2_all", days=2, warmup_days=1)
    assert r["entered"] == 3000 and abs(r["trucks"] - 2000) < 60


def test_arrival_profile_meets_peak_factor():
    w = arrival_profile(SimConfig(peak_factor=1.5))
    assert w.sum() == pytest.approx(1.0)
    assert w.max() / w.mean() == pytest.approx(1.5, rel=0.02)


def test_lane_capacity_from_documented_geometry():
    cfg = SimConfig()
    assert cfg.lane_service_s() == pytest.approx(9.7, abs=0.1)
    assert cfg.lane_capacity_per_h() == pytest.approx(370, abs=5)


def test_token_coverage_definition():
    assert SimConfig(token_coverage_pct=90, port_share_pct=65, origin_share_pct=25, untokened_share_pct=10).enrolment()[0] == pytest.approx(1.0)
    p, s = SimConfig(token_coverage_pct=45, port_share_pct=65, origin_share_pct=25, untokened_share_pct=10).enrolment()
    assert p == pytest.approx(0.5) and s == 0.0
    assert SimConfig(token_coverage_pct=95).enrolment()[1] == pytest.approx(0.5)


# ---------------------------------------------------------------- differential: vector kernel against the decision engine
def test_vector_thresholds_match_decision_engine():
    p = Policy()
    limit = 50000
    rng = np.random.default_rng(1)
    ids = D.IdentityReads("A", "T", "Z", "A", "T", "Z", "1-2-3")
    for ratio in rng.uniform(0.7, 1.1, 300):
        g = ratio * limit
        ax = [g * 8 / 50] + [g * 9 / 50] * 2 + [g * 8 / 50] * 3
        m = D.Measurement(gross_kg=g, axle_loads_kg=ax, height_m=4, width_m=2.5, length_m=17, axles_detected=6, quality=0.95)
        road_green = D.decide_road(m, ids, p, "1-2-3", None).outcome == D.Outcome.GREEN
        assert road_green == (ratio + 0.05 <= 1.0)
        lane_green = D.decide_lane(m, ids, p, "1-2-3", None).outcome == D.Outcome.GREEN
        assert lane_green == (ratio + 0.02 <= 1.0)
        port_green = D.decide_port(m, ids, p, "1-2-3", True, g).outcome == D.Outcome.GREEN
        assert port_green == (ratio + 0.02 <= 1.0)


# ---------------------------------------------------------------- L1
def test_l1_baseline_near_documented_targets():
    e = scale_errors(L1Params())
    assert e["road_error_pct"] == pytest.approx(2.5, abs=0.6)
    assert e["port_error_pct"] == pytest.approx(1.0, abs=0.35)
    assert e["lane_error_pct"] == pytest.approx(1.0, abs=0.35)


def test_l1_effects_have_the_right_sign():
    base = run_l1(L1Params())["total_error_pct"]
    assert run_l1(L1Params(road_roughness="C"))["total_error_pct"] > base
    assert run_l1(L1Params(calibration="overdue"))["total_error_pct"] > base
    assert run_l1(L1Params(sensor_rows=1))["total_error_pct"] > base
    assert run_l1(L1Params(speed_kmh=30))["total_error_pct"] < run_l1(L1Params(speed_kmh=100))["total_error_pct"]


def test_edge_pipeline_recovers_axles_and_weight():
    axles = [7000, 7500, 7500, 6700, 6700, 6600]
    out = edge_pipeline(synth_signal(sum(axles), axles, 80.0), 6, 30.0)
    assert out["axles_detected"] == 6
    assert out["gross_estimate_kg"] == pytest.approx(sum(axles), rel=0.03)
    assert len(out["stages"]) == 10


def test_edge_pipeline_flags_missing_axle_as_low_quality():
    axles = [7000, 7500, 7500, 10000, 10000]
    out = edge_pipeline(synth_signal(sum(axles), axles, 80.0), 6, 30.0)
    assert out["axles_detected"] == 5 and out["quality"] < 0.6 and out["decision_preview"] == "AMBER"


# ---------------------------------------------------------------- L3, L4, Monte Carlo, links
def _demand(main=20.0, lane=1.0, static=0.3):
    return {"mainline": [main] * 288, "lane": [lane] * 288, "static": [static] * 288}


def test_l3_free_flow_light_demand():
    r = run_l3(L3Params(), _demand())
    assert r["spillback_minutes"] == 0 and r["avg_speed_kmh"] > 70


def test_l3_static_overload_spills_back():
    r = run_l3(L3Params(), _demand(main=40, static=30))
    assert r["spillback_minutes"] > 60 and r["max_entry_queue_veh"] > 10


def test_l3_vehicle_balance():
    r = run_l3(L3Params(), _demand())
    assert abs(r["demand_veh"] - r["served_veh"]) <= 0.02 * r["demand_veh"] + 10


def test_l3_more_service_capacity_less_queue():
    tight = run_l3(L3Params(static_lanes=2), _demand(main=40, static=12))
    wide = run_l3(L3Params(static_lanes=12), _demand(main=40, static=12))
    assert wide["max_static_queue_veh"] < tight["max_static_queue_veh"]


def test_l4_no_data_loss_through_outages():
    r = run_l4(L4Params(hours=6, outage_per_day=6, outage_duration_min=20, device_failures_per_day=0), {"a": 2000, "b": 2000})
    assert r["outages"] and r["events_lost"] == 0 and r["data_integrity_pct"] == pytest.approx(100.0)
    assert r["peak_queue_depth"] > 0 and r["cloud_link_availability_pct"] < 100


def test_l4_duplicates_are_removed():
    assert run_l4(L4Params(hours=3, outage_per_day=0, device_failures_per_day=0), {"a": 8000})["duplicates_removed"] >= 0


def test_l4_measures_real_crypto():
    r = run_l4(L4Params(hours=1, outage_per_day=0, device_failures_per_day=0), {"a": 500})
    assert r["crypto_measured_here"]["verified"] and r["crypto_measured_here"]["sign_ms"] > 0


def test_ci95_formula():
    r = ci95([1.0, 2.0, 3.0])
    assert r["mean"] == 2.0 and r["half_width"] == pytest.approx(2.484, abs=0.01)


def test_monte_carlo_structure_and_ordering():
    r = run_monte_carlo(SimConfig(trucks_per_day=1500), ["as_is", "v2_all"], replications=3, days=2, warmup_days=1)
    assert r["conservation_ok"] and r["design"]["common_random_numbers"]
    assert r["scenarios"]["as_is"]["metrics"]["truck_hours_saved_per_day"]["mean"] == 0
    assert r["scenarios"]["v2_all"]["metrics"]["road_stops_per_1000"]["mean"] < r["scenarios"]["as_is"]["metrics"]["road_stops_per_1000"]["mean"]


def test_tornado_ranks_factors():
    r = run_tornado(SimConfig(trucks_per_day=1000), days=1, reps=1)
    rows = r["tables"]["road_stops_per_1000"]
    assert rows[0]["swing"] >= rows[-1]["swing"] and len(rows) == 10


def test_linked_run_passes_values_through_levels():
    r = run_linked(SimConfig(trucks_per_day=1500), L1Params(calibration="aged"), days=1, l4=L4Params(hours=2, outage_per_day=0, device_failures_per_day=0))
    assert r["config_used"]["road_error_pct"] == r["scale_errors"]["road_error_pct"]
    assert "L1" in r["trace"][0] and r["l4"]["events_generated"] > 0 and len(r["l3"]) == 2
