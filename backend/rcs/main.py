"""FastAPI application: migrations, seed, live engine, routes."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import ops, portals, simulation, twin
from .config import BASE_DIR, get_settings
from .db import get_engine, session_factory, write_behind
from .seed import DEMO_PASSWORD, seed_all
from .state import state

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("rcs")


def run_migrations() -> None:
    cfg = Config(str(Path(BASE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(BASE_DIR) / "alembic"))
    cfg.set_main_option("sqlalchemy.url", get_settings().database_url.replace("%", "%%"))
    command.upgrade(cfg, "head")


def bootstrap() -> None:
    settings = get_settings()
    get_engine()
    run_migrations()
    if settings.seed_demo:
        with session_factory()() as db:
            if seed_all(db):
                log.info("Seeded demonstration data. Demo password: %s", DEMO_PASSWORD)
    write_behind.start()
    engine = state.init_engine()
    engine.bus.connect_bridge(settings.mqtt_url)


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    bootstrap()
    engine = state.engine
    if settings.autostart_live:
        # Warm-up so that the twin opens with traffic on the road instead of an empty network
        await asyncio.to_thread(engine.step, settings.live_prewarm_hours * 3600.0)
        engine.control("start")
    task = asyncio.create_task(twin.simulation_loop())
    log.info("RCS COMMAND ready")
    try:
        yield
    finally:
        task.cancel()
        write_behind.stop()
        if state.procs:
            state.procs.shutdown(cancel_futures=True)


app = FastAPI(
    title="RCS COMMAND API",
    version="1.0.0",
    description="Intelligent freight clearance and digital twin for the Rolling Clearance System. Demonstration system: all agency integrations are mocks and all operational data is simulated.",
    lifespan=lifespan,
)
app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in get_settings().cors_origins.split(",") if o.strip()], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
app.include_router(ops.router)
app.include_router(twin.router)
app.include_router(simulation.router)
app.include_router(portals.router)


@app.get("/api/health", tags=["admin"])
def health():
    e = state.engine
    return {"status": "ok" if e else "starting", "mode": "DEMO", "sim_time": e.now.isoformat() if e else None, "running": bool(e and e.running and not e.paused)}
