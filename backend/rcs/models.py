"""Relational schema. PostgreSQL in Docker, SQLite for zero-setup local runs. Alembic owns migrations."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeDecorator


class UTCDateTime(TypeDecorator):
    """SQLite drops offsets. This stores every instant as UTC and returns it timezone-aware, on any database."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(32), index=True)
    org: Mapped[str] = mapped_column(String(120))
    fleet_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    site_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime)


class SessionRow(Base):
    __tablename__ = "sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)


class Site(Base):
    __tablename__ = "sites"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(20))  # port | origin | road
    origin_type: Mapped[str | None] = mapped_column(String(40), nullable=True)
    public_key: Mapped[str] = mapped_column(String(64))
    private_key_enc: Mapped[str] = mapped_column(Text)
    approved: Mapped[bool] = mapped_column(Boolean, default=True)
    suspended: Mapped[bool] = mapped_column(Boolean, default=False)
    calibration_due: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    audit_rate_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=True)


class Fleet(Base):
    __tablename__ = "fleets"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    demerits: Mapped[int] = mapped_column(Integer, default=0)
    clean_record: Mapped[bool] = mapped_column(Boolean, default=True)
    contact_enc: Mapped[str | None] = mapped_column(Text, nullable=True)


class Vehicle(Base):
    __tablename__ = "vehicles"
    id: Mapped[int] = mapped_column(primary_key=True)
    tractor_plate: Mapped[str] = mapped_column(String(16), unique=True, index=True)
    trailer_plate: Mapped[str | None] = mapped_column(String(16), nullable=True)
    rfid_tag: Mapped[str | None] = mapped_column(String(32), unique=True, nullable=True)
    axle_config: Mapped[str] = mapped_column(String(12))
    tractor_tare_kg: Mapped[float] = mapped_column(Float)
    trailer_tare_kg: Mapped[float] = mapped_column(Float)
    height_m: Mapped[float] = mapped_column(Float)
    width_m: Mapped[float] = mapped_column(Float)
    length_m: Mapped[float] = mapped_column(Float)
    fleet_id: Mapped[int | None] = mapped_column(ForeignKey("fleets.id"), index=True, nullable=True)
    permit_ref: Mapped[str | None] = mapped_column(String(32), nullable=True)
    driver_ref: Mapped[str | None] = mapped_column(String(32), nullable=True)
    driver_name_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    demerits: Mapped[int] = mapped_column(Integer, default=0)
    enrolled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime)


class Token(Base):
    __tablename__ = "tokens"
    token_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    payload: Mapped[dict] = mapped_column(JSON)
    signature: Mapped[str] = mapped_column(String(128))
    kid: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(12), index=True)
    status_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    tractor_plate: Mapped[str] = mapped_column(String(16), index=True)
    rfid_tag: Mapped[str | None] = mapped_column(String(32), nullable=True)
    container_number: Mapped[str | None] = mapped_column(String(16), nullable=True)
    source: Mapped[str] = mapped_column(String(10), index=True)
    trust_tier: Mapped[int] = mapped_column(Integer)
    origin_station: Mapped[str] = mapped_column(String(40), index=True)
    gross_kg: Mapped[float] = mapped_column(Float)
    issued_at: Mapped[datetime] = mapped_column(UTCDateTime, index=True)
    valid_until: Mapped[datetime] = mapped_column(UTCDateTime)
    origin: Mapped[str] = mapped_column(String(10), default="sim", index=True)  # sim | operator | seed


class TokenEvent(Base):
    __tablename__ = "token_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    token_id: Mapped[str] = mapped_column(String(40), index=True)
    at: Mapped[datetime] = mapped_column(UTCDateTime)
    kind: Mapped[str] = mapped_column(String(20))
    site: Mapped[str | None] = mapped_column(String(40), nullable=True)
    result: Mapped[str | None] = mapped_column(String(12), nullable=True)
    actor: Mapped[str | None] = mapped_column(String(64), nullable=True)
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    origin: Mapped[str] = mapped_column(String(10), default="sim")


class ClearanceEvent(Base):
    __tablename__ = "clearance_events"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    at: Mapped[datetime] = mapped_column(UTCDateTime, index=True)
    truck_ref: Mapped[str] = mapped_column(String(32), index=True)
    plate: Mapped[str] = mapped_column(String(16), index=True)
    stream: Mapped[str] = mapped_column(String(10))
    site: Mapped[str] = mapped_column(String(40), index=True)
    stage: Mapped[str] = mapped_column(String(10))
    outcome: Mapped[str] = mapped_column(String(6), index=True)
    action: Mapped[str] = mapped_column(String(20))
    risk: Mapped[float] = mapped_column(Float)
    confidence: Mapped[float] = mapped_column(Float)
    explanation: Mapped[str] = mapped_column(Text)
    checks: Mapped[list] = mapped_column(JSON)
    measured_gross_kg: Mapped[float | None] = mapped_column(Float, nullable=True)
    axle_loads_kg: Mapped[list | None] = mapped_column(JSON, nullable=True)
    token_id: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    fail_safe: Mapped[bool] = mapped_column(Boolean, default=False)
    offline: Mapped[bool] = mapped_column(Boolean, default=False)
    signature: Mapped[str | None] = mapped_column(String(128), nullable=True)
    kid: Mapped[str | None] = mapped_column(String(40), nullable=True)
    origin: Mapped[str] = mapped_column(String(10), default="sim", index=True)


class OfficerCase(Base):
    __tablename__ = "officer_cases"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, index=True)
    site: Mapped[str] = mapped_column(String(40), index=True)
    plate: Mapped[str] = mapped_column(String(16), index=True)
    truck_ref: Mapped[str] = mapped_column(String(32))
    measured_gross_kg: Mapped[float | None] = mapped_column(Float, nullable=True)
    limit_kg: Mapped[float | None] = mapped_column(Float, nullable=True)
    overload_kg: Mapped[float] = mapped_column(Float, default=0.0)
    fee_usd: Mapped[float] = mapped_column(Float, default=0.0)
    reason: Mapped[str] = mapped_column(Text)
    sealed_transit: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(16), default="PENDING", index=True)
    release_order: Mapped[str | None] = mapped_column(String(40), nullable=True)
    officer: Mapped[str | None] = mapped_column(String(64), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    signature: Mapped[str | None] = mapped_column(String(128), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    origin: Mapped[str] = mapped_column(String(10), default="sim")


class Alert(Base):
    __tablename__ = "alerts"
    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(UTCDateTime, index=True)
    severity: Mapped[str] = mapped_column(String(10), index=True)
    kind: Mapped[str] = mapped_column(String(24), index=True)
    site: Mapped[str | None] = mapped_column(String(40), nullable=True)
    title: Mapped[str] = mapped_column(String(200))
    detail: Mapped[str] = mapped_column(Text, default="")
    ack_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    ack_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    origin: Mapped[str] = mapped_column(String(10), default="sim")


class AuditLog(Base):
    """Tamper-evident: every row chains the hash of the previous row."""

    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(UTCDateTime, index=True)
    actor: Mapped[str] = mapped_column(String(64))
    role: Mapped[str] = mapped_column(String(32))
    action: Mapped[str] = mapped_column(String(64), index=True)
    target: Mapped[str | None] = mapped_column(String(120), nullable=True)
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    prev_hash: Mapped[str] = mapped_column(String(64))
    hash: Mapped[str] = mapped_column(String(64))


class CalibrationRecord(Base):
    __tablename__ = "calibration_records"
    id: Mapped[int] = mapped_column(primary_key=True)
    site: Mapped[str] = mapped_column(String(40), index=True)
    device: Mapped[str] = mapped_column(String(60))
    calibrator: Mapped[str] = mapped_column(String(120))
    certificate_no: Mapped[str] = mapped_column(String(40))
    performed_at: Mapped[datetime] = mapped_column(UTCDateTime)
    due_at: Mapped[datetime] = mapped_column(UTCDateTime)
    result: Mapped[str] = mapped_column(String(20))
    is_demo: Mapped[bool] = mapped_column(Boolean, default=True)


class Dispute(Base):
    __tablename__ = "disputes"
    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, index=True)
    fleet_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    plate: Mapped[str] = mapped_column(String(16))
    event_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="OPEN")
    resolution: Mapped[str | None] = mapped_column(Text, nullable=True)
    resolved_by: Mapped[str | None] = mapped_column(String(64), nullable=True)


class Experiment(Base):
    __tablename__ = "experiments"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    kind: Mapped[str] = mapped_column(String(24), index=True)
    config: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(12), index=True)
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, index=True)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class SettingRow(Base):
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(40), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON)


Index("ix_clearance_site_at", ClearanceEvent.site, ClearanceEvent.at)
