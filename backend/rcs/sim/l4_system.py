"""L4 system model: edge units, MQTT broker, token service, registry and mock agency APIs, under load and failure.

This is a SimPy software-in-the-loop model. It is not a hardware test: no bench rig exists yet, and the RCS v2 plan
leaves real hardware replay for Phase 3. The latency distributions are assumptions, except that the crypto cost of
signing and verifying a token is measured on this machine at run time and added to the service time.

Offered load comes from L2 (trucks per station), so L1 and L2 changes change the load here. Failures also feed the live
twin: use the fault-injection controls, which act on the same system layer the twin uses.
"""
from __future__ import annotations

import time

import numpy as np
import simpy
from pydantic import BaseModel, Field

from ..domain.tokens import Signer, build_payload, new_keypair, verify_signature


class L4Params(BaseModel):
    hours: float = Field(24, ge=1, le=72)
    load_multiplier: float = Field(1.0, ge=0.1, le=50)
    messages_per_truck: int = Field(3, ge=1, le=20)
    token_service_workers: int = Field(4, ge=1, le=64)
    token_service_ms: float = Field(6.0, ge=0.1, le=500)
    registry_write_ms: float = Field(4.0, ge=0.1, le=500)
    agency_api_ms: float = Field(180.0, ge=1, le=5000)
    agency_failure_pct: float = Field(1.0, ge=0, le=100)
    outage_per_day: float = Field(0.5, ge=0, le=48)
    outage_duration_min: float = Field(30, ge=1, le=720)
    device_failures_per_day: float = Field(0.2, ge=0, le=48)
    device_repair_min: float = Field(60, ge=1, le=1440)
    sync_rate_per_s: float = Field(50, ge=1, le=5000)
    edge_store_capacity: int = Field(500000, ge=1000)
    retry_timeout_s: float = Field(5, ge=0.5, le=120)
    seed: int = 11


def measure_crypto_ms(rounds: int = 200) -> dict:
    """Real sign and verify timing for the token service."""
    priv, pub = new_keypair()
    signer = Signer("bench", priv)
    from datetime import datetime, timezone

    payload = build_payload(
        tractor_plate="KDA 000A", trailer_plate="ZD 0000", rfid_tag="E200", container_number="MSCU1234565", container_check_ok=True,
        eseal_id="ES1", measured_gross_kg=42000, expected_gross_kg=41500, axle_loads_kg=[7000] * 6, axle_group_loads_kg=[7000, 14000, 21000],
        height_m=4.1, width_m=2.5, length_m=17, axle_config="1-2-3", permit_ref=None, origin_station="bench", source="port",
        issued_at=datetime.now(timezone.utc), validity_hours=72, destination="x", route="x", driver_ref=None, release_snapshot={"kra": True},
    )
    t0 = time.perf_counter()
    sigs = [signer.sign(payload) for _ in range(rounds)]
    t1 = time.perf_counter()
    ok = all(verify_signature(payload, s, signer.public_raw) for s in sigs[: rounds // 2])
    t2 = time.perf_counter()
    return {"sign_ms": round((t1 - t0) / rounds * 1000, 4), "verify_ms": round((t2 - t1) / (rounds // 2) * 1000, 4), "verified": ok}


def run_l4(p: L4Params, trucks_by_site: dict[str, float], profile: list[float] | None = None) -> dict:
    """trucks_by_site is trucks per day per edge site, taken from L2."""
    rng = np.random.default_rng(p.seed)
    crypto = measure_crypto_ms(100)
    env = simpy.Environment()
    token_service = simpy.Resource(env, capacity=p.token_service_workers)
    agency = simpy.Resource(env, capacity=8)
    sites = list(trucks_by_site)
    link_up = {s: True for s in sites}
    device_up = {s: True for s in sites}
    store: dict[str, list[tuple[int, float]]] = {s: [] for s in sites}
    seen: set[tuple[str, int]] = set()
    generated = 0
    duplicates = 0
    failed = 0
    lost = 0
    agency_fail = 0
    latencies: list[float] = []
    agency_lat: list[float] = []
    outage_log: list[dict] = []
    recovery_times: list[float] = []
    device_down_time = {s: 0.0 for s in sites}
    outage_down_time = {s: 0.0 for s in sites}
    bucket_s = 900.0
    n_buckets = int(p.hours * 3600.0 / bucket_s) + 2
    throughput = np.zeros(n_buckets)
    depth = np.zeros(n_buckets)
    fails = np.zeros(n_buckets)
    lat_sum = np.zeros(n_buckets)
    lat_n = np.zeros(n_buckets)
    seq = {s: 0 for s in sites}
    weights = np.array(profile if profile else [1.0] * 24, dtype=float)
    weights = weights / weights.mean()
    horizon = p.hours * 3600.0

    def deliver(site: str, msg_seq: int, created: float, attempt_latency: float = 0.0):
        nonlocal duplicates, failed
        svc = (p.token_service_ms + crypto["sign_ms"] + crypto["verify_ms"]) / 1000.0
        broker = rng.lognormal(np.log(0.012), 0.5)
        yield env.timeout(broker)
        with token_service.request() as req:
            yield req
            yield env.timeout(rng.exponential(svc))
        yield env.timeout(rng.exponential(p.registry_write_ms / 1000.0))
        key = (site, msg_seq)
        if key in seen:
            duplicates += 1
        else:
            seen.add(key)
            lat = env.now - created
            latencies.append(lat)
            b = min(int(env.now / bucket_s), n_buckets - 1)
            throughput[b] += 1
            lat_sum[b] += lat
            lat_n[b] += 1

    def arrivals(site: str):
        nonlocal generated, lost, failed
        rate_per_s = trucks_by_site[site] * p.messages_per_truck * p.load_multiplier / 86400.0
        while env.now < horizon:
            hour = int(env.now / 3600.0) % len(weights)
            rate = max(1e-6, rate_per_s * weights[hour])
            yield env.timeout(rng.exponential(1.0 / rate))
            if env.now >= horizon:
                break
            if not device_up[site]:
                # Edge unit down: no event record is produced; the roadside falls back to the existing static process.
                continue
            generated += 1
            seq[site] += 1
            if link_up[site]:
                env.process(deliver(site, seq[site], env.now))
                # QoS 1: a small share of messages are redelivered and must be de-duplicated by the registry.
                if rng.random() < 0.002:
                    env.process(deliver(site, seq[site], env.now))
                if rng.random() < p.agency_failure_pct / 100.0 * 0.02:
                    failed += 1
                    fails[min(int(env.now / bucket_s), n_buckets - 1)] += 1
                    env.process(deliver(site, seq[site], env.now + p.retry_timeout_s))
            else:
                if len(store[site]) >= p.edge_store_capacity:
                    lost += 1
                else:
                    store[site].append((seq[site], env.now))

    def agency_calls():
        nonlocal agency_fail
        total_rate = sum(trucks_by_site.values()) * p.load_multiplier * 0.5 / 86400.0
        while env.now < horizon and total_rate > 0:
            yield env.timeout(rng.exponential(1.0 / total_rate))
            t0 = env.now
            with agency.request() as req:
                yield req
                yield env.timeout(rng.lognormal(np.log(p.agency_api_ms / 1000.0), 0.6))
            if rng.random() < p.agency_failure_pct / 100.0:
                agency_fail += 1
                fails[min(int(env.now / bucket_s), n_buckets - 1)] += 1
            agency_lat.append(env.now - t0)

    def outage(site: str):
        if p.outage_per_day <= 0:
            return
        while env.now < horizon:
            yield env.timeout(rng.exponential(86400.0 / p.outage_per_day))
            if env.now >= horizon:
                break
            start = env.now
            dur = p.outage_duration_min * 60.0 * rng.uniform(0.7, 1.3)
            link_up[site] = False
            yield env.timeout(dur)
            link_up[site] = True
            outage_down_time[site] += dur
            backlog = len(store[site])
            sync_start = env.now
            while store[site]:
                chunk = store[site][: max(1, int(p.sync_rate_per_s))]
                del store[site][: len(chunk)]
                for msg_seq, created in chunk:
                    env.process(deliver(site, msg_seq, created))
                yield env.timeout(1.0)
            rec = env.now - sync_start
            recovery_times.append(rec)
            outage_log.append({"site": site, "start_h": round(start / 3600.0, 2), "duration_min": round(dur / 60.0, 1), "backlog": backlog, "recovery_s": round(rec, 1)})

    def device(site: str):
        if p.device_failures_per_day <= 0:
            return
        while env.now < horizon:
            yield env.timeout(rng.exponential(86400.0 / p.device_failures_per_day))
            if env.now >= horizon:
                break
            device_up[site] = False
            d = rng.exponential(p.device_repair_min * 60.0)
            yield env.timeout(d)
            device_up[site] = True
            device_down_time[site] += d

    def sampler():
        while env.now < horizon:
            b = min(int(env.now / bucket_s), n_buckets - 1)
            depth[b] = max(depth[b], sum(len(v) for v in store.values()))
            yield env.timeout(60.0)

    for s in sites:
        env.process(arrivals(s))
        env.process(outage(s))
        env.process(device(s))
    env.process(agency_calls())
    env.process(sampler())
    t_wall = time.perf_counter()
    env.run(until=horizon + 3600.0 * 6)
    wall = time.perf_counter() - t_wall

    lat = np.asarray(latencies) if latencies else np.zeros(1)
    delivered = len(seen)
    pending = sum(len(v) for v in store.values())
    downtime = sum(device_down_time.values())
    avail = 100.0 * (1.0 - downtime / max(1.0, horizon * max(1, len(sites))))
    cloud_avail = 100.0 * (1.0 - sum(outage_down_time.values()) / max(1.0, horizon * max(1, len(sites))))
    n = int(p.hours * 3600.0 / bucket_s)
    realtime = lat[lat < 60.0] if (lat < 60.0).any() else lat
    return {
        "kind": "MODELLED",
        "scope": "SimPy software-in-the-loop model. No physical hardware or broker is in this loop.",
        "params": p.model_dump(),
        "offered_trucks_by_site": trucks_by_site,
        "crypto_measured_here": crypto,
        "events_generated": generated,
        "events_delivered": delivered,
        "events_pending": pending,
        "events_lost": lost,
        "duplicates_removed": duplicates,
        "failed_requests": failed + agency_fail,
        "agency_failures": agency_fail,
        "data_integrity_pct": round(100.0 * delivered / max(generated, 1), 4),
        "api_latency_p50_ms": round(float(np.percentile(realtime, 50)) * 1000.0, 1),
        "api_latency_p95_ms": round(float(np.percentile(realtime, 95)) * 1000.0, 1),
        "api_latency_p99_ms": round(float(np.percentile(realtime, 99)) * 1000.0, 1),
        "agency_latency_p95_ms": round(float(np.percentile(agency_lat, 95)) * 1000.0, 1) if agency_lat else 0.0,
        "event_throughput_per_s": round(generated / max(horizon, 1.0), 2),
        "peak_queue_depth": int(depth.max()),
        "edge_availability_pct": round(avail, 3),
        "cloud_link_availability_pct": round(cloud_avail, 3),
        "outages": outage_log,
        "mean_recovery_s": round(float(np.mean(recovery_times)), 1) if recovery_times else 0.0,
        "max_recovery_s": round(float(np.max(recovery_times)), 1) if recovery_times else 0.0,
        "series": {
            "bucket_min": bucket_s / 60.0,
            "throughput_per_s": [round(float(x) / bucket_s, 3) for x in throughput[:n]],
            "queue_depth": depth[:n].astype(int).tolist(),
            "failed": fails[:n].astype(int).tolist(),
            "latency_ms": [round(float(a / b) * 1000.0, 1) if b else 0.0 for a, b in zip(lat_sum[:n], lat_n[:n])],
        },
        "wall_seconds": round(wall, 2),
    }
