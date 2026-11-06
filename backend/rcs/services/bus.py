"""MQTT-compatible event bus. Topics and wildcards follow MQTT rules so that a real broker can replace it.

By default events stay in process. If RCS_MQTT_URL is set, every event is also published to that broker with paho-mqtt.
A broker that cannot be reached never blocks clearance: publishing is best effort and failures are counted.
"""
from __future__ import annotations

import json
import logging
from collections import Counter
from typing import Callable
from urllib.parse import urlparse

log = logging.getLogger("rcs.bus")


def topic_matches(pattern: str, topic: str) -> bool:
    p, t = pattern.split("/"), topic.split("/")
    for i, part in enumerate(p):
        if part == "#":
            return True
        if i >= len(t):
            return False
        if part != "+" and part != t[i]:
            return False
    return len(p) == len(t)


class EventBus:
    def __init__(self) -> None:
        self.subs: list[tuple[str, Callable[[str, dict], None]]] = []
        self.published = 0
        self.by_kind: Counter = Counter()
        self.bridge = None
        self.bridge_failures = 0

    def connect_bridge(self, url: str) -> None:
        if not url:
            return
        try:
            import paho.mqtt.client as mqtt

            parsed = urlparse(url)
            client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="rcs-command")
            client.connect_async(parsed.hostname or "localhost", parsed.port or 1883)
            client.loop_start()
            self.bridge = client
            log.info("MQTT bridge enabled: %s", url)
        except Exception as exc:  # the app keeps working on the in-process bus
            log.warning("MQTT bridge unavailable: %s", exc)
            self.bridge = None

    def subscribe(self, pattern: str, fn: Callable[[str, dict], None]) -> None:
        self.subs.append((pattern, fn))

    def publish(self, topic: str, payload: dict) -> None:
        self.published += 1
        self.by_kind[topic.rsplit("/", 1)[-1]] += 1
        for pattern, fn in self.subs:
            if topic_matches(pattern, topic):
                fn(topic, payload)
        if self.bridge is not None:
            try:
                self.bridge.publish(topic, json.dumps(payload, default=str), qos=1)
            except Exception:  # noqa: BLE001
                self.bridge_failures += 1

    def stats(self) -> dict:
        return {"published": self.published, "by_kind": dict(self.by_kind), "bridge": bool(self.bridge), "bridge_failures": self.bridge_failures}
