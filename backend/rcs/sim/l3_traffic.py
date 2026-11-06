"""L3 road traffic model: a cell-transmission model (Daganzo) of one road station.

SCOPE: this is a built-in macroscopic alternative to SUMO, which is not installed in this environment. It reproduces
queues, densities, diverge blocking and spillback at cell level. It does not model individual lane changes.

Demand comes from L2's five-minute arrivals into each station's mainline, lane and static queue, so a change in sensor
accuracy (L1) or token coverage (L2) changes the queues here. Lane lengths are the design assumptions in RCS v2 s5.1.
"""
from __future__ import annotations

import numpy as np
from pydantic import BaseModel, Field


class L3Params(BaseModel):
    station: str = "mariakani"
    volume_factor: float = Field(1.0, ge=0.1, le=5.0)
    peak_multiplier: float = Field(1.0, ge=0.5, le=3.0)
    background_veh_per_h: float = Field(0.0, ge=0, le=2000)
    mainline_capacity_veh_per_h: float = Field(1100.0, ge=200, le=2400, description="Heavy-truck lane capacity (assumed)")
    free_flow_kmh: float = Field(80.0, ge=30, le=100)
    jam_density_veh_per_km: float = Field(55.0, ge=30, le=100, description="About 18 m per stopped truck")
    approach_km: float = Field(2.5, ge=0.5, le=10)
    divert_storage_m: float = Field(150.0, ge=50, le=1000, description="Lane approach length, RCS v2 s5.1")
    static_storage_m: float = Field(300.0, ge=50, le=2000, description="Queue space in front of static lanes (assumed)")
    lane_capacity_per_h: float = Field(370.0, ge=10, le=1000)
    static_lanes: int = Field(8, ge=1, le=20)
    static_service_min: float = Field(4.0, ge=0.5, le=60)
    hours: float = Field(24.0, ge=1, le=72)


def _pyfloat(obj):
    if isinstance(obj, dict):
        return {k: _pyfloat(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_pyfloat(v) for v in obj]
    if isinstance(obj, np.generic):
        return obj.item()
    return obj


def run_l3(p: L3Params, demand: dict) -> dict:
    return _pyfloat(_run_l3(p, demand))


def _run_l3(p: L3Params, demand: dict) -> dict:
    """demand: {"mainline":[288], "lane":[288], "static":[288]}: average-day truck arrivals per 5 minutes."""
    main_d = np.asarray(demand["mainline"], dtype=float) * p.volume_factor
    lane_d = np.asarray(demand["lane"], dtype=float) * p.volume_factor
    stat_d = np.asarray(demand["static"], dtype=float) * p.volume_factor
    # Smooth the five-minute counts over 30 minutes: L2 replication noise is not a traffic feature.
    kernel = np.ones(6) / 6.0
    smooth = lambda a: np.convolve(np.concatenate([a[-6:], a, a[:6]]), kernel, mode="same")[6:-6]  # noqa: E731
    main_d, lane_d, stat_d = smooth(main_d), smooth(lane_d), smooth(stat_d)
    if p.peak_multiplier != 1.0:
        mean = main_d.mean() or 1.0
        factor = (1.0 + (main_d / mean - 1.0) * p.peak_multiplier).clip(0.05)
        factor = factor / factor.mean()
        ref = main_d / mean if main_d.sum() else np.ones_like(main_d)
        scale = np.divide(factor, ref, out=np.ones_like(ref), where=ref > 0)
        main_d, lane_d, stat_d = main_d * scale, lane_d * scale, stat_d * scale

    v_f = p.free_flow_kmh / 3.6
    dx = 100.0
    dt = dx / v_f  # CFL = 1
    cells = int(round(p.approach_km * 1000.0 / dx))
    jam_cell = p.jam_density_veh_per_km * dx / 1000.0
    q_max = p.mainline_capacity_veh_per_h / 3600.0 * dt
    w_ratio = 18.0 / p.free_flow_kmh  # backward wave 18 km/h against free flow
    cap_lane = p.lane_capacity_per_h / 3600.0 * dt
    cap_stat = p.static_lanes / (p.static_service_min * 60.0) * dt
    store_lane = p.divert_storage_m / 18.0
    store_stat = p.static_storage_m / 18.0
    down_cells = 4  # weaving and merge section after the station

    steps = int(p.hours * 3600.0 / dt)
    bg = p.background_veh_per_h / 3600.0 * dt
    density = np.zeros(cells + down_cells)
    lane_q = 0.0
    stat_q = 0.0
    entry_q = 0.0  # vehicles held out of the model when the first cell is full: spillback beyond the boundary
    rec_every = max(1, int(900.0 / dt))
    heat, ts_lane, ts_stat, ts_entry, ts_speed, ts_flow = [], [], [], [], [], []
    spill_steps = 0
    blocked_steps = 0
    max_lane, max_stat = 0.0, 0.0
    served = 0.0
    demanded = 0.0
    speed_sum = 0.0
    speed_n = 0

    for k in range(steps):
        t_min = k * dt / 60.0
        b = int(t_min / 5.0) % 288
        step_frac = dt / 300.0
        dem = main_d[b] * step_frac + bg
        dem_lane = lane_d[b] * step_frac
        dem_stat = stat_d[b] * step_frac
        demanded += dem
        entry_q += dem

        send = np.minimum(density, q_max)
        recv = np.minimum(q_max, w_ratio * (jam_cell - density))
        flow = np.minimum(send[:-1], recv[1:])

        # Diverge at the last approach cell, with FIFO blocking. A full side lane holds up the mainline behind it.
        frac_div = (dem_lane + dem_stat) / dem if dem > 1e-9 else 0.0
        frac_lane = dem_lane / dem if dem > 1e-9 else 0.0
        frac_stat = dem_stat / dem if dem > 1e-9 else 0.0
        di = cells - 1
        room_lane = max(0.0, store_lane - lane_q)
        room_stat = max(0.0, store_stat - stat_q)
        s = send[di]
        limit = recv[di + 1] / max(1e-9, 1.0 - frac_div)
        if frac_lane > 0:
            limit = min(limit, room_lane / frac_lane)
        if frac_stat > 0:
            limit = min(limit, room_stat / frac_stat)
        out = min(s, limit)
        blocked = out < s - 1e-9 and ((frac_lane > 0 and room_lane / frac_lane < s) or (frac_stat > 0 and room_stat / frac_stat < s))
        if blocked:
            blocked_steps += 1
        flow[di] = out * (1.0 - frac_div)
        lane_q += out * frac_lane
        stat_q += out * frac_stat
        lane_q -= min(lane_q, cap_lane)
        stat_q -= min(stat_q, cap_stat)
        max_lane = max(max_lane, lane_q)
        max_stat = max(max_stat, stat_q)

        inflow = min(entry_q, q_max, w_ratio * (jam_cell - density[0]))
        entry_q -= inflow
        new = density.copy()
        new[0] += inflow
        new[:-1] -= np.where(np.arange(len(flow)) == di, out, flow)
        new[1:] += flow
        exit_flow = min(send[-1], q_max)
        new[-1] -= exit_flow
        served += exit_flow + out * frac_div
        density = np.maximum(new, 0.0)

        dens_km = density / dx * 1000.0
        speeds = np.where(density > 1e-6, np.minimum(p.free_flow_kmh, send / np.maximum(density, 1e-9) * p.free_flow_kmh), p.free_flow_kmh)
        speed_sum += speeds.mean()
        speed_n += 1
        if density[: cells - 1].max() > 0.5 * jam_cell:
            spill_steps += 1

        if k % rec_every == 0:
            heat.append(dens_km.round(1).tolist())
            ts_lane.append(round(lane_q, 2))
            ts_stat.append(round(stat_q, 2))
            ts_entry.append(round(entry_q, 2))
            ts_speed.append(round(float(speeds.mean()), 1))
            ts_flow.append(round(exit_flow / dt * 3600.0, 1))

    # Storage needed to hold the worst side-lane queue, including what spilled back
    jam_m = 18.0
    return {
        "kind": "MODELLED",
        "scope": "Built-in cell-transmission model (SUMO not installed). Macroscopic: no individual lane changes.",
        "station": p.station,
        "params": p.model_dump(),
        "cell_m": dx,
        "dt_s": round(dt, 2),
        "time_step_min": round(rec_every * dt / 60.0, 1),
        "heatmap_density_veh_km": heat,
        "lane_queue": ts_lane,
        "static_queue": ts_stat,
        "entry_queue": ts_entry,
        "mean_speed_kmh": ts_speed,
        "exit_flow_veh_h": ts_flow,
        "max_lane_queue_veh": round(max_lane, 1),
        "max_static_queue_veh": round(max_stat, 1),
        "max_entry_queue_veh": round(max(ts_entry) if ts_entry else 0.0, 1),
        "spillback_minutes": round(float(blocked_steps * dt / 60.0), 1),
        "congested_minutes": round(spill_steps * dt / 60.0, 1),
        "avg_speed_kmh": round(speed_sum / max(speed_n, 1), 1),
        "required_divert_storage_m": round(max_lane * jam_m, 0),
        "required_static_storage_m": round(max_stat * jam_m, 0),
        "demand_trucks": round(float(main_d.sum()) * p.hours / 24.0, 0),
        "served_veh": round(served, 0),
        "demand_veh": round(demanded, 0),
        "lane_peak_per_h": round(float(lane_d.max()) * 12.0, 1),
        "static_peak_per_h": round(float(stat_d.max()) * 12.0, 1),
        "main_peak_per_h": round(float(main_d.max()) * 12.0, 1),
    }
