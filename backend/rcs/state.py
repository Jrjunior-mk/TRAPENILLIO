"""Process-wide application state: the live engine, the shared config and the experiment job runner."""
from __future__ import annotations

import logging
import traceback
import uuid
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Callable

from sqlalchemy import delete, select

from .config import get_settings
from .db import session_factory, write_behind
from .domain.policy import Policy
from .domain.tokens import parse_iso
from .models import Alert, ClearanceEvent, Experiment, OfficerCase, SettingRow, Site, Token, TokenEvent
from .seed import load_signers, load_vehicle_dicts
from .services.registry import TokenRec
from .sim.live import EAT, LiveEngine
from .sim.params import SimConfig

log = logging.getLogger("rcs.state")


class AppState:
    def __init__(self) -> None:
        self.engine: LiveEngine | None = None
        self.threads = ThreadPoolExecutor(max_workers=3, thread_name_prefix="rcs-job")
        self.procs: ProcessPoolExecutor | None = None
        self.jobs_cancel: set[str] = set()

    def process_pool(self) -> ProcessPoolExecutor | None:
        n = get_settings().worker_processes
        if n <= 0:
            return None
        if self.procs is not None and getattr(self.procs, "_broken", False):
            self.procs = None  # a dead worker poisons the pool for good, so the next job gets a fresh one
        if self.procs is None:
            self.procs = ProcessPoolExecutor(max_workers=n)
        return self.procs

    def init_engine(self) -> LiveEngine:
        Session_ = session_factory()
        with Session_() as db:
            cfg = get_setting(db, "sim_config")
            policy = get_setting(db, "policy")
            vehicles = load_vehicle_dicts(db)
            engine = LiveEngine(cfg=SimConfig(**cfg) if cfg else SimConfig(), persist=True, vehicles=vehicles)
            engine.set_calibration({s.id: s.calibration_due for s in db.scalars(select(Site))})
            # A job cannot outlive the process that ran it.
            for row in db.scalars(select(Experiment).where(Experiment.status == "RUNNING")):
                row.status, row.message = "FAILED", "Interrupted by a server restart"
            db.commit()
            load_signers(db, engine.registry)
            if policy:
                engine.policy = Policy(**policy)
        self.engine = engine
        purge_sim_rows()
        self.reload_operator_tokens()
        return engine

    def reload_operator_tokens(self) -> None:
        """Tokens issued by people survive a simulation reset and a restart; simulated ones do not."""
        Session_ = session_factory()
        with Session_() as db:
            rows = db.scalars(select(Token).where(Token.origin == "operator", Token.status.in_(("ACTIVE", "ISSUED", "SUSPENDED", "FLAGGED"))))
            for r in rows:
                rec = TokenRec(r.token_id, r.payload, r.signature, r.kid, r.status, parse_iso(r.payload["issued_at"]), parse_iso(r.payload["valid_until"]), "operator", reason=r.status_reason)
                self.engine.registry.tokens[rec.token_id] = rec
                self.engine.registry.by_plate[rec.plate] = rec.token_id

    def reset_simulation(self) -> None:
        self.engine.reset()
        write_behind.flush()
        purge_sim_rows()
        self.reload_operator_tokens()

    def persist_config(self, key: str, value: dict) -> None:
        Session_ = session_factory()
        with Session_() as db:
            row = db.get(SettingRow, key)
            if row:
                row.value = value
            else:
                db.add(SettingRow(key=key, value=value))
            db.commit()

    # ------------------------------------------------------------------ jobs
    def submit_job(self, kind: str, name: str, config: dict, actor: str, fn: Callable[[Callable[[float, str], None]], dict]) -> str:
        job_id = f"EXP-{uuid.uuid4().hex[:10].upper()}"
        Session_ = session_factory()
        with Session_() as db:
            db.add(Experiment(id=job_id, name=name, kind=kind, config=config, status="RUNNING", progress=0.0, created_by=actor, created_at=datetime.now(timezone.utc)))
            db.commit()

        last = {"p": -1.0}

        def progress(p: float, msg: str) -> None:
            if p - last["p"] < 0.01 and p < 1.0:
                return
            last["p"] = p
            with Session_() as db2:
                row = db2.get(Experiment, job_id)
                if row:
                    row.progress, row.message = p, msg
                    db2.commit()

        def run() -> None:
            try:
                result = fn(progress)
                status, message = "DONE", "Complete"
            except Exception as exc:  # noqa: BLE001
                log.error("Experiment %s failed: %s", job_id, traceback.format_exc())
                result, status, message = None, "FAILED", str(exc)[:400]
            with Session_() as db3:
                row = db3.get(Experiment, job_id)
                if row:
                    row.status, row.result, row.message, row.progress = status, result, message, 1.0
                    row.finished_at = datetime.now(timezone.utc)
                    db3.commit()

        self.threads.submit(run)
        return job_id


def get_setting(db, key: str) -> dict | None:
    row = db.get(SettingRow, key)
    return row.value if row else None


def purge_sim_rows() -> None:
    """Simulated records are per-run. Operator records stay."""
    Session_ = session_factory()
    with Session_() as db:
        db.execute(delete(ClearanceEvent).where(ClearanceEvent.origin.in_(("sim", "scenario"))))
        db.execute(delete(TokenEvent).where(TokenEvent.origin.in_(("sim", "scenario"))))
        db.execute(delete(Token).where(Token.origin.in_(("sim", "scenario"))))
        db.execute(delete(OfficerCase).where(OfficerCase.origin.in_(("sim", "scenario"))))
        db.execute(delete(Alert).where(Alert.origin == "sim"))
        db.commit()


state = AppState()


def engine() -> LiveEngine:
    assert state.engine is not None
    return state.engine


def eat_now() -> datetime:
    return datetime.now(EAT)
