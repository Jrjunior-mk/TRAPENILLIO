"""L2 process model: the whole clearance chain for three truck streams and six policy scenarios.

Two steps, so Monte Carlo stays affordable without giving up a discrete-event model:

1. A vectorised decision chain gives each truck its visits (port re-weigh, lane, static). It applies the same
   thresholds as rcs.domain.decision; tests/test_l2.py checks the two against each other on random trucks.
2. A queueing stage runs those visits through FCFS resources. engine="simpy" uses a SimPy discrete-event model;
   engine="fast" uses an equivalent heap kernel for Monte Carlo. Tests prove both return the same waits.

Common random numbers: every random draw is made up front per truck, from a stream keyed by (seed, replication,
attribute), whatever the scenario. Differences between scenarios are therefore paired.

Everything produced here is MODELLED. All inputs except the 8,000 trucks/day are assumptions from the source documents.
"""
from __future__ import annotations

import heapq
from dataclasses import dataclass

import numpy as np
import simpy

from .params import SimConfig

STATIONS = ("dongo_kundu", "mtwapa", "mariakani")  # topological order: later stations never feed earlier ones
TRAVEL_MIN = {"dongo_kundu": 30.0, "mtwapa": 25.0, "mariakani": 35.0}
CORRECTIVE_LOAD = 0.97  # after offloading, trucks sit just under the limit
OVERLOAD_MAX_FRAC = 0.15
CAP = 0.995  # loads that would exceed the limit are capped just below it (RCS v2 s9)


@dataclass(frozen=True)
class Scenario:
    key: str
    label: str
    tokens: tuple[str, ...]  # streams receiving first-point tokens
    road_tokens: bool
    lane: bool
    audit: bool
    honour_static: bool  # a static result from an earlier station is honoured downstream
    lidar: bool
    lift_check: bool
    coverage_boost_pct: float = 0.0
    allowance_pct: float | None = None
    lane_legal: bool | None = None
    port_legal: bool | None = None
    note: str = ""


SCENARIOS: dict[str, Scenario] = {
    s.key: s
    for s in [
        Scenario("as_is", "Existing road-only process", (), False, False, False, False, False, False,
                 note="WIM suspects go to static at every station; paper certificates are not honoured by the WIM screen."),
        Scenario("rcs_v1", "Original RCS proposal", (), False, False, True, True, False, True,
                 note="Positive clearance with margin and audits at each station; a static result is shared downstream."),
        Scenario("v2_port", "Port-anchored RCS v2", ("port",), False, False, True, True, True, True,
                 note="Tokens for port trucks; other traffic stays on the absolute road rule and static scales."),
        Scenario("v2_all", "RCS v2, all three streams", ("port", "origin", "spot"), True, True, True, True, True, True,
                 note="Port, origin and road tokens with one Rolling Verification Lane per station."),
        Scenario("v2_high_coverage", "RCS v2, increased coverage", ("port", "origin", "spot"), True, True, True, True, True, True,
                 coverage_boost_pct=8.0, note="Same design with token coverage raised by 8 points, capped at 100%."),
        Scenario("v2_approved", "RCS v2, lane approved + allowance", ("port", "origin", "spot"), True, True, True, True, True, True,
                 allowance_pct=5.0, lane_legal=True, port_legal=False,
                 note="Lane scales approved as legal-grade and the 5% discretion allowance applied. Both are policy assumptions."),
    ]
}

_STREAM_NAMES = (
    "stream", "enrol", "load", "over", "load_jit", "route", "eps_port", "eps_port2", "eps_origin", "eps_r0", "eps_r1",
    "eps_l0", "eps_l1", "eps_s0", "eps_s1", "audit0", "audit1", "dim", "lift", "fraud", "fraud_gain", "misdecl", "arr",
    "sealed", "outage", "corr_eps",
)


def _rng(seed: int, rep: int, name: str) -> np.random.Generator:
    return np.random.default_rng(np.random.SeedSequence([seed, rep, _STREAM_NAMES.index(name)]))


def arrival_profile(cfg: SimConfig) -> np.ndarray:
    """Hourly arrival weights, with peak/mean equal to the peak factor. The shape is an assumption."""
    hours = np.arange(24)
    if cfg.arrival_distribution == "uniform":
        return np.ones(24) / 24.0
    shape = np.exp(-0.5 * ((hours - 8.5) / 2.5) ** 2) + 0.9 * np.exp(-0.5 * ((hours - 16.5) / 3.0) ** 2)
    shape = (shape - shape.min()) / (shape.max() - shape.min())
    amp = cfg.peak_factor - 1.0
    # mean(w) = 1 and max(w) = peak_factor: floor f so that f + amp_k*shape meets both
    k = amp / max(1e-9, 1.0 - shape.mean())
    w = 1.0 - k * shape.mean() + k * shape
    if w.min() < 0.1:  # very high peaks: keep a small night flow, renormalise
        w = np.clip(w, 0.1, None)
        w = w / w.mean()
    return w / 24.0


def sample_loads(u_load: np.ndarray, over_u: np.ndarray, jit: np.ndarray, cfg: SimConfig) -> np.ndarray:
    """Load as a fraction of the limit. Overloaded share is explicit; everything else is capped just below the limit."""
    mean, spread = cfg.avg_loading_pct / 100.0, cfg.load_spread_pct / 100.0
    load = np.clip(mean + spread * u_load, 0.25, CAP)
    is_over = over_u < cfg.overload_pct / 100.0
    load = np.where(is_over, 1.0 + jit * OVERLOAD_MAX_FRAC, load)
    return load


def _draw_population(cfg: SimConfig, n_days: int, seed: int, rep: int) -> dict:
    n = int(round(cfg.trucks_per_day * n_days))
    r = lambda name: _rng(seed, rep, name)  # noqa: E731
    d: dict = {"n": n}
    p, o, _u = cfg.shares()
    su = r("stream").random(n)
    d["stream"] = np.where(su < p, 0, np.where(su < p + o, 1, 2))  # 0 port, 1 origin, 2 spot
    d["enrol_u"] = r("enrol").random(n)
    d["load_z"] = r("load").standard_normal(n)
    d["over_u"] = r("over").random(n)
    d["jit"] = r("load_jit").random(n)
    d["route_u"] = r("route").random(n)
    for name in ("eps_port", "eps_port2", "eps_origin", "eps_r0", "eps_r1", "eps_l0", "eps_l1", "eps_s0", "eps_s1", "corr_eps"):
        d[name] = r(name).standard_normal(n)
    for name in ("audit0", "audit1", "dim", "lift", "fraud", "misdecl", "sealed"):
        d[name] = r(name).random(n)
    d["fraud_gain"] = r("fraud_gain").uniform(0.05, 0.2, n)
    # Arrival times: a day index plus an hour drawn from the profile, then jitter within the hour
    rng = r("arr")
    days = np.floor(np.arange(n) / cfg.trucks_per_day).astype(np.int64)
    w = arrival_profile(cfg)
    hour = rng.choice(24, size=n, p=w / w.sum())
    minute = rng.random(n) * 60.0
    t = days * 1440.0 + hour * 60.0 + minute
    if cfg.arrival_distribution == "vessel_bursts":
        # Port trucks bunch into six-hour discharge bursts every two days, spread by a 3 h normal.
        burst_u = rng.standard_normal(n) * 180.0
        burst_day = (days // 2) * 2 * 1440.0 + 12 * 60.0
        t = np.where(d["stream"] == 0, np.maximum(0.0, burst_day + burst_u), t)
    d["t0"] = t
    # Outage windows per station
    o_rng = r("outage")
    windows = {}
    for s in STATIONS:
        k = o_rng.poisson(cfg.outage_per_day * n_days)
        starts = np.sort(o_rng.random(k) * n_days * 1440.0)
        windows[s] = (starts, starts + cfg.outage_duration_min)
    d["outages"] = windows
    return d


def _routes(route_u: np.ndarray, stream: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Station index for slot 0 and slot 1 (-1 = none). Route shares are schematic assumptions."""
    n = len(stream)
    st0 = np.full(n, 2, dtype=np.int8)
    st1 = np.full(n, -1, dtype=np.int8)
    port = stream == 0
    st0[port & (route_u < 0.85)] = 0
    st1[port & (route_u < 0.85)] = 2
    st0[port & (route_u >= 0.85)] = 1
    origin = stream == 1
    st0[origin & (route_u < 0.4)] = 1
    st1[origin & (route_u < 0.4)] = 2
    st0[origin & (route_u >= 0.4) & (route_u < 0.6)] = 0
    st1[origin & (route_u >= 0.4) & (route_u < 0.6)] = 2
    spot = stream == 2
    st0[spot & (route_u < 0.35)] = 0
    st1[spot & (route_u < 0.35)] = 2
    st0[spot & (route_u >= 0.35) & (route_u < 0.55)] = 1
    st1[spot & (route_u >= 0.35) & (route_u < 0.55)] = 2
    return st0, st1


def fcfs(arrivals: np.ndarray, service: np.ndarray | float, servers: int) -> np.ndarray:
    """Multi-server FCFS. Returns start-of-service times, in the order of `arrivals`."""
    n = len(arrivals)
    start = np.empty(n)
    if n == 0:
        return start
    order = np.argsort(arrivals, kind="stable")
    svc = np.broadcast_to(np.asarray(service, dtype=float), (n,))
    free = [0.0] * servers
    heapq.heapify(free)
    arr = arrivals[order].tolist()
    svc_o = svc[order].tolist()
    starts = [0.0] * n
    pop, push = heapq.heappop, heapq.heappush
    for i, a in enumerate(arr):
        earliest = pop(free)
        s = a if a > earliest else earliest
        starts[i] = s
        push(free, s + svc_o[i])
    start[order] = starts
    return start


def _queue_stats(arrive: np.ndarray, start: np.ndarray, service: np.ndarray | float, servers: int, t_span_min: float) -> dict:
    if len(arrive) == 0:
        return {"visits": 0, "mean_wait_min": 0.0, "p95_wait_min": 0.0, "max_queue": 0, "mean_queue": 0.0, "utilization": 0.0}
    wait = start - arrive
    svc = np.broadcast_to(np.asarray(service, dtype=float), arrive.shape)
    events = np.concatenate([arrive, start])
    delta = np.concatenate([np.ones_like(arrive), -np.ones_like(start)])
    order = np.lexsort((-delta, events))
    q = np.cumsum(delta[order])
    return {
        "visits": int(len(arrive)),
        "mean_wait_min": float(wait.mean()),
        "p95_wait_min": float(np.percentile(wait, 95)),
        "max_queue": int(q.max()),
        "mean_queue": float(wait.sum() / max(t_span_min, 1.0)),
        "utilization": float(min(1.0, svc.sum() / (servers * max(t_span_min, 1.0)))),
    }


def decide_chain(cfg: SimConfig, scen: Scenario, pop: dict) -> dict:
    """Vectorised clearance chain. Returns per-truck visit flags, without any time spent in a queue yet."""
    n = pop["n"]
    allow = 1.0 + (scen.allowance_pct if scen.allowance_pct is not None else cfg.allowance_pct) / 100.0
    k = cfg.measurement_margin_k
    port_legal = cfg.port_legal_grade if scen.port_legal is None else scen.port_legal
    lane_legal = cfg.lane_legal_grade if scen.lane_legal is None else scen.lane_legal
    m_port = 0.0 if port_legal else k * cfg.port_error_pct / 100.0
    m_origin = k * cfg.origin_error_pct / 100.0
    m_road = k * cfg.road_error_pct / 100.0
    m_lane = 0.0 if lane_legal else k * cfg.lane_error_pct / 100.0
    tol_first = cfg.tolerance_first_point_pct / 100.0
    tol_road = cfg.tolerance_road_token_pct / 100.0
    audit_rate = (cfg.audit_pct / 100.0) if scen.audit else 0.0

    cfg_eff = cfg
    if scen.coverage_boost_pct:
        cfg_eff = cfg.model_copy(update={"token_coverage_pct": min(100.0, cfg.token_coverage_pct + scen.coverage_boost_pct)})
    p_anchor, p_spot = cfg_eff.enrolment()

    stream = pop["stream"]
    load = sample_loads(pop["load_z"], pop["over_u"], pop["jit"], cfg)
    dim_bad = pop["dim"] < cfg.dimension_violation_pct / 100.0
    lifted = pop["lift"] < cfg.lifted_axle_pct / 100.0
    misdeclared = pop["misdecl"] < cfg.misdeclaration_pct / 100.0
    fraud = pop["fraud"] < cfg.token_fraud_pct / 100.0
    st0, st1 = _routes(pop["route_u"], stream)
    sealed = pop["sealed"] < cfg.sealed_share_pct / 100.0

    enrolled = np.zeros(n, dtype=bool)
    if "port" in scen.tokens:
        enrolled |= (stream == 0) & (pop["enrol_u"] < p_anchor)
    if "origin" in scen.tokens:
        enrolled |= (stream == 1) & (pop["enrol_u"] < p_anchor)
    if "spot" in scen.tokens:
        enrolled |= (stream == 2) & (pop["enrol_u"] < p_spot)

    has_token = np.zeros(n, dtype=bool)
    token_w = np.zeros(n)
    token_road = np.zeros(n, dtype=bool)
    port_reweigh = np.zeros(n, dtype=bool)
    port_corrected = np.zeros(n, dtype=bool)
    origin_trim = np.zeros(n, dtype=bool)

    # A. Port gate-out
    idx = enrolled & (stream == 0)
    r = load * (1.0 + pop["eps_port"] * cfg.port_error_pct / 100.0)
    near = (r + m_port > allow) | (misdeclared & idx) | dim_bad
    green = idx & ~near
    has_token[green] = True
    token_w[green] = r[green]
    reweigh = idx & near
    port_reweigh = reweigh
    if reweigh.any():
        rs = load * (1.0 + pop["eps_port2"] * cfg.static_error_pct / 100.0)
        overs = reweigh & (rs > allow)
        port_corrected = overs
        load = np.where(overs, CORRECTIVE_LOAD, load)
        rs2 = load * (1.0 + pop["corr_eps"] * cfg.static_error_pct / 100.0)
        token_w[reweigh] = rs2[reweigh]
        has_token[reweigh] = True

    # B. Approved loading-site scale. Near-limit loads are trimmed on site and re-weighed, then tokened.
    idx = enrolled & (stream != 0)
    r = load * (1.0 + pop["eps_origin"] * cfg.origin_error_pct / 100.0)
    near = r + m_origin > allow
    green = idx & ~near
    has_token[green] = True
    token_w[green] = r[green]
    trim = idx & near
    origin_trim = trim
    if trim.any():
        load = np.where(trim, np.minimum(load, allow - m_origin - 0.01), load)
        token_w[trim] = (load * (1.0 + pop["corr_eps"] * cfg.origin_error_pct / 100.0))[trim]
        has_token[trim] = True

    first_tokened = has_token.copy()
    # Cargo added after the first weighing: not caught unless consistency or audit catches it
    load = np.where(fraud & has_token, load * (1.0 + pop["fraud_gain"]), load)

    lane_hit = {0: np.zeros(n, dtype=bool), 1: np.zeros(n, dtype=bool)}
    static_hit = {0: np.zeros(n, dtype=bool), 1: np.zeros(n, dtype=bool)}
    confirmed = {0: np.zeros(n, dtype=bool), 1: np.zeros(n, dtype=bool)}
    audit_hit = {0: np.zeros(n, dtype=bool), 1: np.zeros(n, dtype=bool)}
    static_passed = np.zeros(n, dtype=bool)
    # Outage visibility: during a network outage, tokens issued after it began are not in the site cache
    outage_hidden = {0: np.zeros(n, dtype=bool), 1: np.zeros(n, dtype=bool)}
    if scen.tokens:
        t0 = pop["t0"]
        for slot, st in ((0, st0), (1, st1)):
            for si, s in enumerate(STATIONS):
                starts, ends = pop["outages"][s]
                mask = st == si
                if len(starts) == 0 or not mask.any():
                    continue
                eta = t0[mask] + TRAVEL_MIN[s] * (1 + slot)
                pos = np.searchsorted(starts, eta, side="right") - 1
                inside = (pos >= 0) & (eta <= ends[np.maximum(pos, 0)])
                # A token issued more than a travel time before the outage started is cached; the rest are not.
                issued = t0[mask]
                began = starts[np.maximum(pos, 0)]
                out = np.zeros(mask.sum(), dtype=bool)
                out[inside] = issued[inside] >= began[inside]
                full = np.zeros(n, dtype=bool)
                full[np.where(mask)[0]] = out
                outage_hidden[slot] = outage_hidden[slot] | full

    for slot, st in ((0, st0), (1, st1)):
        at = st >= 0
        eps = pop[f"eps_r{slot}"]
        road = load * (1.0 + eps * cfg.road_error_pct / 100.0)
        visible = has_token & ~outage_hidden[slot]
        tol = np.where(token_road, tol_road, tol_first)
        ratio = np.divide(np.abs(road - token_w), token_w, out=np.zeros(n), where=token_w > 0)
        consistent = ratio <= tol
        absolute_ok = road + m_road <= allow

        if scen.road_tokens or scen.tokens:
            clean = np.where(visible, consistent, absolute_ok)
        else:
            clean = absolute_ok
        if scen.honour_static:
            clean = clean | static_passed
        # LiDAR and lift checks: dimension and axle mismatches divert
        flags = np.zeros(n, dtype=bool)
        if scen.lidar:
            flags |= dim_bad
        if scen.lift_check:
            flags |= lifted
        aud = at & clean & ~flags & (pop[f"audit{slot}"] < audit_rate)
        audit_hit[slot] = aud
        divert = at & (~clean | flags | aud)

        if scen.lane:
            lane_hit[slot] = divert
            rl = load * (1.0 + pop[f"eps_l{slot}"] * cfg.lane_error_pct / 100.0)
            over = rl - m_lane > allow
            token_ok = visible & (np.divide(np.abs(rl - token_w), token_w, out=np.zeros(n), where=token_w > 0) <= tol)
            band = (rl + m_lane > allow) & ~token_ok & ~static_passed
            red = divert & (over | band | flags)
            static_hit[slot] = red
            ok = divert & ~red
            has_token[ok] = True
            token_w[ok] = rl[ok]
            token_road[ok] = True
        else:
            red = divert
            static_hit[slot] = red

        # Static scale: legal reading. Overload is confirmed by an officer, the load corrected and the truck released.
        rs = load * (1.0 + pop[f"eps_s{slot}"] * cfg.static_error_pct / 100.0)
        conf = static_hit[slot] & (rs > allow)
        confirmed[slot] = conf
        load = np.where(conf, CORRECTIVE_LOAD, load)
        dim_bad = dim_bad & ~static_hit[slot]
        lifted = lifted & ~static_hit[slot]
        static_passed = static_passed | static_hit[slot]
        if scen.road_tokens:
            passed = static_hit[slot]
            has_token[passed] = True
            token_w[passed] = (load * (1.0 + pop[f"eps_s{slot}"] * cfg.static_error_pct / 100.0))[passed]
            token_road[passed] = True
            # Road token on a clean no-token pass
            issue = at & ~divert & ~has_token
            has_token[issue] = True
            token_w[issue] = road[issue]
            token_road[issue] = True

    return {
        "stream": stream, "st0": st0, "st1": st1, "load_final": load, "first_tokened": first_tokened,
        "port_reweigh": port_reweigh, "port_corrected": port_corrected, "origin_trim": origin_trim,
        "lane": lane_hit, "static": static_hit, "confirmed": confirmed, "audit": audit_hit,
        "sealed": sealed, "enrolled": enrolled, "dim_escaped": dim_bad, "lifted_escaped": lifted,
        "allow": allow, "has_token_end": has_token,
    }


def _resource_plan(cfg: SimConfig) -> dict:
    return {
        "lane_service_min": cfg.lane_service_s() / 60.0,
        "lane_servers": max(1, cfg.lanes_per_station),
        "static_service_min": cfg.static_service_min(),
        "static_servers": cfg.static_lanes,
        "reweigh_service_min": cfg.port_reweigh_min,
        "reweigh_servers": cfg.port_reweigh_lanes,
        "customs_service_min": cfg.customs_break_seal_min,
        "customs_servers": cfg.customs_officers,
    }


def _queue_fast(cfg: SimConfig, chain: dict, t0: np.ndarray) -> dict:
    """Feed-forward queueing with the heap kernel. Returns delay per truck and per-resource arrival and start arrays."""
    plan = _resource_plan(cfg)
    n = len(t0)
    t = t0.copy()
    delay = np.zeros(n)
    records: dict[str, tuple[np.ndarray, np.ndarray, int, float]] = {}

    def visit(key: str, idx: np.ndarray, service: float, servers: int, fixed_extra: float = 0.0) -> None:
        if not len(idx):
            records[key] = (np.empty(0), np.empty(0), servers, service)
            return
        arrive = t[idx]
        start = fcfs(arrive, service, servers)
        records[key] = (arrive, start, servers, service)
        dwell = start - arrive + service + fixed_extra
        delay[idx] += dwell
        t[idx] += dwell

    # Port or loading-site stage
    visit("port_reweigh", np.where(chain["port_reweigh"])[0], plan["reweigh_service_min"], plan["reweigh_servers"], cfg.stop_overhead_min)
    visit("customs_port", np.where(chain["port_corrected"] & chain["sealed"])[0], plan["customs_service_min"], plan["customs_servers"])
    # Trimming a load at the loading site happens before dispatch: it moves the start time but is not clearance delay.
    t[np.where(chain["origin_trim"])[0]] += 15.0

    st0, st1 = chain["st0"], chain["st1"]
    for si, s in enumerate(STATIONS):
        for slot, st in ((0, st0), (1, st1)):
            at = np.where(st == si)[0]
            if not len(at):
                continue
            t[at] += TRAVEL_MIN[s]
            suffix = f"{s}:{slot}"
            lane_idx = at[chain["lane"][slot][at]]
            visit(f"lane:{suffix}", lane_idx, plan["lane_service_min"], plan["lane_servers"], max(0.0, cfg.lane_pass_min - plan["lane_service_min"]))
            stat_idx = at[chain["static"][slot][at]]
            visit(f"static:{suffix}", stat_idx, plan["static_service_min"], plan["static_servers"], cfg.stop_overhead_min)
            cust = stat_idx[chain["confirmed"][slot][stat_idx] & chain["sealed"][stat_idx]]
            visit(f"customs:{suffix}", cust, plan["customs_service_min"], plan["customs_servers"])
    return {"delay": delay, "records": records, "t_exit": t}


def _queue_simpy(cfg: SimConfig, chain: dict, t0: np.ndarray) -> dict:
    """The same queueing stage as a SimPy discrete-event model, one process per truck."""
    plan = _resource_plan(cfg)
    env = simpy.Environment()
    reweigh = simpy.Resource(env, plan["reweigh_servers"])
    customs_port = simpy.Resource(env, plan["customs_servers"])
    lanes = {s: simpy.Resource(env, plan["lane_servers"]) for s in STATIONS}
    statics = {s: simpy.Resource(env, plan["static_servers"]) for s in STATIONS}
    customs = {s: simpy.Resource(env, plan["customs_servers"]) for s in STATIONS}
    n = len(t0)
    delay = np.zeros(n)
    t_exit = np.zeros(n)
    rec: dict[str, list[list[float]]] = {}
    exited = [0]

    def use(key, res, service, i, extra=0.0):
        arrive = env.now
        with res.request() as req:
            yield req
            rec.setdefault(key, [[], []])
            rec[key][0].append(arrive)
            rec[key][1].append(env.now)
            yield env.timeout(service)
        if extra:
            yield env.timeout(extra)
        delay[i] += env.now - arrive

    def truck(i, t_start):
        yield env.timeout(t_start)
        if chain["port_reweigh"][i]:
            yield from use("port_reweigh", reweigh, plan["reweigh_service_min"], i, cfg.stop_overhead_min)
        if chain["port_corrected"][i] and chain["sealed"][i]:
            yield from use("customs_port", customs_port, plan["customs_service_min"], i)
        if chain["origin_trim"][i]:
            yield env.timeout(15.0)
        for slot in (0, 1):
            si = chain["st0"][i] if slot == 0 else chain["st1"][i]
            if si < 0:
                continue
            s = STATIONS[si]
            yield env.timeout(TRAVEL_MIN[s])
            if chain["lane"][slot][i]:
                yield from use(f"lane:{s}:{slot}", lanes[s], plan["lane_service_min"], i, max(0.0, cfg.lane_pass_min - plan["lane_service_min"]))
            if chain["static"][slot][i]:
                yield from use(f"static:{s}:{slot}", statics[s], plan["static_service_min"], i, cfg.stop_overhead_min)
                if chain["confirmed"][slot][i] and chain["sealed"][i]:
                    yield from use(f"customs:{s}:{slot}", customs[s], plan["customs_service_min"], i)
        t_exit[i] = env.now
        exited[0] += 1

    for i in range(n):
        env.process(truck(i, float(t0[i])))
    env.run()
    records = {}
    servers = {"lane": plan["lane_servers"], "static": plan["static_servers"], "customs": plan["customs_servers"]}
    service = {"lane": plan["lane_service_min"], "static": plan["static_service_min"], "customs": plan["customs_service_min"]}
    for key, (a, s) in rec.items():
        head = key.split(":")[0]
        if key == "port_reweigh":
            records[key] = (np.array(a), np.array(s), plan["reweigh_servers"], plan["reweigh_service_min"])
        elif key == "customs_port":
            records[key] = (np.array(a), np.array(s), plan["customs_servers"], plan["customs_service_min"])
        else:
            records[key] = (np.array(a), np.array(s), servers[head], service[head])
    return {"delay": delay, "records": records, "t_exit": t_exit, "exited": exited[0]}


def run_replication(cfg: SimConfig, scenario_key: str, days: int = 1, warmup_days: int = 0, rep: int = 0, engine: str = "fast", detail: bool = False) -> dict:
    """One replication of one scenario. Trucks arriving during warm-up load the queues but are not counted."""
    scen = SCENARIOS[scenario_key]
    total_days = days + warmup_days
    pop = _draw_population(cfg, total_days, cfg.seed, rep)
    chain = decide_chain(cfg, scen, pop)
    t0 = pop["t0"]
    res = _queue_simpy(cfg, chain, t0) if engine == "simpy" else _queue_fast(cfg, chain, t0)
    return summarize(cfg, scen, pop, chain, res, days, warmup_days, detail)


def summarize(cfg, scen, pop, chain, res, days, warmup_days, detail=False) -> dict:
    t0 = pop["t0"]
    n = pop["n"]
    keep = t0 >= warmup_days * 1440.0
    counted = int(keep.sum())
    delay = res["delay"]
    st0, st1 = chain["st0"], chain["st1"]
    span = days * 1440.0

    def share(mask):
        return float((mask & keep).sum()) / max(counted, 1) * 100.0

    lane0, lane1 = chain["lane"][0], chain["lane"][1]
    static0, static1 = chain["static"][0], chain["static"][1]
    lane_visits = int((lane0 & keep).sum() + (lane1 & keep).sum())
    static_visits = int((static0 & keep).sum() + (static1 & keep).sum())
    reweigh_visits = int((chain["port_reweigh"] & keep).sum())
    later = (st1 >= 0) & keep

    overloaded_end = chain["load_final"] > chain["allow"]
    bad_end = overloaded_end | chain["dim_escaped"] | chain["lifted_escaped"]
    false_clear = float((overloaded_end & keep).sum()) / max(counted, 1) * 100.0

    # Resource statistics, combining the slots of each station
    stations: dict[str, dict] = {}
    for s in STATIONS:
        row: dict = {}
        for head in ("lane", "static"):
            arr, st, servers, svc = [], [], 1, 1.0
            for slot in (0, 1):
                key = f"{head}:{s}:{slot}"
                if key in res["records"] and len(res["records"][key][0]):
                    a, b, servers, svc = res["records"][key]
                    arr.append(a)
                    st.append(b)
            if arr:
                a = np.concatenate(arr)
                b = np.concatenate(st)
                mask = a >= warmup_days * 1440.0
                a, b = a[mask], b[mask]
                row[head] = _queue_stats(a, b, svc, servers, span)
            else:
                row[head] = _queue_stats(np.empty(0), np.empty(0), 1.0, 1, span)
        row["trucks"] = int(((st0 == STATIONS.index(s)) & keep).sum() + ((st1 == STATIONS.index(s)) & keep).sum())
        row["trucks_per_day"] = row["trucks"] / days
        stations[s] = row

    a, b, servers, svc = res["records"].get("port_reweigh", (np.empty(0), np.empty(0), 1, 1.0))
    mask = a >= warmup_days * 1440.0 if len(a) else np.empty(0, dtype=bool)
    port_q = _queue_stats(a[mask] if len(a) else a, b[mask] if len(b) else b, svc, servers, span)

    port_trucks = (chain["stream"] == 0) & chain["enrolled"] & keep
    delays_k = delay[keep]
    hours_per_day = float(delays_k.sum()) / 60.0 / days
    stops_total = static_visits + reweigh_visits

    out = {
        "scenario": scen.key,
        "label": scen.label,
        "trucks": counted,
        "days": days,
        "static_visits": static_visits,
        "lane_visits": lane_visits,
        "port_reweigh_visits": reweigh_visits,
        "total_stops": stops_total,
        "road_stops_per_1000": static_visits / max(counted, 1) * 1000.0,
        "stops_per_1000": stops_total / max(counted, 1) * 1000.0,
        "lane_per_1000": lane_visits / max(counted, 1) * 1000.0,
        "first_station_static_pct": share(static0),
        "first_station_lane_pct": share(lane0),
        "later_station_static_pct": float((static1 & keep).sum()) / max(int(later.sum()), 1) * 100.0,
        "later_station_lane_pct": float((lane1 & keep).sum()) / max(int(later.sum()), 1) * 100.0,
        "port_reweigh_pct": float((chain["port_reweigh"] & keep).sum()) / max(int(port_trucks.sum()), 1) * 100.0,
        "avg_delay_min": float(delays_k.mean()) if counted else 0.0,
        "p95_delay_min": float(np.percentile(delays_k, 95)) if counted else 0.0,
        "delay_hours_per_day": hours_per_day,
        "false_clear_pct": false_clear,
        "escaped_violation_pct": float((bad_end & keep).sum()) / max(counted, 1) * 100.0,
        "token_coverage_pct": share(chain["first_tokened"]),
        "tokens_at_exit_pct": share(chain["has_token_end"]),
        "confirmed_overloads": int((chain["confirmed"][0] & keep).sum() + (chain["confirmed"][1] & keep).sum() + (chain["port_corrected"] & keep).sum()),
        "audits": int((chain["audit"][0] & keep).sum() + (chain["audit"][1] & keep).sum()),
        "stations": stations,
        "port_reweigh": port_q,
        "static_utilization_pct": max(stations[s]["static"]["utilization"] for s in STATIONS) * 100.0,
        "max_static_queue": max(stations[s]["static"]["max_queue"] for s in STATIONS),
        "max_lane_queue": max(stations[s]["lane"]["max_queue"] for s in STATIONS),
        "avg_queue_static": float(np.mean([stations[s]["static"]["mean_queue"] for s in STATIONS])),
        "entered": int(n),
        "exited": int(res.get("exited", n)),
    }
    if detail:
        out["demand"] = station_demand(chain, res, pop, warmup_days, days)
        out["delay_hist"] = _hist(delays_k)
    return out


def _hist(values: np.ndarray) -> dict:
    edges = np.array([0, 0.01, 1, 2, 3, 5, 7, 10, 15, 20, 30, 45, 60, 90, 120, 240, 1e9])
    counts, _ = np.histogram(values, bins=edges)
    return {"edges_min": [float(e) for e in edges[:-1]], "counts": counts.tolist()}


def station_demand(chain: dict, res: dict, pop: dict, warmup_days: int, days: int) -> dict:
    """Average-day arrivals per 5 minutes into each station's mainline, lane and static queue. Input to L3."""
    bins = 288
    t0 = pop["t0"]
    out: dict[str, dict[str, list[float]]] = {}
    w = warmup_days * 1440.0
    for si, s in enumerate(STATIONS):
        main = np.zeros(bins)
        lane = np.zeros(bins)
        static = np.zeros(bins)
        for slot, st in ((0, chain["st0"]), (1, chain["st1"])):
            at = st == si
            eta = t0[at] + TRAVEL_MIN[s] * (slot + 1)
            eta = eta[eta >= w]
            np.add.at(main, ((eta % 1440.0) / 5.0).astype(int) % bins, 1.0)
            for head, arr in (("lane", lane), ("static", static)):
                key = f"{head}:{s}:{slot}"
                if key in res["records"] and len(res["records"][key][0]):
                    a = res["records"][key][0]
                    a = a[a >= w]
                    np.add.at(arr, ((a % 1440.0) / 5.0).astype(int) % bins, 1.0)
        out[s] = {"mainline": (main / days).round(3).tolist(), "lane": (lane / days).round(3).tolist(), "static": (static / days).round(3).tolist()}
    return out


METRICS = [
    "total_stops", "stops_per_1000", "road_stops_per_1000", "lane_per_1000", "first_station_static_pct", "first_station_lane_pct",
    "later_station_static_pct", "later_station_lane_pct", "port_reweigh_pct", "avg_delay_min", "p95_delay_min",
    "delay_hours_per_day", "false_clear_pct", "escaped_violation_pct", "token_coverage_pct", "static_utilization_pct",
    "max_static_queue", "max_lane_queue", "avg_queue_static",
]


def compare(cfg: SimConfig, scenario_keys: list[str] | None = None, days: int = 2, rep: int = 0, engine: str = "fast") -> dict:
    """One-replication scenario comparison, with truck-hours saved relative to the existing process."""
    keys = scenario_keys or list(SCENARIOS)
    results = {k: run_replication(cfg, k, days=days, warmup_days=0, rep=rep, engine=engine, detail=True) for k in keys}
    base = results.get("as_is") or run_replication(cfg, "as_is", days=days, rep=rep, engine="fast")
    for r in results.values():
        r["truck_hours_saved_per_day"] = base["delay_hours_per_day"] - r["delay_hours_per_day"]
    return {"scenarios": results, "kind": "MODELLED", "config": cfg.model_dump()}
