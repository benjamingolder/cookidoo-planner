"""Benutzerverwaltung mit Einladungscode-System."""

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
    """Datenbank initialisieren und ggf. ersten Einladungscode erstellen."""
    conn = _get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS invite_codes (
            code TEXT PRIMARY KEY,
            created_by TEXT,
            used_by TEXT,
            created_at TEXT NOT NULL
        );
    """)

    # Prüfe ob es bereits Codes gibt
    existing = conn.execute("SELECT COUNT(*) FROM invite_codes").fetchone()[0]
    if existing == 0:
        code = _generate_code()
        conn.execute(
            "INSERT INTO invite_codes (code, created_by, created_at) VALUES (?, ?, ?)",
            (code, "system", datetime.now().isoformat()),
        )
        conn.commit()
        print(f"\n{'='*50}")
        print(f"  Erster Einladungscode: {code}")
        print(f"{'='*50}\n")

    conn.close()


def _generate_code() -> str:
    return uuid.uuid4().hex[:8].upper()


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

    # User erstellen
    password_hash = generate_password_hash(password)
    conn.execute(
        "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
        (username, password_hash, datetime.now().isoformat()),
    )

    # Code als verwendet markieren
    conn.execute(
        "UPDATE invite_codes SET used_by = ? WHERE code = ?",
        (username, invite_code.strip().upper()),
    )

    conn.commit()
    conn.close()

    return {"username": username}


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

    return {"username": user["username"]}


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
