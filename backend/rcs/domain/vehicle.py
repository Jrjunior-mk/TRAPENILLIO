"""Axle configuration, group loads, expected gross weight, ISO 6346 container check digit."""
from __future__ import annotations

import re
from dataclasses import dataclass

from .policy import Policy

# Axle configuration = axles per group, front to back, e.g. "1-2-3" is steer + tandem drive + tridem trailer.
GROUP_NAME = {1: "single", 2: "tandem", 3: "tridem"}
AXLE_CONFIGS = ["1-1", "1-2", "1-1-2", "1-2-2", "1-2-3"]


@dataclass(frozen=True)
class Group:
    kind: str
    axles: int
    limit_kg: float


def axle_count(config: str) -> int:
    return sum(int(p) for p in config.split("-"))


def groups_for(config: str, policy: Policy) -> list[Group]:
    out: list[Group] = []
    for i, part in enumerate(config.split("-")):
        n = int(part)
        kind = "steer" if i == 0 and n == 1 else GROUP_NAME[n]
        out.append(Group(kind, n, policy.group_limit(kind)))
    return out


def group_loads(axle_loads: list[float], config: str) -> list[float]:
    loads, i = [], 0
    for part in config.split("-"):
        n = int(part)
        loads.append(sum(axle_loads[i : i + n]))
        i += n
    return loads


def gross_limit_for(config: str, policy: Policy) -> float:
    n = axle_count(config)
    return min(policy.gross_limit(n), sum(g.limit_kg for g in groups_for(config, policy)))


def effective_config_with_lift(config: str, lifted: int = 1) -> str:
    """The configuration a lifted rear axle turns the vehicle into, e.g. 1-2-3 becomes 1-2-2."""
    parts = [int(p) for p in config.split("-")]
    parts[-1] = max(1, parts[-1] - lifted)
    return "-".join(str(p) for p in parts)


def expected_gross_kg(tractor_tare: float, trailer_tare: float, container_tare: float, declared_cargo: float) -> float:
    """Expected gross weight = truck and trailer tare + container tare + declared cargo (RCS v2, 6.3)."""
    return tractor_tare + trailer_tare + container_tare + declared_cargo


def variance_pct(measured: float, reference: float) -> float:
    if reference <= 0:
        raise ValueError("reference weight must be positive")
    return abs(measured - reference) / reference * 100.0


_LETTER_VALUES: dict[str, int] = {}
_v = 10
for _c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
    if _v % 11 == 0:
        _v += 1
    _LETTER_VALUES[_c] = _v
    _v += 1


def container_check_digit(code10: str) -> int:
    total = 0
    for i, ch in enumerate(code10):
        val = _LETTER_VALUES[ch] if ch.isalpha() else int(ch)
        total += val * (2**i)
    return (total % 11) % 10


def container_valid(number: str | None) -> bool:
    if not number or not re.fullmatch(r"[A-Z]{3}[UJZ]\d{7}", number):
        return False
    return container_check_digit(number[:10]) == int(number[10])


def make_container(owner: str, serial: int) -> str:
    """Builds a container number with a correct ISO 6346 check digit (demonstration data)."""
    code = f"{owner[:3]}U{serial:06d}"
    return code + str(container_check_digit(code))
