"""Monte Carlo experiments: replications per scenario with common random numbers, paired differences and 95% CIs."""
from __future__ import annotations

import math
from concurrent.futures import BrokenExecutor, Executor, as_completed
from typing import Callable

import numpy as np
from scipy import stats

from .l1_sensor import L1Params, scale_errors
from .l2_process import METRICS, SCENARIOS, compare, run_replication
from .l3_traffic import L3Params, run_l3
from .l4_system import L4Params, run_l4
from .params import SimConfig


def ci95(values: list[float]) -> dict:
    a = np.asarray(values, dtype=float)
    mean = float(a.mean())
    if len(a) < 2:
        return {"mean": mean, "ci_low": mean, "ci_high": mean, "half_width": 0.0, "n": int(len(a))}
    half = float(stats.t.ppf(0.975, len(a) - 1) * a.std(ddof=1) / math.sqrt(len(a)))
    return {"mean": mean, "ci_low": mean - half, "ci_high": mean + half, "half_width": half, "n": int(len(a))}


def _job(cfg_dict: dict, scenario: str, days: int, warmup: int, rep: int) -> dict:
    cfg = SimConfig(**cfg_dict)
    r = run_replication(cfg, scenario, days=days, warmup_days=warmup, rep=rep)
    return {"scenario": scenario, "rep": rep, "metrics": {m: float(r[m]) for m in METRICS}, "entered": r["entered"], "exited": r["exited"],
            "station_static_util": {s: r["stations"][s]["static"]["utilization"] for s in r["stations"]}, "lane_util": {s: r["stations"][s]["lane"]["utilization"] for s in r["stations"]},
            "delay_hours_per_day": r["delay_hours_per_day"]}


def run_monte_carlo(
    cfg: SimConfig,
    scenarios: list[str] | None = None,
    replications: int = 30,
    days: int = 30,
    warmup_days: int = 2,
    executor: Executor | None = None,
    progress: Callable[[float, str], None] | None = None,
) -> dict:
    keys = scenarios or list(SCENARIOS)
    if "as_is" not in keys:
        keys = ["as_is"] + keys
    cfg_dict = cfg.model_dump()
    tasks = [(cfg_dict, k, days, warmup_days, rep) for k in keys for rep in range(replications)]
    results: list[dict] = []
    total = len(tasks)
    if executor is None:
        for i, t in enumerate(tasks):
            results.append(_job(*t))
            if progress:
                progress((i + 1) / total, f"{t[1]} replication {t[4] + 1}/{replications}")
    else:
        futures = {executor.submit(_job, *t): t for t in tasks}
        pending = dict(futures)
        try:
            for f in as_completed(futures):
                results.append(f.result())
                t = pending.pop(f)
                if progress:
                    progress(len(results) / total, f"{t[1]} replication {t[4] + 1}/{replications}")
        except BrokenExecutor:
            # A worker died, usually from memory pressure. Finish here: slower, but the experiment still completes.
            for t in pending.values():
                results.append(_job(*t))
                if progress:
                    progress(len(results) / total, f"{t[1]} replication {t[4] + 1}/{replications} (in-process)")

    by: dict[str, dict[int, dict]] = {k: {} for k in keys}
    for r in results:
        by[r["scenario"]][r["rep"]] = r
    out: dict[str, dict] = {}
    for k in keys:
        reps = sorted(by[k])
        row = {m: ci95([by[k][i]["metrics"][m] for i in reps]) for m in METRICS}
        # Paired against the existing process: common random numbers make these narrow
        paired = [by["as_is"][i]["delay_hours_per_day"] - by[k][i]["delay_hours_per_day"] for i in reps]
        row["truck_hours_saved_per_day"] = ci95(paired)
        paired_stops = [by["as_is"][i]["metrics"]["stops_per_1000"] - by[k][i]["metrics"]["stops_per_1000"] for i in reps]
        row["stops_avoided_per_1000"] = ci95(paired_stops)
        out[k] = {"label": SCENARIOS[k].label, "note": SCENARIOS[k].note, "metrics": row}
    conservation_ok = all(r["entered"] == r["exited"] for r in results)
    return {
        "kind": "MODELLED",
        "design": {"replications": replications, "days": days, "warmup_days": warmup_days, "common_random_numbers": True, "base_seed": cfg.seed,
                   "trucks_simulated": sum(r["entered"] for r in results)},
        "config": cfg_dict,
        "scenarios": out,
        "conservation_ok": conservation_ok,
    }


TORNADO_FACTORS = [
    # RCS v2 s10.4 factor ranges
    ("avg_loading_pct", "Average loading (%)", 75, 90),
    ("port_error_pct", "Port scale error (%)", 0.5, 2.0),
    ("road_error_pct", "Road WIM error (%)", 1.5, 4.0),
    ("token_coverage_pct", "Token coverage (%)", 50, 100),
    ("peak_factor", "Peak factor", 1.0, 2.0),
    ("outage_per_day", "Outages per day", 0, 4),
    ("outage_duration_min", "Outage duration (min)", 10, 120),
    ("audit_pct", "Audit share (%)", 1, 5),
    ("lane_error_pct", "Lane scale error (%)", 0.5, 2.0),
    ("static_stop_min", "Static stop (min)", 4, 10),
]


def _tornado_job(cfg_dict: dict, scenario: str, days: int, reps: int) -> dict:
    cfg = SimConfig(**cfg_dict)
    out = {"road_stops_per_1000": 0.0, "delay_hours_per_day": 0.0, "false_clear_pct": 0.0, "lane_per_1000": 0.0, "port_reweigh_pct": 0.0, "p95_delay_min": 0.0}
    for rep in range(reps):
        r = run_replication(cfg, scenario, days=days, warmup_days=1, rep=rep)
        for k in out:
            out[k] += r[k] / reps
    return out


def run_tornado(cfg: SimConfig, scenario: str = "v2_all", metric: str = "road_stops_per_1000", days: int = 5, reps: int = 4, executor: Executor | None = None, progress=None) -> dict:
    """One-factor-at-a-time sensitivity, with common random numbers across levels."""
    base_dict = cfg.model_dump()
    jobs = [("__base__", None, base_dict)]
    for key, _label, lo, hi in TORNADO_FACTORS:
        jobs.append((key, "low", {**base_dict, key: lo}))
        jobs.append((key, "high", {**base_dict, key: hi}))
    results: dict[tuple, dict] = {}
    total = len(jobs)
    if executor is None:
        for i, (k, level, c) in enumerate(jobs):
            results[(k, level)] = _tornado_job(c, scenario, days, reps)
            if progress:
                progress((i + 1) / total, f"{k} {level or ''}")
    else:
        futs = {executor.submit(_tornado_job, c, scenario, days, reps): (k, level) for k, level, c in jobs}
        try:
            for f in as_completed(futs):
                results[futs[f]] = f.result()
                if progress:
                    progress(len(results) / total, str(futs[f][0]))
        except BrokenExecutor:
            for k, level, c in jobs:
                if (k, level) not in results:
                    results[(k, level)] = _tornado_job(c, scenario, days, reps)
                    if progress:
                        progress(len(results) / total, f"{k} (in-process)")
    base = results[("__base__", None)]
    metrics = list(base.keys())
    tables: dict[str, list[dict]] = {}
    for m in metrics:
        rows = []
        for key, label, lo, hi in TORNADO_FACTORS:
            low, high = results[(key, "low")][m], results[(key, "high")][m]
            rows.append({"factor": key, "label": label, "low_value": lo, "high_value": hi, "low": low, "high": high, "swing": abs(high - low)})
        rows.sort(key=lambda r: -r["swing"])
        tables[m] = rows
    return {"kind": "MODELLED", "scenario": scenario, "metric": metric, "base": base, "tables": tables, "design": {"days": days, "reps": reps}}


def run_linked(cfg: SimConfig, l1: L1Params | None, apply_l1: bool = True, station: str = "mariakani", days: int = 2, l3: L3Params | None = None, l4: L4Params | None = None, scenario: str = "v2_all") -> dict:
    """L1 sets scale errors, L2 uses them, L3 and L4 take their demand from L2."""
    trace: list[str] = []
    used = cfg
    errors = None
    if l1 is not None and apply_l1:
        errors = scale_errors(l1)
        used = cfg.model_copy(update=errors)
        trace.append(f"L1 sets road error {errors['road_error_pct']}%, port {errors['port_error_pct']}%, lane {errors['lane_error_pct']}% for L2.")
    l2 = compare(used, days=days)
    chosen = l2["scenarios"].get(scenario) or next(iter(l2["scenarios"].values()))
    trace.append(f"L2 at these errors: {chosen['first_station_lane_pct']:.1f}% lane and {chosen['first_station_static_pct']:.1f}% static at the first station.")
    params3 = l3 or L3Params(station=station, static_lanes=used.static_lanes, static_service_min=used.static_service_min(), lane_capacity_per_h=used.lane_capacity_per_h())
    l3_res = {}
    for key in {scenario, "as_is"}:
        l3_res[key] = run_l3(params3, l2["scenarios"][key]["demand"][params3.station])
    trace.append(f"L3 takes L2 demand: {l3_res[scenario]['max_lane_queue_veh']} trucks peak lane queue, {l3_res[scenario]['spillback_minutes']} min of diverge blocking.")
    trucks_by_site = {s: chosen["stations"][s]["trucks_per_day"] for s in chosen["stations"]}
    trucks_by_site["port_node"] = cfg.trucks_per_day * cfg.shares()[0]
    params4 = l4 or L4Params(outage_per_day=used.outage_per_day, outage_duration_min=used.outage_duration_min)
    l4_res = run_l4(params4, trucks_by_site)
    trace.append(f"L4 carries {l4_res['events_generated']} events from those trucks: p95 {l4_res['api_latency_p95_ms']} ms, integrity {l4_res['data_integrity_pct']}%.")
    return {"kind": "MODELLED", "trace": trace, "scale_errors": errors, "config_used": used.model_dump(), "l2": l2, "l3": l3_res, "l4": l4_res, "scenario": scenario}
