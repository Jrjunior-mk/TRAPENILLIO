"""Engine, sessions and a write-behind queue so the live twin never waits on the database."""
from __future__ import annotations

import queue
import threading
import time
from pathlib import Path
from typing import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings

_engine: Engine | None = None
_Session: sessionmaker | None = None


def get_engine() -> Engine:
    global _engine, _Session
    if _engine is None:
        url = get_settings().database_url
        kwargs: dict = {"future": True, "pool_pre_ping": True}
        if url.startswith("sqlite"):
            Path(url.split("///", 1)[1]).parent.mkdir(parents=True, exist_ok=True)
            kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}
        _engine = create_engine(url, **kwargs)
        if url.startswith("sqlite"):

            @event.listens_for(_engine, "connect")
            def _pragma(conn, _rec):  # WAL lets readers proceed while the write-behind thread commits
                cur = conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA synchronous=NORMAL")
                cur.execute("PRAGMA foreign_keys=ON")
                cur.close()

        _Session = sessionmaker(bind=_engine, expire_on_commit=False, future=True)
    return _engine


def reset_engine() -> None:
    global _engine, _Session
    if _engine is not None:
        _engine.dispose()
    _engine, _Session = None, None


def session_factory() -> sessionmaker:
    get_engine()
    assert _Session is not None
    return _Session


def get_db() -> Iterator[Session]:
    db = session_factory()()
    try:
        yield db
    finally:
        db.close()


class WriteBehind:
    """Batches inserts and updates from the simulation thread. Bulk commit about once a second."""

    def __init__(self) -> None:
        self.q: queue.Queue = queue.Queue()
        self._stop = threading.Event()
        self._idle = threading.Event()
        self._idle.set()
        self._thread: threading.Thread | None = None
        self.written = 0
        self.errors = 0
        self.last_error: str | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="rcs-write-behind", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self.flush()
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=10)

    def add(self, obj) -> None:
        self._idle.clear()
        self.q.put(obj)

    def call(self, fn) -> None:
        """fn(session) runs in order with queued inserts."""
        self._idle.clear()
        self.q.put(fn)

    def flush(self, timeout: float = 15.0) -> None:
        if self._thread is None or not self._thread.is_alive():
            self._drain()
            return
        self._idle.wait(timeout)

    def _drain(self) -> int:
        items = []
        while len(items) < 3000:
            try:
                items.append(self.q.get_nowait())
            except queue.Empty:
                break
        if not items:
            self._idle.set()
            return 0
        Session_ = session_factory()
        with Session_() as db:
            try:
                for it in items:
                    if callable(it):
                        db.flush()
                        it(db)
                    else:
                        db.add(it)
                db.commit()
                self.written += len(items)
            except Exception as exc:  # keep the twin running; surface the error on the health endpoint
                db.rollback()
                self.errors += 1
                self.last_error = str(exc)[:300]
        if self.q.empty():
            self._idle.set()
        return len(items)

    def _run(self) -> None:
        while not self._stop.is_set():
            if self._drain() == 0:
                time.sleep(0.25)
            else:
                time.sleep(0.05)
        self._drain()


write_behind = WriteBehind()
