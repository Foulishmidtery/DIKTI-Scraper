"""Centralized environment configuration for the Flask API."""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote_plus

from dotenv import dotenv_values, load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = Path(os.environ.get("PDDIKTI_ENV_FILE") or PROJECT_ROOT / ".env")
SECURE_GATEWAY_MODE = os.environ.get("PDDIKTI_SECURE_GATEWAY", "0") == "1"
_DATABASE_ENV_NAMES = {
    "DATABASE_URL",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_HOST",
    "POSTGRES_PORT",
    "DATABASE_POOL_SIZE",
}
_PROCESS_DATABASE_ENV = {name: os.environ.get(name) for name in _DATABASE_ENV_NAMES}
if not SECURE_GATEWAY_MODE:
    load_dotenv(ENV_FILE)


def _database_url() -> str:
    if SECURE_GATEWAY_MODE:
        return ""
    direct_url = os.environ.get("DATABASE_URL", "").strip()
    if direct_url:
        return direct_url

    database = os.environ.get("POSTGRES_DB", "").strip()
    user = os.environ.get("POSTGRES_USER", "").strip()
    if not database or not user:
        return ""

    password = quote_plus(os.environ.get("POSTGRES_PASSWORD", ""))
    host = os.environ.get("POSTGRES_HOST", "127.0.0.1").strip()
    port = os.environ.get("POSTGRES_PORT", "5432").strip()
    return f"postgresql+psycopg://{quote_plus(user)}:{password}@{host}:{port}/{quote_plus(database)}"


@dataclass(frozen=True)
class Settings:
    database_url: str = _database_url()
    database_pool_size: int = max(1, int(os.environ.get("DATABASE_POOL_SIZE", "5")))
    output_dir: Path = Path(os.environ.get("PDDIKTI_OUTPUT_DIR") or PROJECT_ROOT / "output")
    auth_key: str = os.environ.get("PDDIKTI_AUTH_KEY", "").strip()
    frontend_origins: frozenset[str] = frozenset(
        origin.strip().rstrip("/")
        for origin in os.environ.get(
            "PDDIKTI_FRONTEND_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173",
        ).split(",")
        if origin.strip()
    )
    flask_host: str = os.environ.get("FLASK_HOST", "127.0.0.1")
    flask_port: int = int(os.environ.get("FLASK_PORT", "5000"))
    flask_debug: bool = os.environ.get("FLASK_DEBUG", "0") == "1"
    desktop_mode: bool = os.environ.get("PDDIKTI_DESKTOP", "0") == "1"
    secure_gateway: bool = SECURE_GATEWAY_MODE
    gateway_url: str = os.environ.get("PDDIKTI_GATEWAY_URL", "").strip().rstrip("/")
    gateway_jwt_public_key: str = os.environ.get("PDDIKTI_GATEWAY_JWT_PUBLIC_KEY", "").strip()
    desktop_version: str = os.environ.get("PDDIKTI_DESKTOP_VERSION", "2.0.0").strip()
    allow_insecure_gateway: bool = os.environ.get("PDDIKTI_ALLOW_INSECURE_GATEWAY", "0") == "1"
    auto_export: bool = os.environ.get("PDDIKTI_AUTO_EXPORT", "0" if SECURE_GATEWAY_MODE else "1") == "1"


settings = Settings()

_database_env_lock = threading.Lock()
_database_env_mtime: int | None = None


def reload_database_settings_if_changed() -> bool:
    """Reload only PostgreSQL settings when the configured .env file changes."""
    global _database_env_mtime
    if settings.secure_gateway:
        return False
    try:
        mtime = ENV_FILE.stat().st_mtime_ns
    except OSError:
        mtime = -1
    if mtime == _database_env_mtime:
        return False

    with _database_env_lock:
        if mtime == _database_env_mtime:
            return False
        values = dotenv_values(ENV_FILE) if mtime >= 0 else {}

        def value(name: str, default: str = "") -> str:
            raw = values.get(name) if name in values else _PROCESS_DATABASE_ENV.get(name, default)
            return str(raw or "").strip()

        direct_url = value("DATABASE_URL")
        if direct_url:
            database_url = direct_url
        else:
            database = value("POSTGRES_DB")
            user = value("POSTGRES_USER")
            password = quote_plus(value("POSTGRES_PASSWORD"))
            host = value("POSTGRES_HOST", "127.0.0.1")
            port = value("POSTGRES_PORT", "5432")
            database_url = (
                f"postgresql+psycopg://{quote_plus(user)}:{password}@{host}:{port}/{quote_plus(database)}"
                if database and user else ""
            )

        pool_text = value("DATABASE_POOL_SIZE", "5")
        try:
            pool_size = max(1, int(pool_text))
        except ValueError:
            pool_size = 5
        changed = database_url != settings.database_url or pool_size != settings.database_pool_size
        object.__setattr__(settings, "database_url", database_url)
        object.__setattr__(settings, "database_pool_size", pool_size)
        _database_env_mtime = mtime
        return changed
