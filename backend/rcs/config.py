"""Environment-based configuration. Every value can be overridden with an RCS_* environment variable."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="RCS_", env_file=BASE_DIR / ".env", extra="ignore")

    env: str = "development"
    database_url: str = f"sqlite:///{(BASE_DIR / 'data' / 'rcs.db').as_posix()}"
    # Master key for field encryption and wrapping of node signing keys. A development key is generated
    # into data/master.key if this is empty; production deployments must supply one through a secret store.
    master_key: str = ""
    session_hours: int = 12
    cookie_secure: bool = False
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    mqtt_url: str = ""  # e.g. mqtt://mosquitto:1883. Empty = in-process bus only.
    autostart_live: bool = True
    live_prewarm_hours: float = 3.0
    worker_processes: int = 2
    seed_demo: bool = True
    # Function hosts run several short-lived instances that share nothing. Sessions become signed tokens any
    # instance can verify, and each browser tab sends its API calls through its WebSocket, which stays on one instance.
    serverless: bool = False
    # Password for the seeded accounts. Required in production, where the published demo password is refused.
    seed_password: str = ""

    @field_validator("database_url")
    @classmethod
    def use_psycopg_driver(cls, url: str) -> str:
        # Hosts hand out plain postgres URLs, which SQLAlchemy would resolve to a driver that is not installed.
        for prefix in ("postgresql://", "postgres://"):
            if url.startswith(prefix):
                return "postgresql+psycopg://" + url[len(prefix):]
        return url


@lru_cache
def get_settings() -> Settings:
    return Settings()
