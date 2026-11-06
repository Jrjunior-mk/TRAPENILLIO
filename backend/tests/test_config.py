"""Deployment settings: host database URLs, and the public demo password is refused in production."""
import pytest

from rcs import seed
from rcs.config import Settings
from rcs.seed import DEMO_PASSWORD, seed_password


@pytest.mark.parametrize("given", ["postgresql://u:p@h:5432/d", "postgres://u:p@h:5432/d"])
def test_host_database_urls_use_the_installed_driver(given):
    assert Settings(database_url=given).database_url == "postgresql+psycopg://u:p@h:5432/d"


def test_other_database_urls_are_unchanged():
    assert Settings(database_url="sqlite:///x.db").database_url == "sqlite:///x.db"
    assert Settings(database_url="postgresql+psycopg://u@h/d").database_url == "postgresql+psycopg://u@h/d"


@pytest.mark.parametrize("password", ["", DEMO_PASSWORD])
def test_production_refuses_the_public_password(monkeypatch, password):
    monkeypatch.setattr(seed, "get_settings", lambda: Settings(env="production", seed_password=password))
    with pytest.raises(RuntimeError):
        seed_password()


def test_production_uses_the_private_password(monkeypatch):
    monkeypatch.setattr(seed, "get_settings", lambda: Settings(env="production", seed_password="private-value"))
    assert seed_password() == "private-value"


def test_development_defaults_to_the_demo_password(monkeypatch):
    monkeypatch.setattr(seed, "get_settings", lambda: Settings(env="development", seed_password=""))
    assert seed_password() == DEMO_PASSWORD
