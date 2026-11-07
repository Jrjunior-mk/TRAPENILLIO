"""Authentication, sessions, permissions, field encryption and the tamper-evident audit chain."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from fastapi import Cookie, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import BASE_DIR, get_settings
from .db import get_db
from .models import AuditLog, SessionRow, User

COOKIE = "rcs_session"

# Role-based access. Portals add row-level scoping, for example a transporter only sees its own fleet.
ROLES = {
    "admin": "RCS administrator",
    "kenha": "KeNHA officer",
    "kpa": "KPA gate operator",
    "kra": "KRA customs officer",
    "ntsa": "NTSA records officer",
    "transporter": "Transporter",
    "loader": "Loading-site operator",
    "viewer": "Read-only observer",
}
# Only the administrator holds everything. Every other role gets its own work and the digital twin. The API enforces
# this: the menus only reflect it.
PERMISSIONS: dict[str, set[str]] = {
    "live.control": {"admin"},
    "live.history": {"admin", "viewer"},
    "faults.inject": {"admin"},
    "sim.run": {"admin"},
    "sim.view": {"admin", "viewer"},
    "twin.details": {"admin", "kenha", "kpa", "kra", "ntsa", "viewer"},
    "truck.register": {"admin", "kenha", "kpa", "transporter", "loader"},
    "truck.view": {"admin", "kenha", "kpa", "kra", "ntsa", "transporter", "loader"},
    "truck.view_all": {"admin", "kenha", "kpa", "kra", "ntsa"},
    "clear.port": {"admin", "kpa"},
    "clear.origin": {"admin", "loader"},
    "clear.road": {"admin", "kenha"},
    "events.view": {"admin"},
    "token.view": {"admin", "kenha", "kpa", "kra", "transporter", "loader"},
    "token.manage": {"admin", "kenha"},
    "site.manage": {"admin"},
    "decisions.view": {"admin"},
    "policy.edit": {"admin"},
    "case.decide": {"admin", "kenha"},
    "calibration.edit": {"admin", "kenha"},
    "dispute.view": {"admin", "kenha", "transporter"},
    "dispute.create": {"admin", "transporter"},
    "dispute.resolve": {"admin", "kenha"},
    "audit.view": {"admin"},
    "admin.users": {"admin"},
    "admin.retention": {"admin"},
    "admin.health": {"admin"},
    "alert.view": {"admin", "kenha", "kpa", "kra", "ntsa", "loader"},
    "alert.ack": {"admin", "kenha", "kpa", "kra", "ntsa", "loader"},
    "lane.view": {"admin", "kenha"},
    "lane.test": {"admin"},
    "sensors.view": {"admin", "kenha"},
    "portal.kenha": {"admin", "kenha"},
    "portal.kpa": {"admin", "kpa"},
    "portal.kra": {"admin", "kra"},
    "portal.ntsa": {"admin", "ntsa"},
    "portal.transporter": {"admin", "transporter"},
    "portal.loader": {"admin", "loader"},
}

# What each role sees in the application. The first page a role lands on is its own dashboard.
HOME = {"kenha": "/portals/kenha", "kpa": "/portals/kpa", "kra": "/portals/kra", "ntsa": "/portals/ntsa", "transporter": "/portals/transporter", "loader": "/portals/loader"}
SECTION_ROLES: dict[str, set[str]] = {
    "command": {"admin", "viewer"},
    "twin": set(ROLES),
    "clearance": {"admin", "kenha", "kpa", "transporter", "loader"},
    "trucks": PERMISSIONS["truck.view"],
    "tokens": PERMISSIONS["token.view"],
    "decisions": {"admin"},
    "lane": PERMISSIONS["lane.view"],
    "sensors": PERMISSIONS["sensors.view"],
    "simulation": {"admin"},
    "analytics": PERMISSIONS["sim.view"],
    "alerts": PERMISSIONS["alert.view"],
    "portals": {"admin"},
    "portal:kenha": PERMISSIONS["portal.kenha"],
    "portal:kpa": PERMISSIONS["portal.kpa"],
    "portal:kra": PERMISSIONS["portal.kra"],
    "portal:ntsa": PERMISSIONS["portal.ntsa"],
    "portal:transporter": PERMISSIONS["portal.transporter"],
    "portal:loader": PERMISSIONS["portal.loader"],
    "portal:admin": {"admin"},
}
PORT_SITE = "port_node"
KRA_ALERT_KINDS = {"overload", "token_mismatch", "identity", "suspicious_fleet", "token"}
NTSA_ALERT_KINDS = {"identity", "suspicious_fleet"}


def sections_for(role: str) -> list[str]:
    return [name for name, roles in SECTION_ROLES.items() if role in roles]


def home_for(role: str) -> str:
    return HOME.get(role, "/")


def alert_visible(user, kind: str | None, site: str | None) -> bool:
    """Which alerts belong to a role. Used for the alert list and for the live stream."""
    role = user.role
    if role in ("admin", "viewer"):
        return True
    if role == "kenha":
        return site != PORT_SITE
    if role == "kpa":
        return site == PORT_SITE
    if role == "kra":
        return kind in KRA_ALERT_KINDS
    if role == "ntsa":
        return kind in NTSA_ALERT_KINDS
    if role == "loader":
        return bool(user.site_id) and site == user.site_id
    return False


def _master_key() -> bytes:
    key = get_settings().master_key
    if key:
        return key.encode()
    path: Path = BASE_DIR / "data" / "master.key"
    if path.exists():
        return path.read_bytes().strip()
    path.parent.mkdir(parents=True, exist_ok=True)
    generated = Fernet.generate_key()
    path.write_bytes(generated)
    return generated


_fernet: Fernet | None = None


def fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_master_key())
    return _fernet


def encrypt_field(text: str | None) -> str | None:
    if text is None:
        return None
    return fernet().encrypt(text.encode()).decode()


def decrypt_field(cipher: str | None) -> str | None:
    if cipher is None:
        return None
    try:
        return fernet().decrypt(cipher.encode()).decode()
    except InvalidToken:
        return None


def encrypt_bytes(raw: bytes) -> str:
    return fernet().encrypt(raw).decode()


def decrypt_bytes(cipher: str) -> bytes:
    return fernet().decrypt(cipher.encode())


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or os.urandom(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(dk).decode()


def verify_password(password: str, stored: str) -> bool:
    try:
        _, salt_b64, dk_b64 = stored.split("$")
        salt, expected = base64.b64decode(salt_b64), base64.b64decode(dk_b64)
    except ValueError:
        return False
    dk = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return hmac.compare_digest(dk, expected)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _signing_key() -> bytes:
    return hashlib.sha256(b"rcs-signed-token-v1" + _master_key()).digest()


def sign_token(username: str, purpose: str, seconds: float) -> str:
    """A token any instance sharing the master key can verify. The purpose stops a ticket being used as a session."""
    body = base64.urlsafe_b64encode(json.dumps({"u": username, "p": purpose, "exp": utcnow().timestamp() + seconds}).encode()).decode().rstrip("=")  # padding would get the cookie quoted
    return f"{body}.{hmac.new(_signing_key(), body.encode(), hashlib.sha256).hexdigest()}"


def read_token(token: str | None, purpose: str) -> str | None:
    try:
        body, signature = (token or "").rsplit(".", 1)
        if not hmac.compare_digest(signature, hmac.new(_signing_key(), body.encode(), hashlib.sha256).hexdigest()):
            return None
        data = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except (ValueError, TypeError):
        return None
    return data["u"] if data.get("p") == purpose and data.get("exp", 0) > utcnow().timestamp() else None


def create_session(db: Session, user: User) -> str:
    if get_settings().serverless:
        return sign_token(user.username, "session", get_settings().session_hours * 3600)
    token = secrets.token_urlsafe(32)
    now = utcnow()
    db.add(SessionRow(token_hash=hashlib.sha256(token.encode()).hexdigest(), user_id=user.id, created_at=now, expires_at=now + timedelta(hours=get_settings().session_hours)))
    db.commit()
    return token


def destroy_session(db: Session, token: str) -> None:
    if get_settings().serverless:
        return  # a signed session ends when the cookie is cleared or it expires
    row = db.get(SessionRow, hashlib.sha256(token.encode()).hexdigest())
    if row:
        db.delete(row)
        db.commit()


def user_from_token(db: Session, token: str | None) -> User | None:
    if not token:
        return None
    if get_settings().serverless:
        username = read_token(token, "session")
        user = db.scalar(select(User).where(User.username == username)) if username else None
        return user if user and user.active else None
    row = db.get(SessionRow, hashlib.sha256(token.encode()).hexdigest())
    if not row or _aware(row.expires_at) < utcnow():
        return None
    user = db.get(User, row.user_id)
    return user if user and user.active else None


def current_user(db: Session = Depends(get_db), rcs_session: str | None = Cookie(default=None)) -> User:
    user = user_from_token(db, rcs_session)
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in required")
    return user


def has_permission(user: User, permission: str) -> bool:
    return user.role in PERMISSIONS.get(permission, set())


def require(permission: str):
    def dep(user: User = Depends(current_user)) -> User:
        if not has_permission(user, permission):
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Your role ({user.role}) does not include {permission}")
        return user

    return dep


def permissions_for(role: str) -> list[str]:
    return sorted(p for p, roles in PERMISSIONS.items() if role in roles)


GENESIS = "0" * 64


def _entry_hash(prev: str, at: datetime, actor: str, role: str, action: str, target: str | None, detail: dict | None) -> str:
    body = json.dumps([prev, _aware(at).strftime("%Y-%m-%dT%H:%M:%S"), actor, role, action, target, detail], sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(body.encode()).hexdigest()


def audit(db: Session, actor: str, role: str, action: str, target: str | None = None, detail: dict | None = None, commit: bool = True) -> AuditLog:
    last = db.scalar(select(AuditLog).order_by(AuditLog.id.desc()).limit(1))
    prev = last.hash if last else GENESIS
    at = utcnow().replace(microsecond=0)
    row = AuditLog(at=at, actor=actor, role=role, action=action, target=target, detail=detail, prev_hash=prev, hash=_entry_hash(prev, at, actor, role, action, target, detail))
    db.add(row)
    if commit:
        db.commit()
    else:
        db.flush()
    return row


def verify_audit_chain(db: Session) -> dict:
    prev = GENESIS
    count = 0
    for row in db.scalars(select(AuditLog).order_by(AuditLog.id)):
        expected = _entry_hash(prev, row.at, row.actor, row.role, row.action, row.target, row.detail)
        if row.prev_hash != prev or row.hash != expected:
            return {"valid": False, "broken_at": row.id, "checked": count}
        prev = row.hash
        count += 1
    return {"valid": True, "checked": count, "head": prev}
