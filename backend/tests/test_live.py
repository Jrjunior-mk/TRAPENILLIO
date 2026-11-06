"""The live engine: truck conservation, network failover, fail-safe faults, revocation, audits, all eight scenarios."""
import pytest

from rcs.services.adapters import adapters
from rcs.sim.live import LiveEngine, seed_registry_signers
from rcs.sim.params import SimConfig
from rcs.sim.scenarios import SCENARIO_DEFS

QUIET = dict(trucks_per_day=300, outage_per_day=0, dimension_violation_pct=0, lifted_axle_pct=0, token_fraud_pct=0, misdeclaration_pct=0, overload_pct=0, audit_pct=0)


def make(seed=1, **kw) -> LiveEngine:
    e = LiveEngine(persist=False, seed=seed, cfg=SimConfig(**{**QUIET, **kw}))
    seed_registry_signers(e.registry)
    return e


def run_until(e: LiveEngine, cond, max_steps=4000, dt=5.0):
    for _ in range(max_steps):
        if cond():
            return True
        e.step(dt)
    return cond()


def outcomes(t):
    return [(h["site"], h["stage"], h["outcome"]) for h in t.history]


def run_hero(e: LiveEngine, **kw):
    t = e.spawn_hero(**kw)
    assert run_until(e, lambda: t.id not in e.trucks), f"{t.id} did not finish: {t.history}"
    return t


def test_truck_conservation_over_time():
    e = make(trucks_per_day=8000, outage_per_day=2, overload_pct=2, audit_pct=3, lifted_axle_pct=0.5, dimension_violation_pct=0.5)
    for _ in range(40):
        e.step(300)
        c = e.kpi()["conservation"]
        assert c["balanced"], c
    assert c["entered"] > 500 and c["exited"] > 400


def test_truck_positions_change_between_frames():
    e = make(trucks_per_day=2000)
    e.step(600)
    a = {r[0]: (r[1], r[2]) for r in e.frame()["trucks"]}
    e.step(10)
    b = {r[0]: (r[1], r[2]) for r in e.frame()["trucks"]}
    assert any(a[k] != b[k] for k in a if k in b)


def test_same_seed_is_reproducible():
    def run():
        e = make(seed=7, trucks_per_day=3000, audit_pct=3, overload_pct=2)
        e.step(1800)
        k = e.kpi()
        return k["entered"], k["green"], k["amber"], k["red"], k["lane"]

    assert run() == run()


def test_port_token_honoured_downstream_without_stop():
    t = run_hero(make(), stream="port", enrolled=True, route="port_nairobi", ratio=0.8)
    assert [o[2] for o in outcomes(t)] == ["GREEN", "GREEN", "GREEN"]
    assert not t.was_diverted and t.delay_s == 0


def test_near_limit_truck_token_means_no_road_stop():
    """A truck the port re-weighed at 99% clears the road, where the absolute rule would have stopped it twice."""
    e = make()
    t = run_hero(e, stream="port", enrolled=True, route="port_nairobi", ratio=0.99)
    stages = outcomes(t)
    assert stages[0][1] == "PORT" and stages[0][2] == "AMBER"
    assert all(o[2] == "GREEN" for o in stages[1:])
    assert t.shadow_delay_s > 0  # the as-is counterfactual would have stopped it


def test_untokened_clear_truck_gets_road_token_and_it_is_honoured():
    e = make()
    t = run_hero(e, stream="untokened", enrolled=False, route="spot_kwale", ratio=0.8)
    assert [o[2] for o in outcomes(t)] == ["GREEN", "GREEN"]


def test_overloaded_untokened_reaches_static_and_officer():
    e = make()
    t = e.spawn_hero(stream="untokened", enrolled=False, route="spot_kaloleni", ratio=1.08)
    assert run_until(e, lambda: t.id not in e.trucks)
    seq = [o[1:] for o in outcomes(t)]
    assert seq[:3] == [("ROAD", "AMBER"), ("LANE", "RED"), ("STATIC", "RED")]
    assert t.had_static and e.kpi()["confirmed_overload"] == 1


def test_officer_decision_releases_held_truck():
    e = make()
    t = e.spawn_hero(stream="untokened", enrolled=False, route="spot_kaloleni", ratio=1.08)
    assert run_until(e, lambda: t.hold_case is not None)
    case = t.hold_case
    assert e.decide_case(case, True, "Officer Test")
    assert t.hold_case is None and t.state == "GREEN" and t.token_id


# ---------------------------------------------------------------- fail-safe
@pytest.mark.parametrize("sensor", ["wim", "adc", "loops", "lidar", "anpr", "rfid"])
def test_disabling_a_sensor_never_gives_green_at_that_station(sensor):
    e = make()
    e.set_sensor("mariakani", sensor, "disabled")
    t = run_hero(e, stream="untokened", enrolled=False, route="spot_kaloleni", ratio=0.75)
    road = [o for o in outcomes(t) if o[1] == "ROAD"][0]
    assert road[2] == "AMBER"


def test_edge_failure_defaults_to_amber_and_static_process():
    e = make()
    e.set_sensor("mariakani", "edge", "fault")
    t = run_hero(e, stream="port", enrolled=True, route="port_nairobi", ratio=0.8)
    mk = [h for h in t.history if h["site"].startswith("Mariakani")]
    assert mk[0]["outcome"] == "AMBER" and mk[0]["action"] == "STATIC_SCALE"
    assert e.frame()["gantries"]["mariakani"] == "AMBER"


def test_lane_scale_failure_is_inconclusive_and_goes_static():
    e = make()
    e.set_sensor("mariakani", "lane_scale", "fault")
    t = run_hero(e, stream="untokened", enrolled=False, route="spot_kaloleni", ratio=0.97)
    lane = [h for h in t.history if h["stage"] == "LANE"][0]
    assert lane["outcome"] == "RED" and lane["action"] == "STATIC_SCALE"


def test_port_scale_failure_fails_safe_to_reweigh():
    e = make()
    e.set_sensor("port_node", "port_scale", "fault")
    t = run_hero(e, stream="port", enrolled=True, route="port_nairobi", ratio=0.8)
    assert t.history[0]["outcome"] == "AMBER" and t.history[0]["action"] == "PORT_REWEIGH"


def test_mock_customs_outage_blocks_green_at_port():
    e = make()
    adapters.kra_down = True
    try:
        t = run_hero(e, stream="port", enrolled=True, route="port_nairobi", ratio=0.8)
    finally:
        adapters.kra_down = False
    assert t.history[0]["outcome"] == "AMBER" and "Release status" in t.history[0]["explanation"]


# ---------------------------------------------------------------- network failover
def test_offline_station_clears_from_cached_token_and_syncs_later():
    e = make()
    t = e.spawn_hero(stream="port", enrolled=True, route="port_nairobi", ratio=0.8)
    assert run_until(e, lambda: t.token_id is not None)
    e.step(30)
    e.set_link("mariakani", False)
    assert run_until(e, lambda: any(h["site"].startswith("Mariakani") for h in t.history))
    mk = [h for h in t.history if h["site"].startswith("Mariakani")][0]
    assert mk["outcome"] == "GREEN" and mk["offline"]
    assert len(e.plazas["mariakani"].outbox) >= 1
    delivered_before = e.mq_delivered
    e.set_link("mariakani", True)
    assert run_until(e, lambda: not e.plazas["mariakani"].outbox and not e.plazas["mariakani"].syncing)
    assert e.mq_delivered > delivered_before
    assert e.plazas["mariakani"].last_recovery_s is not None


def test_token_issued_after_outage_is_not_in_the_cache():
    e = make()
    e.set_link("mariakani", False)
    t = run_hero(e, stream="port", enrolled=True, route="port_nairobi", ratio=0.8)
    mk = [h for h in t.history if h["site"].startswith("Mariakani")][0]
    # No token visible: falls back to the absolute rule, clear of the margin, so a local road token is issued.
    assert mk["outcome"] == "GREEN" and mk["offline"] and any(c["detail"] in ("Registry lookup failed",) for c in mk["checks"] if c["code"] == "token")


def test_offline_near_limit_truck_with_uncached_token_is_diverted():
    e = make()
    e.set_link("mariakani", False)
    t = run_hero(e, stream="port", enrolled=True, route="port_nairobi", ratio=0.97)
    mk = [h for h in t.history if h["site"].startswith("Mariakani")][0]
    assert mk["outcome"] == "AMBER"


def test_revocation_affects_next_verification_online():
    e = make()
    t = e.spawn_hero(stream="port", enrolled=True, route="port_nairobi", ratio=0.8)
    assert run_until(e, lambda: t.token_id is not None)
    e.registry.set_status(t.token_id, "REVOKED", "test", e.now, actor="test")
    assert run_until(e, lambda: t.id not in e.trucks)
    dk = [h for h in t.history if h["site"].startswith("Dongo")][0]
    assert dk["outcome"] == "AMBER" and "revoked" in dk["explanation"]


def test_revocation_during_outage_is_not_seen_until_sync():
    """Offline, the station can only trust its cache. This is a known, audited risk of edge operation."""
    e = make()
    t = e.spawn_hero(stream="port", enrolled=True, route="port_nairobi", ratio=0.8)
    assert run_until(e, lambda: t.token_id is not None)
    e.step(5)
    e.set_link("dongo_kundu", False)
    e.step(1)
    e.registry.set_status(t.token_id, "REVOKED", "test", e.now, actor="test")
    assert run_until(e, lambda: any(h["site"].startswith("Dongo") for h in t.history))
    dk = [h for h in t.history if h["site"].startswith("Dongo")][0]
    assert dk["outcome"] == "GREEN" and dk["offline"]


def test_registry_down_puts_every_site_offline():
    e = make()
    e.registry_down = True
    for p in e.plazas.values():
        assert not e._online(p)


# ---------------------------------------------------------------- audit and allowed configs
def test_random_audit_rate_follows_config():
    e = make(trucks_per_day=8000, audit_pct=10)
    e.step(4 * 3600)
    k = e.kpi()
    road = sum(s["processed"] for s in k["stations"] if s["kind"] == "road")
    assert 0.05 < k["audits"] / max(road, 1) < 0.15


def test_zero_audit_means_no_random_audits():
    e = make(trucks_per_day=4000, audit_pct=0)
    e.step(2 * 3600)
    assert e.kpi()["audits"] == 0


def test_token_coverage_setting_changes_live_outcomes():
    def lane_share(coverage):
        e = make(seed=3, trucks_per_day=8000, token_coverage_pct=coverage, overload_pct=1.5, audit_pct=3)
        e.step(5 * 3600)
        k = e.kpi()
        return k["lane"] / max(k["trucks_processed"], 1), k["token_coverage_pct"]

    low, cov_low = lane_share(30)
    high, cov_high = lane_share(90)
    assert low > high and cov_low < cov_high


# ---------------------------------------------------------------- scenarios
@pytest.mark.parametrize("sid", list(SCENARIO_DEFS))
def test_scenario_reaches_expected_outcomes(sid):
    e = make(seed=2, trucks_per_day=500)
    view = e.start_scenario(sid)
    tid = view["truck"]
    hero = e.trucks[tid]
    assert run_until(e, lambda: e.scenario["status"] == "complete", max_steps=4000, dt=5.0), hero.history
    first = {}
    for h in hero.history:
        first.setdefault(h["site"], h["outcome"])
    for site, want in SCENARIO_DEFS[sid]["expect"].items():
        assert first[e.plazas[site].name] == want, (site, hero.history)
    assert e.kpi()["conservation"]["balanced"]
    assert e.scenario["log"]


def test_network_scenario_goes_offline_then_syncs():
    e = make(seed=2, trucks_per_day=500)
    view = e.start_scenario("s7_network_failure")
    hero = e.trucks[view["truck"]]
    assert run_until(e, lambda: e.scenario["status"] == "complete")
    mk = [h for h in hero.history if h["site"].startswith("Mariakani")][0]
    assert mk["offline"] and mk["outcome"] == "GREEN"
    assert e.plazas["mariakani"].link_up
