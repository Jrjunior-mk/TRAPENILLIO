"""Schematic corridor network for the digital twin.

The layout is schematic, not surveyed. Plazas are near true scale (1 scene unit is about 1 m), but the highways between
them are heavily compressed. Travel between sites therefore takes minutes rather than the real half hour, so that
flows are visible on screen. L2 keeps the real travel times; only the twin compresses them.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field


@dataclass
class Polyline:
    id: str
    pts: list[tuple[float, float]]
    lengths: list[float] = field(default_factory=list)
    length: float = 0.0

    def __post_init__(self) -> None:
        self.lengths = [0.0]
        for a, b in zip(self.pts, self.pts[1:]):
            self.lengths.append(self.lengths[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
        self.length = self.lengths[-1]

    def at(self, s: float) -> tuple[float, float, float]:
        """Returns x, z and heading (radians) at arc length s."""
        s = max(0.0, min(s, self.length))
        lengths = self.lengths
        # small polylines: linear scan is fast enough and allocation free
        i = 0
        n = len(lengths) - 2
        while i < n and lengths[i + 1] < s:
            i += 1
        a, b = self.pts[i], self.pts[i + 1]
        seg = lengths[i + 1] - lengths[i]
        t = (s - lengths[i]) / seg if seg > 0 else 0.0
        return a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, math.atan2(b[1] - a[1], b[0] - a[0])


def smooth(pts: list[tuple[float, float]], iterations: int = 2) -> list[tuple[float, float]]:
    """Chaikin corner cutting. Endpoints stay fixed."""
    for _ in range(iterations):
        out = [pts[0]]
        for a, b in zip(pts, pts[1:]):
            out.append((a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25))
            out.append((a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75))
        out.append(pts[-1])
        pts = out
    return pts


class Frame:
    """Local plaza frame: u runs along the road from P to Q, v is lateral."""

    def __init__(self, p: tuple[float, float], q: tuple[float, float], side: float):
        self.p = p
        dx, dz = q[0] - p[0], q[1] - p[1]
        self.length = math.hypot(dx, dz)
        self.ux, self.uz = dx / self.length, dz / self.length
        self.vx, self.vz = -self.uz * side, self.ux * side

    def w(self, u: float, v: float = 0.0) -> tuple[float, float]:
        return (round(self.p[0] + self.ux * u + self.vx * v, 2), round(self.p[1] + self.uz * u + self.vz * v, 2))


@dataclass
class PlazaGeom:
    id: str
    name: str
    kind: str  # port | origin | road
    p: tuple[float, float]
    q: tuple[float, float]
    side: float
    has_lane: bool
    bays: int
    frame: Frame = field(init=False)
    tracks: dict[str, Polyline] = field(default_factory=dict)
    bay_tracks: list[Polyline] = field(default_factory=list)
    devices: dict[str, dict] = field(default_factory=dict)

    def __post_init__(self) -> None:
        f = self.frame = Frame(self.p, self.q, self.side)
        L = f.length
        # Key stations along the road, scaled to the plaza length
        s_at = 0.17 * L  # sensor rows
        g_at = 0.30 * L  # gantry, 250-400 m after the sensors at true scale in RCS v1; compressed here
        m_at = 0.70 * L  # where lane traffic merges back
        self.tracks["approach"] = Polyline(f"{self.id}.approach", [f.w(0), f.w(s_at)])
        self.tracks["to_gantry"] = Polyline(f"{self.id}.to_gantry", [f.w(s_at), f.w(g_at)])
        self.tracks["main_out"] = Polyline(f"{self.id}.main_out", [f.w(g_at), f.w(m_at)])
        self.tracks["merge"] = Polyline(f"{self.id}.merge", [f.w(m_at), f.w(L)])
        v_lane = 24.0
        z0, z1 = g_at + 0.09 * L, g_at + 0.30 * L  # measuring zone
        if self.has_lane:
            self.tracks["lane_approach"] = Polyline(f"{self.id}.lane_approach", smooth([f.w(g_at), f.w(g_at + 0.05 * L, v_lane * 0.8), f.w(z0, v_lane)]))
            self.tracks["lane_zone"] = Polyline(f"{self.id}.lane_zone", [f.w(z0, v_lane), f.w(z1, v_lane)])
            self.tracks["lane_exit"] = Polyline(f"{self.id}.lane_exit", smooth([f.w(z1, v_lane), f.w(m_at - 0.06 * L, v_lane), f.w(m_at - 0.01 * L, 5), f.w(m_at)]))
            branch = (z1, v_lane)
        else:
            branch = (g_at, 0.0)
        # Static or re-weigh queue, then a bank of bays, then a collector back to the road
        v_q = v_lane + 22.0
        q0 = branch[0] + 0.05 * L
        q1 = 0.78 * L
        self.tracks["queue"] = Polyline(f"{self.id}.queue", smooth([f.w(*branch), f.w(q0, v_q)]) + [f.w(q1, v_q)])
        bay_u0 = q1 + 0.03 * L
        bay_u1 = bay_u0 + max(26.0, 0.07 * L)
        spacing = 9.0
        self.bay_tracks = []
        for i in range(self.bays):
            v = v_q - spacing * (self.bays - 1) / 2.0 + spacing * i + 4.0 * (self.bays - 1)
            self.bay_tracks.append(Polyline(f"{self.id}.bay{i}", [f.w(q1, v_q), f.w(bay_u0, v), f.w(bay_u1, v)]))
        col_u = bay_u1 + 6.0
        v_far = v_q + 4.0 * (self.bays - 1) + spacing * (self.bays - 1) / 2.0
        self.tracks["collector"] = Polyline(f"{self.id}.collector", smooth([f.w(bay_u1, v_far), f.w(col_u, v_far), f.w(col_u + 2, v_q - 12), f.w(min(L - 2, col_u + 26), 4), f.w(L, 0)]))
        self.tracks["bay_exit"] = self.tracks["collector"]
        # Device positions for the twin
        d = self.devices
        d["sensor_rows"] = _pt(f, s_at, 0)
        d["gantry"] = _pt(f, g_at, 0)
        d["anpr"] = _pt(f, s_at - 0.05 * L, -9)
        d["rfid"] = _pt(f, s_at - 0.015 * L, -9)
        d["lidar"] = _pt(f, s_at + 0.02 * L, 0)
        d["cabinet"] = _pt(f, s_at, -18)
        d["control_room"] = _pt(f, 0.32 * L, -34)
        if self.has_lane:
            d["lane_zone"] = {**_pt(f, (z0 + z1) / 2, v_lane), "length": z1 - z0}
            d["lane_lidar"] = _pt(f, z0 + 0.65 * (z1 - z0), v_lane)
            d["lane_anpr"] = _pt(f, z0 - 4, v_lane + 8)
            d["lane_rfid"] = _pt(f, z0 + 2, v_lane + 8)
        d["bays"] = [_pt(f, (bay_u0 + bay_u1) / 2 + 2, self.bay_tracks[i].pts[-1] and (v_q - spacing * (self.bays - 1) / 2.0 + spacing * i + 4.0 * (self.bays - 1))) for i in range(self.bays)]
        d["hold"] = _pt(f, q1 - 0.1 * L, v_q + 16)

    def bay_track(self, i: int) -> Polyline:
        return self.bay_tracks[i]


def _pt(f: Frame, u: float, v: float) -> dict:
    x, z = f.w(u, v)
    return {"x": x, "z": z, "heading": round(math.atan2(f.uz, f.ux), 4)}


PLAZA_DEFS = [
    PlazaGeom("port_node", "Mombasa Port Gate-Out Node", "port", (560.0, 420.0), (250.0, 200.0), 1.0, False, 6),
    PlazaGeom("dongo_kundu", "Dongo Kundu Screening Station", "road", (20.0, 430.0), (-340.0, 320.0), 1.0, True, 4),
    PlazaGeom("mariakani", "Mariakani Weighbridge", "road", (-720.0, 70.0), (-1120.0, -70.0), 1.0, True, 8),
    PlazaGeom("mtwapa", "Mtwapa Weighing Station", "road", (500.0, -300.0), (780.0, -610.0), -1.0, True, 4),
    PlazaGeom("origin_quarry", "Coast Quarry Node (demo)", "origin", (130.0, -640.0), (340.0, -470.0), -1.0, False, 2),
    PlazaGeom("origin_cement", "Cement Works Node (demo)", "origin", (-720.0, -520.0), (-600.0, -300.0), -1.0, False, 2),
    PlazaGeom("origin_depot", "Fuel Depot Node (demo)", "origin", (90.0, 90.0), (120.0, 330.0), 1.0, False, 2),
]
PLAZAS: dict[str, PlazaGeom] = {p.id: p for p in PLAZA_DEFS}


def _edge(pid: str, pts: list[tuple[float, float]], minutes: float, lanes: int = 2) -> "Edge":
    return Edge(Polyline(pid, smooth(pts, 3)), minutes, lanes)


@dataclass
class Edge:
    line: Polyline
    minutes: float
    lanes: int = 2


J1 = (170.0, 170.0)
J2 = (-500.0, 200.0)
_p = PLAZAS
EDGES: dict[str, Edge] = {
    e.line.id: e
    for e in [
        _edge("yard_gate", [(760.0, 610.0), (690.0, 540.0), (620.0, 480.0), _p["port_node"].p], 1.2),
        _edge("gate_j1", [_p["port_node"].q, (210.0, 180.0), J1], 0.8),
        _edge("j1_dk", [J1, (120.0, 280.0), (80.0, 400.0), _p["dongo_kundu"].p], 2.5),
        _edge("dk_j2", [_p["dongo_kundu"].q, (-430.0, 290.0), J2], 2.0),
        _edge("j2_mk", [J2, (-610.0, 130.0), _p["mariakani"].p], 2.0),
        _edge("mk_exit", [_p["mariakani"].q, (-1320.0, -130.0), (-1620.0, -280.0), (-1900.0, -400.0)], 4.0),
        _edge("j1_mt", [J1, (260.0, 40.0), (360.0, -130.0), _p["mtwapa"].p], 3.0),
        _edge("mt_exit", [_p["mtwapa"].q, (900.0, -760.0), (1040.0, -960.0)], 2.5),
        _edge("quarry_mt", [(30.0, -720.0), (70.0, -690.0), _p["origin_quarry"].p], 0.8, 1),
        _edge("quarry_link", [_p["origin_quarry"].q, (420.0, -400.0), _p["mtwapa"].p], 1.2, 1),
        _edge("mt_mk_link", [_p["mtwapa"].q, (820.0, -660.0), (480.0, -760.0), (-200.0, -420.0), (-600.0, -120.0), (-690.0, 40.0), _p["mariakani"].p], 6.0),
        _edge("cement_in", [(-780.0, -620.0), (-750.0, -570.0), _p["origin_cement"].p], 0.8, 1),
        _edge("cement_mk", [_p["origin_cement"].q, (-600.0, -120.0), (-690.0, 40.0), _p["mariakani"].p], 2.5, 1),
        _edge("depot_in", [(70.0, -10.0), (80.0, 40.0), _p["origin_depot"].p], 0.8, 1),
        _edge("depot_dk", [_p["origin_depot"].q, (100.0, 390.0), _p["dongo_kundu"].p], 1.2, 1),
        _edge("kwale_dk", [(-120.0, 760.0), (-60.0, 620.0), (-20.0, 500.0), _p["dongo_kundu"].p], 3.0, 1),
        _edge("kaloleni_mk", [(-1050.0, 560.0), (-920.0, 300.0), (-800.0, 150.0), _p["mariakani"].p], 3.5, 1),
        _edge("north_mt", [(760.0, -60.0), (620.0, -180.0), _p["mtwapa"].p], 2.0, 1),
    ]
}

# Route = sequence of edge ids and plaza ids in travel order. Weights are schematic and match the L2 route table.
ROUTES: dict[str, list[str]] = {
    "port_nairobi": ["yard_gate", "@port_node", "gate_j1", "j1_dk", "@dongo_kundu", "dk_j2", "j2_mk", "@mariakani", "mk_exit"],
    "port_malindi": ["yard_gate", "@port_node", "gate_j1", "j1_mt", "@mtwapa", "mt_exit"],
    "quarry_nairobi": ["quarry_mt", "@origin_quarry", "quarry_link", "@mtwapa", "mt_mk_link", "@mariakani", "mk_exit"],
    "cement_nairobi": ["cement_in", "@origin_cement", "cement_mk", "@mariakani", "mk_exit"],
    "depot_nairobi": ["depot_in", "@origin_depot", "depot_dk", "@dongo_kundu", "dk_j2", "j2_mk", "@mariakani", "mk_exit"],
    "spot_kwale": ["kwale_dk", "@dongo_kundu", "dk_j2", "j2_mk", "@mariakani", "mk_exit"],
    "spot_north": ["north_mt", "@mtwapa", "mt_mk_link", "@mariakani", "mk_exit"],
    "spot_kaloleni": ["kaloleni_mk", "@mariakani", "mk_exit"],
}
ROUTE_DEST = {
    "port_nairobi": "Nairobi via Northern Corridor",
    "port_malindi": "Malindi",
    "quarry_nairobi": "Nairobi via Northern Corridor",
    "cement_nairobi": "Nairobi via Northern Corridor",
    "depot_nairobi": "Nairobi via Northern Corridor",
    "spot_kwale": "Nairobi via Northern Corridor",
    "spot_north": "Nairobi via Northern Corridor",
    "spot_kaloleni": "Nairobi via Northern Corridor",
}
LANDMARKS = {
    "port": {"x": 880.0, "z": 720.0, "label": "Port of Mombasa (schematic)"},
    "exit_north": {"x": -1900.0, "z": -400.0, "label": "To Nairobi: Northern Corridor"},
    "exit_malindi": {"x": 1040.0, "z": -960.0, "label": "To Malindi"},
}


def network_json() -> dict:
    return {
        "schematic": True,
        "note": "Schematic layout. Plazas are near true scale; highways between them are compressed.",
        "edges": [{"id": k, "pts": e.line.pts, "lanes": e.lanes} for k, e in EDGES.items()],
        "plazas": [
            {
                "id": p.id,
                "name": p.name,
                "kind": p.kind,
                "p": p.p,
                "q": p.q,
                "side": p.side,
                "has_lane": p.has_lane,
                "bays": p.bays,
                "tracks": {k: t.pts for k, t in p.tracks.items()},
                "bay_tracks": [t.pts for t in p.bay_tracks],
                "devices": p.devices,
            }
            for p in PLAZA_DEFS
        ],
        "landmarks": LANDMARKS,
    }
