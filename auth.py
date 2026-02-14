"""Benutzerverwaltung mit Einladungscode-System und Admin-Rolle."""

import os
import sqlite3
import uuid
from datetime import datetime
from functools import wraps
from pathlib import Path

from flask import jsonify, session
from werkzeug.security import check_password_hash, generate_password_hash

DB_PATH = Path(__file__).parent / "users.db"


def _get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Datenbank initialisieren, Admin-Account erstellen."""
    conn = _get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            is_admin BOOLEAN NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS invite_codes (
            code TEXT PRIMARY KEY,
            created_by TEXT,
            used_by TEXT,
            created_at TEXT NOT NULL
        );
    """)

    # Migration: is_admin Spalte hinzufügen falls nicht vorhanden
    columns = [row["name"] for row in conn.execute("PRAGMA table_info(users)").fetchall()]
    if "is_admin" not in columns:
        conn.execute("ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT 0")
        conn.commit()

    # Admin-Account erstellen falls nicht vorhanden
    admin_password = os.getenv("ADMIN_PASSWORD")
    if admin_password:
        existing_admin = conn.execute(
            "SELECT id FROM users WHERE username = 'admin'"
        ).fetchone()
        if not existing_admin:
            conn.execute(
                "INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, 1, ?)",
                ("admin", generate_password_hash(admin_password), datetime.now().isoformat()),
            )
            conn.commit()
            print("\n" + "=" * 50)
            print("  Admin-Account erstellt (username: admin)")
            print("=" * 50 + "\n")
    else:
        print("\nWARNUNG: ADMIN_PASSWORD nicht gesetzt - kein Admin-Account erstellt\n")

    conn.close()


def _generate_code() -> str:
    return uuid.uuid4().hex[:8].upper()


def is_admin(username: str) -> bool:
    """Prüfe ob ein User Admin ist."""
    conn = _get_db()
    user = conn.execute(
        "SELECT is_admin FROM users WHERE username = ?", (username,)
    ).fetchone()
    conn.close()
    return bool(user and user["is_admin"])


def register_user(username: str, password: str, invite_code: str) -> dict:
    """Neuen User registrieren mit Einladungscode."""
    if not username or not password or not invite_code:
        raise ValueError("Alle Felder sind erforderlich")

    if len(username) < 3:
        raise ValueError("Benutzername muss mindestens 3 Zeichen lang sein")

    if len(password) < 6:
        raise ValueError("Passwort muss mindestens 6 Zeichen lang sein")

    conn = _get_db()

    # Einladungscode prüfen
    code_row = conn.execute(
        "SELECT * FROM invite_codes WHERE code = ? AND used_by IS NULL",
        (invite_code.strip().upper(),),
    ).fetchone()

    if not code_row:
        conn.close()
        raise ValueError("Ungültiger oder bereits verwendeter Einladungscode")

    # User existiert bereits?
    existing = conn.execute(
        "SELECT id FROM users WHERE username = ?", (username,)
    ).fetchone()
    if existing:
        conn.close()
        raise ValueError("Benutzername bereits vergeben")

    # User erstellen (is_admin=0)
    password_hash = generate_password_hash(password)
    conn.execute(
        "INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, 0, ?)",
        (username, password_hash, datetime.now().isoformat()),
    )

    # Code als verwendet markieren
    conn.execute(
        "UPDATE invite_codes SET used_by = ? WHERE code = ?",
        (username, invite_code.strip().upper()),
    )

    conn.commit()
    conn.close()

    return {"username": username, "is_admin": False}


def verify_user(username: str, password: str) -> dict:
    """User-Login prüfen."""
    if not username or not password:
        raise ValueError("Benutzername und Passwort erforderlich")

    conn = _get_db()
    user = conn.execute(
        "SELECT * FROM users WHERE username = ?", (username,)
    ).fetchone()
    conn.close()

    if not user or not check_password_hash(user["password_hash"], password):
        raise ValueError("Ungültiger Benutzername oder Passwort")

    return {"username": user["username"], "is_admin": bool(user["is_admin"])}


def create_invite_code(created_by: str) -> str:
    """Neuen Einladungscode generieren."""
    code = _generate_code()
    conn = _get_db()
    conn.execute(
        "INSERT INTO invite_codes (code, created_by, created_at) VALUES (?, ?, ?)",
        (code, created_by, datetime.now().isoformat()),
    )
    conn.commit()
    conn.close()
    return code


def login_required(f):
    """Decorator: Route nur für eingeloggte User."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user" not in session:
            return jsonify({"error": "Nicht angemeldet"}), 401
        return f(*args, **kwargs)
    return decorated


def admin_required(f):
    """Decorator: Route nur für Admin-User."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user" not in session:
            return jsonify({"error": "Nicht angemeldet"}), 401
        if not is_admin(session["user"]):
            return jsonify({"error": "Keine Berechtigung"}), 403
        return f(*args, **kwargs)
    return decorated
