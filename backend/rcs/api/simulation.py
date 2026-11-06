"""Four-level simulation environment, experiments and exports."""
from __future__ import annotations

import csv
import io

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Experiment, User
from ..security import audit, current_user, require
from ..services.report import experiment_pdf
from ..sim import montecarlo as MC
from ..sim.l1_sensor import L1Params, accuracy_curves, run_l1, scale_errors
from ..sim.l2_process import METRICS, SCENARIOS, compare, run_replication
from ..sim.l3_traffic import L3Params, run_l3
from ..sim.l4_system import L4Params, run_l4
from ..sim.params import SimConfig
from ..state import engine, state
from .common import iso

router = APIRouter(prefix="/api/sim", tags=["simulation"])


def _cfg(overrides: dict | None) -> SimConfig:
    try:
        return SimConfig(**{**engine().cfg.model_dump(), **(overrides or {})})
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(422, f"Invalid configuration: {exc}") from exc


# ---- L1
@router.post("/l1/run")
def l1_run(p: L1Params, user: User = Depends(require("sim.run"))):
    return run_l1(p)


@router.post("/l1/curves")
def l1_curves(p: L1Params, user: User = Depends(require("sim.run"))):
    return accuracy_curves(p)


@router.post("/l1/derive")
def l1_derive(p: L1Params, user: User = Depends(require("sim.run"))):
    return {"errors": scale_errors(p), "kind": "MODELLED"}


@router.post("/l1/apply")
def l1_apply(p: L1Params, db: Session = Depends(get_db), user: User = Depends(require("live.control"))):
    """The L1 to L2 link: errors derived here become the scale errors in L2 and in the live twin."""
    errors = scale_errors(p)
    cfg = SimConfig(**{**engine().cfg.model_dump(), **errors})
    engine().apply_config(cfg)
    state.persist_config("sim_config", cfg.model_dump())
    audit(db, user.username, user.role, "sim.l1_apply", None, errors)
    return {"errors": errors, "config": cfg.model_dump(), "note": "Applied to L2 and the live twin. Margins follow, because margin = k x error."}


# ---- L2
class L2In(BaseModel):
    config: dict | None = None
    scenarios: list[str] | None = None
    days: int = Field(2, ge=1, le=30)
    engine: str = Field("fast", pattern="^(fast|simpy)$")
    name: str | None = None


@router.post("/l2/run")
def l2_run(body: L2In, user: User = Depends(require("sim.run"))):
    cfg = _cfg(body.config)
    keys = body.scenarios or list(SCENARIOS)
    bad = [k for k in keys if k not in SCENARIOS]
    if bad:
        raise HTTPException(422, f"Unknown scenarios: {bad}")

    def job(progress):
        progress(0.1, "Running the discrete-event chain")
        out = compare(cfg, keys, days=body.days, engine=body.engine)
        out["engine"] = body.engine
        return out

    jid = state.submit_job("l2", body.name or f"L2 comparison ({body.days} d, {body.engine})", cfg.model_dump(), user.username, job)
    return {"job_id": jid}


@router.get("/l2/scenarios")
def l2_scenarios(user: User = Depends(current_user)):
    return {"scenarios": [{"id": s.key, "label": s.label, "note": s.note} for s in SCENARIOS.values()], "metrics": METRICS}


# ---- L3
class L3In(BaseModel):
    params: L3Params = L3Params()
    config: dict | None = None
    scenario: str = "v2_all"
    l2_days: int = Field(3, ge=1, le=15)


@router.post("/l3/run")
def l3_run(body: L3In, user: User = Depends(require("sim.run"))):
    cfg = _cfg(body.config)
    if body.scenario not in SCENARIOS:
        raise HTTPException(422, "Unknown scenario")

    def job(progress):
        progress(0.2, "L2 demand")
        r = run_replication(cfg, body.scenario, days=body.l2_days, detail=True)
        progress(0.7, "Cell-transmission model")
        p = body.params.model_copy(update={"static_lanes": cfg.static_lanes, "static_service_min": cfg.static_service_min(), "lane_capacity_per_h": cfg.lane_capacity_per_h()} if "params" not in body.model_fields_set else {})
        out = run_l3(p, r["demand"][p.station])
        out["l2_link"] = {"scenario": body.scenario, "first_station_lane_pct": r["first_station_lane_pct"], "first_station_static_pct": r["first_station_static_pct"], "road_error_pct": cfg.road_error_pct}
        return out

    jid = state.submit_job("l3", f"L3 traffic: {body.params.station} ({body.scenario})", {**body.params.model_dump(), "scenario": body.scenario}, user.username, job)
    return {"job_id": jid}


# ---- L4
class L4In(BaseModel):
    params: L4Params = L4Params()
    config: dict | None = None
    scenario: str = "v2_all"


@router.post("/l4/run")
def l4_run(body: L4In, user: User = Depends(require("sim.run"))):
    cfg = _cfg(body.config)

    def job(progress):
        progress(0.1, "L2 offered load")
        r = run_replication(cfg, body.scenario, days=1, detail=False)
        trucks = {s: r["stations"][s]["trucks_per_day"] for s in r["stations"]}
        trucks["port_node"] = cfg.trucks_per_day * cfg.shares()[0]
        progress(0.3, "System model")
        out = run_l4(body.params, trucks)
        out["live_system"] = engine().kpi()["system"]
        return out

    jid = state.submit_job("l4", "L4 system model", body.params.model_dump(), user.username, job)
    return {"job_id": jid}


# ---- Linked
class LinkedIn(BaseModel):
    config: dict | None = None
    l1: L1Params | None = None
    apply_l1: bool = True
    station: str = "mariakani"
    scenario: str = "v2_all"
    days: int = Field(2, ge=1, le=10)


@router.post("/linked/run")
def linked_run(body: LinkedIn, user: User = Depends(require("sim.run"))):
    cfg = _cfg(body.config)

    def job(progress):
        progress(0.1, "L1, then L2, L3 and L4")
        return MC.run_linked(cfg, body.l1 or L1Params(), apply_l1=body.apply_l1, station=body.station, days=body.days, scenario=body.scenario)

    jid = state.submit_job("linked", f"Linked L1-L4 ({body.scenario})", cfg.model_dump(), user.username, job)
    return {"job_id": jid}


# ---- Monte Carlo
class MCIn(BaseModel):
    config: dict | None = None
    scenarios: list[str] | None = None
    replications: int = Field(30, ge=2, le=100)
    days: int = Field(30, ge=1, le=60)
    warmup_days: int = Field(2, ge=0, le=10)
    name: str | None = None


@router.post("/monte-carlo")
def mc_run(body: MCIn, user: User = Depends(require("sim.run"))):
    cfg = _cfg(body.config)

    def job(progress):
        return MC.run_monte_carlo(cfg, body.scenarios, body.replications, body.days, body.warmup_days, executor=state.process_pool(), progress=progress)

    jid = state.submit_job("monte_carlo", body.name or f"Monte Carlo {body.replications} x {body.days} d", {**cfg.model_dump(), "replications": body.replications, "days": body.days, "warmup_days": body.warmup_days}, user.username, job)
    return {"job_id": jid}


class TornadoIn(BaseModel):
    config: dict | None = None
    scenario: str = "v2_all"
    days: int = Field(5, ge=1, le=30)
    reps: int = Field(4, ge=1, le=30)


@router.post("/tornado")
def tornado_run(body: TornadoIn, user: User = Depends(require("sim.run"))):
    cfg = _cfg(body.config)

    def job(progress):
        return MC.run_tornado(cfg, body.scenario, days=body.days, reps=body.reps, executor=state.process_pool(), progress=progress)

    jid = state.submit_job("tornado", f"Tornado: {body.scenario}", {**cfg.model_dump(), "scenario": body.scenario}, user.username, job)
    return {"job_id": jid}


# ---- Experiments
def exp_json(e: Experiment, with_result: bool = False) -> dict:
    d = {"id": e.id, "name": e.name, "kind": e.kind, "status": e.status, "progress": e.progress, "message": e.message, "created_by": e.created_by, "created_at": iso(e.created_at), "finished_at": iso(e.finished_at), "config": e.config}
    if with_result:
        d["result"] = e.result
    return d


@router.get("/experiments")
def experiments(kind: str | None = None, limit: int = Query(30, le=100), db: Session = Depends(get_db), user: User = Depends(current_user)):
    stmt = select(Experiment)
    if kind:
        stmt = stmt.where(Experiment.kind == kind)
    rows = db.scalars(stmt.order_by(Experiment.created_at.desc()).limit(limit)).all()
    return {"items": [exp_json(e) for e in rows]}


@router.get("/experiments/{eid}")
def experiment(eid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    e = db.get(Experiment, eid)
    if not e:
        raise HTTPException(404, "Experiment not found")
    return exp_json(e, with_result=True)


@router.delete("/experiments/{eid}")
def experiment_delete(eid: str, db: Session = Depends(get_db), user: User = Depends(require("sim.run"))):
    e = db.get(Experiment, eid)
    if not e:
        raise HTTPException(404, "Experiment not found")
    db.delete(e)
    db.commit()
    return {"ok": True}


def _rows(e: Experiment) -> tuple[list[str], list[list]]:
    r = e.result or {}
    if e.kind == "monte_carlo":
        header = ["scenario", "metric", "mean", "ci95_low", "ci95_high", "n", "kind"]
        rows = []
        for key, s in r.get("scenarios", {}).items():
            for m, v in s["metrics"].items():
                rows.append([s["label"], m, round(v["mean"], 4), round(v["ci_low"], 4), round(v["ci_high"], 4), v["n"], "MODELLED"])
        return header, rows
    if e.kind in ("l2", "linked"):
        src = r.get("l2", r).get("scenarios", {})
        metrics = METRICS + ["truck_hours_saved_per_day"]
        return ["scenario"] + metrics + ["kind"], [[s["label"]] + [round(float(s.get(m, 0.0)), 4) for m in metrics] + ["MODELLED"] for s in src.values()]
    if e.kind == "tornado":
        rows = []
        for m, t in r.get("tables", {}).items():
            for row in t:
                rows.append([m, row["label"], row["low_value"], row["high_value"], round(row["low"], 4), round(row["high"], 4), round(row["swing"], 4), "MODELLED"])
        return ["metric", "factor", "low_input", "high_input", "low_output", "high_output", "swing", "kind"], rows
    flat = [[k, v] for k, v in r.items() if isinstance(v, (int, float, str, bool))]
    return ["field", "value"], flat


@router.get("/experiments/{eid}/export.csv")
def export_csv(eid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    e = db.get(Experiment, eid)
    if not e or not e.result:
        raise HTTPException(404, "No finished result to export")
    header, rows = _rows(e)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([f"# RCS COMMAND experiment {e.id}: {e.name}. MODELLED results from assumed inputs, not measured data."])
    w.writerow(header)
    w.writerows(rows)
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{e.id}.csv"'})


@router.get("/experiments/{eid}/export.pdf")
def export_pdf(eid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    e = db.get(Experiment, eid)
    if not e or not e.result:
        raise HTTPException(404, "No finished result to export")
    return Response(experiment_pdf(e, *_rows(e)), media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="{e.id}.pdf"'})
