"""L1 sensor and algorithm model.

A quarter-car per axle runs over a synthetic ISO 8608 road profile. Sensor rows sample the dynamic tyre force. Each row
adds temperature drift, a calibration gain error and noise, and the estimator averages the rows and applies temperature
and speed correction. Results set the port, road and lane errors used by L2 and by the live twin.

Coefficients are textbook-style assumptions tuned so the baseline reproduces the error targets in RCS v2 s9
(road about 2.5%, port and lane about 1%). They are MODELLED and must be replaced by OIML R134 and COST 323
tests with pre-weighed reference trucks.
"""
from __future__ import annotations

import time

import numpy as np
from pydantic import BaseModel, Field
from scipy import signal

G = 9.81


class L1Params(BaseModel):
    avg_loading_pct: float = Field(85, ge=30, le=120)
    speed_kmh: float = Field(80, ge=5, le=100)
    temperature_c: float = Field(30, ge=-5, le=70)
    sensor_error_pct: float = Field(2.5, ge=0, le=15, description="Per-row sensor repeatability, 1 sigma")
    noise_pct: float = Field(0.6, ge=0, le=10, description="Electrical noise per sample, relative to the peak")
    calibration: str = Field("good", pattern="^(good|aged|overdue)$")
    road_roughness: str = Field("A", pattern="^[A-D]$", description="ISO 8608 class. RCS v1 s5: site selection drives accuracy")
    sensor_rows: int = Field(3, ge=1, le=16)
    passes: int = Field(400, ge=50, le=2000)
    sampling_khz: float = Field(5, ge=0.5, le=20)
    seed: int = 7


# ISO 8608 reference roughness Gd(n0) at n0 = 0.1 cycles/m, in m^3 (lower bound of each class doubled to mid-class).
ISO8608 = {"A": 16e-6, "B": 64e-6, "C": 256e-6, "D": 1024e-6}
CAL = {"good": (0.0, 0.25), "aged": (0.6, 0.8), "overdue": (1.6, 1.6)}  # (bias %, drift sigma %)
TEMP_COEFF_PCT_PER_C = 0.08  # raw quartz or road structure sensitivity before compensation
TEMP_COMP_RESIDUAL = 0.25  # share of the temperature effect left after compensation
SCALES = {
    "road": {"speed_kmh": 80.0, "sensor_rows": 3, "road_roughness": "A"},
    "port": {"speed_kmh": 10.0, "sensor_rows": 8, "road_roughness": "A"},
    "lane": {"speed_kmh": 10.0, "sensor_rows": 8, "road_roughness": "A"},
}


def road_profile(rng: np.random.Generator, length_m: float, dx: float, gd0: float, n_series: int) -> np.ndarray:
    """ISO 8608 spectral synthesis. Returns elevation (m) on n_series independent wheel tracks."""
    n = int(length_m / dx)
    freqs = np.fft.rfftfreq(n, dx)
    with np.errstate(divide="ignore"):
        psd = np.where(freqs > 0.01, gd0 * (freqs / 0.1) ** -2.0, 0.0)
    amp = np.sqrt(psd * freqs[1] / 2.0) * n
    phase = rng.random((n_series, len(freqs))) * 2 * np.pi
    return np.fft.irfft(amp * np.exp(1j * phase), n=n, axis=1)


def quarter_car_force(profile: np.ndarray, dx: float, speed_ms: float, static_force: np.ndarray) -> np.ndarray:
    """Tyre force on a road profile (shape: passes x samples). Semi-implicit Euler, vectorised over trucks."""
    n_pass, n = profile.shape
    # Sprung mass scales with load; suspension and tyre as typical heavy-axle values
    ms = static_force / G - 700.0
    ms = np.clip(ms, 400.0, None)
    mu, ks, cs, kt = 700.0, 1.0e6, 2.0e4, 3.5e6
    dt_road = dx / speed_ms
    sub = max(1, int(np.ceil(dt_road / 2e-3)))
    dt = dt_road / sub
    zs = np.zeros(n_pass)
    zu = np.zeros(n_pass)
    vs = np.zeros(n_pass)
    vu = np.zeros(n_pass)
    force = np.empty((n_pass, n))
    for i in range(n):
        zr = profile[:, i]
        for _ in range(sub):
            fs = ks * (zu - zs) + cs * (vu - vs)
            ft = kt * (zr - zu)
            vs += dt * fs / ms
            vu += dt * (ft - fs) / mu
            zs += dt * vs
            zu += dt * vu
        force[:, i] = static_force + kt * (zr - zu)
    return force


def _dlc_samples(p: L1Params, rng: np.random.Generator) -> np.ndarray:
    """Relative dynamic force at the sensor rows for each pass (passes x rows x axle-equivalents)."""
    speed = p.speed_kmh / 3.6
    gd0 = ISO8608[p.road_roughness]
    dx = max(0.04, speed * 4e-3)
    settle = float(np.clip(speed * 3.0, 8.0, 60.0))
    row_gap = 3.0 if p.sensor_rows <= 4 else 15.0 / max(p.sensor_rows - 1, 1)
    span = settle + row_gap * max(p.sensor_rows - 1, 1) + 2.0
    # Gross weight sums several axle groups, whose bounce is only partly correlated: three independent groups per pass.
    groups = 3
    profile = road_profile(rng, span, dx, gd0, p.passes * groups)
    load = np.clip(p.avg_loading_pct / 100.0, 0.3, 1.3)
    static = np.full(p.passes * groups, 80e3 * load)  # lighter trucks bounce relatively more
    force = quarter_car_force(profile, dx, speed, static)
    rows = settle + np.arange(p.sensor_rows) * row_gap
    idx = np.minimum((rows / dx).astype(int), force.shape[1] - 1)
    rel = force[:, idx] / static[:, None] - 1.0
    return rel.reshape(p.passes, groups, p.sensor_rows).mean(axis=1)


def run_l1(p: L1Params) -> dict:
    """Monte Carlo over `passes` truck passes. Returns error statistics and a histogram."""
    rng = np.random.default_rng(p.seed)
    dyn = _dlc_samples(p, rng)  # passes x rows
    n, rows = dyn.shape
    # Row-level errors
    row_err = rng.standard_normal((n, rows)) * p.sensor_error_pct / 100.0
    # Electrical noise averaged across the number of samples under the footprint
    footprint_s = 0.2 / (max(p.speed_kmh, 1.0) / 3.6)
    samples = max(1.0, footprint_s * p.sampling_khz * 1000.0)
    noise = rng.standard_normal((n, rows)) * (p.noise_pct / 100.0) / np.sqrt(samples)
    # Under-sampling penalty: fewer than about 10 samples across the footprint distorts the peak (RCS v1 s5)
    undersample = max(0.0, (10.0 - samples) / 10.0) * 2.0 / 100.0
    under = rng.standard_normal((n, rows)) * undersample
    # Temperature: drift from 25 C, with most removed by compensation
    temp = (p.temperature_c - 25.0) * TEMP_COEFF_PCT_PER_C / 100.0 * TEMP_COMP_RESIDUAL
    # Calibration condition: fixed bias in this calibration period plus site gain drift per pass
    cal_bias, cal_sigma = CAL[p.calibration]
    gain = rng.standard_normal(n) * cal_sigma / 100.0 + cal_bias / 100.0
    # Lane-position sensitivity: off-centre wheel paths
    path = np.abs(rng.standard_normal(n)) * 0.25 / 100.0
    per_row = 1.0 + dyn + row_err + noise + under
    est = per_row.mean(axis=1) * (1.0 + temp + gain - path)
    err = (est - 1.0) * 100.0
    sigma = float(err.std(ddof=1))
    bias = float(err.mean())
    total = float(np.sqrt(sigma**2 + bias**2))
    within = float((np.abs(err) <= 5.0).mean() * 100.0)
    hist, edges = np.histogram(err, bins=np.linspace(-10, 10, 41))
    return {
        "kind": "MODELLED",
        "params": p.model_dump(),
        "bias_pct": round(bias, 3),
        "sigma_pct": round(sigma, 3),
        "total_error_pct": round(total, 3),
        "expanded_95_pct": round(1.96 * total, 3),
        "margin_k2_pct": round(2 * total, 3),
        "within_5pct": round(within, 1),
        "confidence_score": round(float(np.clip(1.0 - total / 10.0, 0, 1)), 3),
        "samples_per_footprint": round(samples, 1),
        "dynamic_load_coefficient": round(float(dyn.std()), 4),
        "histogram": {"edges": [round(float(e), 2) for e in edges], "counts": hist.tolist()},
        "oiml_class_hint": _oiml_hint(1.96 * total),
    }


def _oiml_hint(expanded: float) -> str:
    for label, bound in (("F2 (2%)", 2.0), ("F5 (5%)", 5.0), ("F10 (10%)", 10.0)):
        if expanded <= bound:
            return f"Would sit within {label} gross-weight band (indicative, not a certification)"
    return "Outside the F10 band"


def accuracy_curves(p: L1Params, points: int = 7) -> dict:
    """Error curves by speed, temperature and load around the operating point."""
    q = p.model_copy(update={"passes": min(p.passes, 250)})

    def sweep(field, values):
        return [{"x": float(v), "sigma_pct": run_l1(q.model_copy(update={field: v}))["total_error_pct"]} for v in values]

    return {
        "kind": "MODELLED",
        "speed": sweep("speed_kmh", np.linspace(5, 100, points).round(0)),
        "temperature": sweep("temperature_c", np.linspace(10, 60, points).round(0)),
        "load": sweep("avg_loading_pct", np.linspace(50, 110, points).round(0)),
    }


def scale_errors(p: L1Params) -> dict:
    """Derives the road, port, lane and origin errors from one L1 condition set: the link into L2 and the twin."""
    out = {}
    for name, overrides in SCALES.items():
        update = dict(overrides)
        if name == "road":
            update["speed_kmh"] = p.speed_kmh
            update["sensor_rows"] = p.sensor_rows
            update["sensor_error_pct"] = p.sensor_error_pct
            update["road_roughness"] = p.road_roughness
        else:
            update["sensor_error_pct"] = max(0.05, p.sensor_error_pct * 0.42)
        q = p.model_copy(update=update)
        total = run_l1(q)["total_error_pct"]
        # Low-speed decks carry an installation and approach-grade term the quarter-car does not see (assumed 0.8%).
        out[name] = total if name == "road" else float(np.hypot(total, 0.8))
    return {
        "road_error_pct": round(max(out["road"], 0.1), 2),
        "port_error_pct": round(max(out["port"], 0.1), 2),
        "lane_error_pct": round(max(out["lane"], 0.1), 2),
        "origin_error_pct": round(max(out["port"], 0.1), 2),
    }


def synth_signal(gross_kg: float, axle_loads_kg: list[float], speed_kmh: float, sampling_khz: float = 5.0, noise_pct: float = 0.6, temperature_c: float = 30.0, seed: int = 3, spacings_m: list[float] | None = None) -> dict:
    """A raw single-row sensor trace for one truck pass, in simulated volts (charge amp output)."""
    rng = np.random.default_rng(seed)
    speed = speed_kmh / 3.6
    fs = sampling_khz * 1000.0
    n_axles = len(axle_loads_kg)
    spacings = spacings_m or ([3.6, 1.35, 7.2, 1.3, 1.3] + [1.3] * 6)[: n_axles - 1]
    pos = np.concatenate([[0.0], np.cumsum(spacings)])
    t_end = (pos[-1] + 3.0) / speed
    t = np.arange(0, t_end, 1.0 / fs)
    v = np.zeros_like(t)
    footprint_t = 0.2 / speed
    drift = 1.0 + (temperature_c - 25.0) * TEMP_COEFF_PCT_PER_C / 100.0
    for p_i, load in zip(pos, axle_loads_kg):
        center = (p_i + 1.0) / speed
        v += drift * (load / 10000.0) * np.exp(-0.5 * ((t - center) / (footprint_t / 2.355)) ** 2)
    noise = rng.standard_normal(len(t)) * noise_pct / 100.0 * max(axle_loads_kg) / 10000.0 * 2.0
    # 50 Hz mains pick-up, a real roadside problem that the filter must handle
    hum = 0.01 * np.sin(2 * np.pi * 50 * t)
    return {"t": t, "v": v + noise + hum, "fs": fs, "speed_ms": speed, "drift": drift}


def edge_pipeline(raw: dict, registered_axles: int, temperature_c: float, plate_ok: bool = True, tag_ok: bool = True, cal_gain: float = 1.0) -> dict:
    """Runs the ten-stage edge pipeline on a raw trace, timing each software stage for real."""
    stages = []

    def stage(name, fn):
        t0 = time.perf_counter()
        out = fn()
        stages.append({"name": name, "ms": round((time.perf_counter() - t0) * 1000.0, 3)})
        return out

    speed = raw["speed_ms"]
    fs = raw["fs"]
    v = stage("Signal acquisition", lambda: raw["v"].astype(np.float32))

    def _filter():
        nyq = fs / 2.0
        cutoff = min(0.45 * nyq, 8.0 * speed / 0.2)
        b, a = signal.butter(4, cutoff / nyq)
        return signal.filtfilt(b, a, v)

    filt = stage("Noise filtering", _filter)

    def _axles():
        peak = max(float(filt.max()), 1e-6)
        peaks, _ = signal.find_peaks(filt, height=0.25 * peak, distance=int(0.8 * fs / speed))
        return peaks

    peaks = stage("Axle detection", _axles)

    def _weights():
        loads = []
        width = int(0.25 / speed * fs)
        for pk in peaks:
            lo, hi = max(0, pk - width), min(len(filt), pk + width)
            area = float(np.trapezoid(filt[lo:hi], dx=1.0 / fs))
            loads.append(area * speed / (0.2 * 1.0645) * 10000.0)
        return loads

    loads = stage("Weight estimation", _weights)
    corr = stage("Temperature and speed correction", lambda: [x / raw["drift"] * cal_gain for x in loads])
    gross = sum(corr)
    cls = stage("Vehicle classification", lambda: f"{len(peaks)}-axle articulated" if len(peaks) >= 4 else f"{len(peaks)}-axle rigid")
    identity = stage("ANPR and RFID matching", lambda: 0.55 * plate_ok + 0.35 * tag_ok + 0.10)

    def _quality():
        residual = float(np.std(v - filt)) / max(float(np.max(filt)), 1e-6)
        q = float(np.clip(1.0 - residual * 3.0, 0, 1))
        if len(peaks) != registered_axles:
            q = min(q, 0.55)
        return q

    quality = stage("Data quality assessment", _quality)
    decision = stage("Clearance decision", lambda: "GREEN" if quality >= 0.6 and identity >= 0.8 else "AMBER")
    stage("Cloud synchronization", lambda: None)
    step = max(1, len(v) // 800)
    return {
        "stages": stages,
        "total_ms": round(sum(s["ms"] for s in stages), 3),
        "axles_detected": int(len(peaks)),
        "axle_estimates_kg": [round(x) for x in corr],
        "gross_estimate_kg": round(gross),
        "classification": cls,
        "identity_confidence": round(float(identity), 2),
        "quality": round(quality, 3),
        "decision_preview": decision,
        "sample_rate_khz": fs / 1000.0,
        "trace": {
            "t_ms": [round(float(x) * 1000.0, 2) for x in raw["t"][::step]],
            "raw_v": [round(float(x), 4) for x in v[::step]],
            "filtered_v": [round(float(x), 4) for x in filt[::step]],
            "peaks_ms": [round(float(raw["t"][p]) * 1000.0, 2) for p in peaks],
        },
    }
