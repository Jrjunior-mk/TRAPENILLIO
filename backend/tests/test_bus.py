"""MQTT topic semantics, and a broker failure never blocks clearance."""
from rcs.services.bus import EventBus, topic_matches


def test_mqtt_wildcards():
    assert topic_matches("rcs/v1/+/clearance", "rcs/v1/mariakani/clearance")
    assert topic_matches("rcs/#", "rcs/v1/mariakani/token")
    assert not topic_matches("rcs/v1/+/clearance", "rcs/v1/mariakani/token")
    assert not topic_matches("rcs/v1/mariakani", "rcs/v1/mariakani/token")


def test_subscribers_receive_and_counts_kept():
    bus = EventBus()
    got = []
    bus.subscribe("rcs/v1/+/clearance", lambda t, p: got.append((t, p)))
    bus.publish("rcs/v1/mtwapa/clearance", {"id": 1})
    bus.publish("rcs/v1/mtwapa/token", {"id": 2})
    assert len(got) == 1 and bus.published == 2 and bus.by_kind["token"] == 1


def test_broken_broker_is_counted_and_does_not_raise():
    class Broken:
        def publish(self, *a, **k):
            raise OSError("broker down")

    bus = EventBus()
    bus.bridge = Broken()
    bus.publish("rcs/v1/x/clearance", {"id": 1})
    assert bus.bridge_failures == 1 and bus.published == 1
