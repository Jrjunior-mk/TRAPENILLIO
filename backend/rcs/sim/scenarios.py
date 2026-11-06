"""The eight watchable demonstration scenarios. Each spawns one 'hero' truck with exact readings, so the real engine
reaches the expected outcome every time. Nothing in the outcome is scripted: tests/test_scenarios.py runs them all."""
from __future__ import annotations

from .live import LiveEngine


def _s1(e: LiveEngine):
    return e.spawn_hero(stream="port", enrolled=True, route="port_nairobi", ratio=0.80)


def _s2(e: LiveEngine):
    return e.spawn_hero(stream="port", enrolled=True, route="port_nairobi", ratio=1.10)


def _s3(e: LiveEngine):
    return e.spawn_hero(stream="origin", enrolled=True, route="quarry_nairobi", ratio=0.82)


def _s4(e: LiveEngine):
    # 97% of the limit: inside the 5% road margin (so it diverts), outside the 2% lane margin (so the lane can clear it).
    return e.spawn_hero(stream="untokened", enrolled=False, route="spot_kwale", ratio=0.97)


def _s5(e: LiveEngine):
    # Cargo is added after the token is issued, so the road weight no longer matches.
    return e.spawn_hero(stream="port", enrolled=True, route="port_nairobi", ratio=0.78, add_load_after_token=0.15)


def _s6(e: LiveEngine):
    return e.spawn_hero(stream="untokened", enrolled=False, route="spot_kaloleni", ratio=0.85, lifted=True)


def _s7(e: LiveEngine):
    t = e.spawn_hero(stream="port", enrolled=True, route="port_nairobi", ratio=0.80)
    state = {"phase": 0}

    def hook():
        # Outage begins after the truck's token exists and before it reaches Mariakani, and lifts after it has passed.
        if state["phase"] == 0 and t.token_id and t.plan_i >= 4:
            e.set_link("mariakani", False)
            e._scenario_log("Mariakani loses its cloud link. The edge unit switches to offline mode.", "AMBER")
            state["phase"] = 1
        elif state["phase"] == 1 and t.plan_i >= len(t.plan) - 0 and t.first_station_done and any(h["site"].startswith("Mariakani") for h in t.history):
            e.set_link("mariakani", True)
            e._scenario_log("Link restored. Queued records synchronize to the registry.", "GREEN")
            state["phase"] = 2

    e.scenario_hook = hook
    return t


def _s8(e: LiveEngine):
    return e.spawn_hero(stream="port", enrolled=True, route="port_nairobi", ratio=0.80, force_audit={"mariakani"})


SCENARIO_DEFS = {
    "s1_compliant_port": {"title": "Compliant port truck", "summary": "A container truck is weighed at gate-out, receives a signed token and passes Mariakani without stopping.", "start": _s1, "expect": {"port_node": "GREEN", "dongo_kundu": "GREEN", "mariakani": "GREEN"}},
    "s2_overloaded_port": {"title": "Overloaded port truck", "summary": "A truck exceeds the threshold at gate-out, goes to the port re-weigh lane and takes corrective action.", "start": _s2, "expect": {"port_node": "RED"}},
    "s3_origin": {"title": "Industrial origin truck", "summary": "A quarry truck receives an origin token from an approved scale and clears the road stations.", "start": _s3, "expect": {"origin_quarry": "GREEN", "mtwapa": "GREEN", "mariakani": "GREEN"}},
    "s4_untokened": {"title": "Untokened truck", "summary": "A truck with no token is assessed at the first road station and diverted to the Rolling Verification Lane.", "start": _s4, "expect": {"dongo_kundu": "AMBER"}},
    "s5_token_mismatch": {"title": "Token mismatch", "summary": "A valid token, but the road weight differs beyond tolerance. The truck gets amber and is diverted.", "start": _s5, "expect": {"port_node": "GREEN", "dongo_kundu": "AMBER"}},
    "s6_lifted_axle": {"title": "Lifted axle", "summary": "The axle count differs from the registered configuration. The system detects it and triggers verification.", "start": _s6, "expect": {"mariakani": "AMBER"}},
    "s7_network_failure": {"title": "Network failure", "summary": "Mariakani loses its cloud link and keeps clearing from cached tokens. Records synchronize when the link returns.", "start": _s7, "expect": {"mariakani": "GREEN"}},
    "s8_random_audit": {"title": "Random audit", "summary": "A compliant truck is selected for audit. The lane result feeds the calibration and trust process.", "start": _s8, "expect": {"mariakani": "AMBER"}},
}
