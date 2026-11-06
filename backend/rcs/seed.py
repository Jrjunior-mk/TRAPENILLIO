"""Seeded demonstration data. All plates, names, fleets and loading sites are synthetic and flagged as demo."""
from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .domain.tokens import b64u, new_keypair
from .models import CalibrationRecord, Dispute, Fleet, SettingRow, Site, User, Vehicle
from .security import decrypt_bytes, encrypt_bytes, encrypt_field, hash_password
from .sim.network import PLAZA_DEFS

DEMO_PASSWORD = "rcs-demo-2026"
DEMO_USERS = [
    ("admin", "Asha Mwangi", "admin", "RCS Operations (demo)", None, None),
    ("kenha", "Daniel Otieno", "kenha", "KeNHA, Mariakani cluster (demo role)", None, "mariakani"),
    ("kpa", "Fatuma Said", "kpa", "KPA, Gate-out (demo role)", None, "port_node"),
    ("kra", "Peter Kamau", "kra", "KRA, Customs (demo role)", None, None),
    ("ntsa", "Grace Wanjiru", "ntsa", "NTSA, Records (demo role)", None, None),
    ("transporter", "Hassan Ali", "transporter", "Pwani Demo Haulage", 1, None),
    ("loader", "Mercy Achieng", "loader", "Coast Quarry Node (demo)", None, "origin_quarry"),
    ("viewer", "Observer", "viewer", "Stakeholder observer", None, None),
]
FLEETS = ["Pwani Demo Haulage", "Tsavo Demo Logistics", "Kilindini Demo Carriers", "Likoni Demo Freight", "Nyali Demo Transport", "Voi Demo Movers", "Taita Demo Haulers", "Athi Demo Cargo", "Mazeras Demo Trucking", "Kwale Demo Bulk", "Malindi Demo Lines", "Rabai Demo Freight"]
ORIGIN_TYPES = {"origin_quarry": "quarry", "origin_cement": "cement plant", "origin_depot": "fuel depot"}
FIRST = ["J.", "M.", "A.", "S.", "K.", "W.", "O.", "N."]
LAST = ["Demo-Mutua", "Demo-Omondi", "Demo-Hassan", "Demo-Kiptoo", "Demo-Njeri", "Demo-Salim", "Demo-Wafula", "Demo-Barasa"]


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def seed_all(db: Session, vehicle_count: int = 800) -> bool:
    if db.scalar(select(User).limit(1)):
        return False
    now = now_utc()
    rng = random.Random(2026)
    pw = hash_password(DEMO_PASSWORD)
    for username, name, role, org, fleet, site in DEMO_USERS:
        db.add(User(username=username, display_name=name, role=role, org=org, fleet_id=fleet, site_id=site, password_hash=pw, created_at=now))
    for geom in PLAZA_DEFS:
        priv, pub = new_keypair()
        db.add(Site(id=geom.id, name=geom.name, kind=geom.kind, origin_type=ORIGIN_TYPES.get(geom.id), public_key=b64u(pub), private_key_enc=encrypt_bytes(priv), approved=True, calibration_due=now + timedelta(days=rng.randint(10, 85))))
        for device in (["WIM rows", "Lane per-wheel scales", "Static decks"] if geom.kind == "road" else ["Low-speed scale", "Re-weigh decks"] if geom.kind == "port" else ["Approved scale"]):
            done = now - timedelta(days=rng.randint(5, 80))
            db.add(CalibrationRecord(site=geom.id, device=device, calibrator="Demo Accredited Calibrator Ltd", certificate_no=f"DEMO-CAL-{rng.randrange(10000, 99999)}", performed_at=done, due_at=done + timedelta(days=91), result="PASS", is_demo=True))
    for i, name in enumerate(FLEETS):
        demerits = rng.choice((0, 0, 0, 1, 2, 4, 8)) if i else 2
        db.add(Fleet(id=i + 1, name=name, demerits=demerits, clean_record=demerits == 0, contact_enc=encrypt_field(f"dispatch{i + 1}@example.invalid")))
    db.flush()
    used: set[str] = set()
    for i in range(vehicle_count):
        while True:
            plate = f"K{rng.choice('BCDE')}{rng.choice('ABCDEFGHJKLMNPQRSTUVWXYZ')} {rng.randint(100, 999)}{rng.choice('ABCDEFGHJKLMNPQRSTUVWXYZ')}"
            if plate not in used:
                used.add(plate)
                break
        config = rng.choices(("1-2-3", "1-2-2", "1-2"), weights=(88, 9, 3))[0]
        tare_tr, tare_tl = (8800.0, 7200.0) if config != "1-2" else (9500.0, 0.0)
        length = 17.0 if config != "1-2" else 10.5
        db.add(Vehicle(
            tractor_plate=plate, trailer_plate=f"Z{rng.choice('CDEF')} {rng.randint(1000, 9999)}" if config != "1-2" else None, rfid_tag=f"E200{i:08X}", axle_config=config,
            tractor_tare_kg=tare_tr + rng.randint(-300, 300), trailer_tare_kg=tare_tl + (rng.randint(-200, 200) if tare_tl else 0), height_m=round(rng.uniform(3.9, 4.25), 2), width_m=round(rng.uniform(2.45, 2.6), 2),
            length_m=round(length + rng.uniform(-0.3, 0.4), 2), fleet_id=(i % len(FLEETS)) + 1, permit_ref=f"DEMO-PERMIT-{i:04d}" if rng.random() < 0.01 else None, driver_ref=f"DRV-{i:05d}",
            driver_name_enc=encrypt_field(f"{rng.choice(FIRST)} {rng.choice(LAST)}"), demerits=rng.choice((0, 0, 0, 0, 0, 1, 2, 3)), enrolled=True, created_at=now,
        ))
    db.add(Dispute(created_at=now - timedelta(days=2), fleet_id=1, plate="KDA 100A", event_id=None, reason="Demo: axle-group reading disputed on a re-weigh.", status="OPEN"))
    db.add(SettingRow(key="retention", value={"clearance_days": 90, "anonymize_plates_after_days": 30, "alert_days": 180, "audit_days": 730}))
    db.commit()
    return True


def load_signers(db: Session, registry) -> None:
    for s in db.scalars(select(Site)):
        registry.add_signer(s.id, decrypt_bytes(s.private_key_enc))


def load_vehicle_dicts(db: Session) -> list[dict]:
    fleets = {f.id: f.name for f in db.scalars(select(Fleet))}
    out = []
    for v in db.scalars(select(Vehicle)):
        out.append(vehicle_dict(v, fleets.get(v.fleet_id)))
    return out


def vehicle_dict(v: Vehicle, fleet_name: str | None) -> dict:
    return {"plate": v.tractor_plate, "trailer": v.trailer_plate, "rfid": v.rfid_tag, "config": v.axle_config, "tractor_tare": v.tractor_tare_kg, "trailer_tare": v.trailer_tare_kg, "height": v.height_m, "width": v.width_m, "length": v.length_m, "fleet": fleet_name, "fleet_id": v.fleet_id, "driver": v.driver_ref, "permit": v.permit_ref, "demerits": v.demerits}
