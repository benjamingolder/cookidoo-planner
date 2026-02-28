"""Cookidoo Wochenplan-Generator - Flask Web-App."""

import asyncio
import logging
import os
import threading
from dataclasses import dataclass, field

from dotenv import load_dotenv

logging.basicConfig(
    filename=os.getenv("LOG_FILE", "/home/benjamin/cookidoo-planner/debug.log"),
    level=logging.DEBUG,
    format="%(asctime)s %(message)s",
)
log = logging.getLogger("cookidoo")
from flask import Flask, jsonify, render_template, request, session

from auth import (
    admin_required, clear_cookidoo_credentials, create_invite_code,
    delete_invite_code, delete_user, get_all_users, get_cookidoo_credentials,
    get_invite_codes, get_user_filters, init_db, is_admin, login_required,
    register_user, reset_user_password, save_cookidoo_credentials,
    save_user_filters, verify_user,
)
from planner import CookidooPlanner

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", os.urandom(24))

# Persistenter Event-Loop in eigenem Thread
_loop = asyncio.new_event_loop()
_loop_thread = threading.Thread(target=_loop.run_forever, daemon=True)
_loop_thread.start()


@dataclass
class UserSession:
    planner: CookidooPlanner = field(default_factory=CookidooPlanner)
    current_plan: dict = field(default_factory=dict)


# Pro-User Sessions
_user_sessions: dict[str, UserSession] = {}


def get_user_session(username: str) -> UserSession:
    """Session für einen User holen oder erstellen."""
    if username not in _user_sessions:
        _user_sessions[username] = UserSession()
    return _user_sessions[username]


# Datenbank initialisieren
init_db()


def run_async(coro):
    """Async-Coroutine im persistenten Event-Loop ausführen."""
    future = asyncio.run_coroutine_threadsafe(coro, _loop)
    return future.result(timeout=120)


def cookidoo_route(f):
    """Decorator: Route nur für eingeloggte Nicht-Admin User."""
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user" not in session:
            return jsonify({"error": "Nicht angemeldet"}), 401
        if is_admin(session["user"]):
            return jsonify({"error": "Admin kann Cookidoo nicht nutzen"}), 403
        return f(*args, **kwargs)
    return decorated


# ===== Auth-Routen =====

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/auth/status", methods=["GET"])
def api_auth_status():
    if "user" in session:
        return jsonify({
            "logged_in": True,
            "username": session["user"],
            "is_admin": is_admin(session["user"]),
        })
    return jsonify({"logged_in": False})


@app.route("/api/auth/login", methods=["POST"])
def api_auth_login():
    data = request.get_json() or {}
    try:
        result = verify_user(data.get("username", ""), data.get("password", ""))
        session["user"] = result["username"]
        return jsonify({"success": True, **result})
    except ValueError as e:
        return jsonify({"error": str(e)}), 401


@app.route("/api/auth/register", methods=["POST"])
def api_auth_register():
    data = request.get_json() or {}
    try:
        result = register_user(
            data.get("username", ""),
            data.get("password", ""),
            data.get("invite_code", ""),
        )
        session["user"] = result["username"]
        return jsonify({"success": True, **result})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/auth/logout", methods=["POST"])
def api_auth_logout():
    username = session.pop("user", None)
    # User-Session aufräumen
    if username and username in _user_sessions:
        us = _user_sessions.pop(username)
        try:
            run_async(us.planner.close())
        except Exception:
            pass
    return jsonify({"success": True})


@app.route("/api/auth/invite", methods=["POST"])
@admin_required
def api_auth_invite():
    code = create_invite_code(session["user"])
    return jsonify({"success": True, "code": code})


# ===== Admin-Routen =====

@app.route("/api/admin/users", methods=["GET"])
@admin_required
def api_admin_users():
    users = get_all_users()
    return jsonify({"success": True, "users": users})


@app.route("/api/admin/users/<int:user_id>", methods=["DELETE"])
@admin_required
def api_admin_delete_user(user_id):
    try:
        delete_user(user_id)
        # Aktive Session des gelöschten Users aufräumen
        for username, us in list(_user_sessions.items()):
            # Wir räumen alle auf, die nicht mehr existieren
            pass
        return jsonify({"success": True})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/admin/users/<int:user_id>/reset-password", methods=["POST"])
@admin_required
def api_admin_reset_password(user_id):
    data = request.get_json() or {}
    new_password = data.get("password", "")
    try:
        reset_user_password(user_id, new_password)
        return jsonify({"success": True})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/admin/invites", methods=["GET"])
@admin_required
def api_admin_invites():
    codes = get_invite_codes()
    return jsonify({"success": True, "codes": codes})


@app.route("/api/admin/invites/<code>", methods=["DELETE"])
@admin_required
def api_admin_delete_invite(code):
    try:
        delete_invite_code(code)
        return jsonify({"success": True})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


# ===== Cookidoo-Routen =====

@app.route("/api/login", methods=["POST"])
@cookidoo_route
def api_login():
    data = request.get_json()
    email = data.get("email", "")
    password = data.get("password", "")
    country = data.get("country", "de")
    language = data.get("language", "de-DE")

    if not email or not password:
        return jsonify({"error": "E-Mail und Passwort erforderlich"}), 400

    us = get_user_session(session["user"])

    try:
        result = run_async(us.planner.login(email, password, country, language))
        return jsonify({"success": True, **result})
    except Exception as e:
        return jsonify({"error": f"Login fehlgeschlagen: {e}"}), 401


@app.route("/api/collections", methods=["POST"])
@cookidoo_route
def api_load_collections():
    us = get_user_session(session["user"])
    try:
        result = run_async(us.planner.load_collections())
        log.info(f"[{session['user']}] Collections geladen: {result}")
        return jsonify({"success": True, **result})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"Sammlungen laden fehlgeschlagen: {e}"}), 500


@app.route("/api/generate", methods=["POST"])
@cookidoo_route
def api_generate():
    us = get_user_session(session["user"])
    data = request.get_json() or {}
    # day_slots: {dayIdx: ["m","a","m_v","m_d","a_v","a_d"]}
    day_slots_raw = data.get("day_slots", {str(i): ["m"] for i in range(7)})
    day_slots = {int(k): v for k, v in day_slots_raw.items()}
    custom_ratio = data.get("custom_ratio", 70)
    exclude_ids = data.get("exclude_ids", [])
    categories = data.get("categories", [])
    cuisines = data.get("cuisines", [])
    languages = data.get("languages", [])
    preferred_ingredients = data.get("preferred_ingredients", [])
    exclude_ingredients = data.get("exclude_ingredients", [])
    max_time_per_slot = data.get("max_time_per_slot", {"m": None, "a": None})

    try:
        if categories or cuisines or preferred_ingredients or languages:
            run_async(us.planner.search_with_filters(categories, cuisines, preferred_ingredients, languages))

        plan = run_async(us.planner.generate_plan(
            day_slots, custom_ratio, exclude_ids, max_time_per_slot, exclude_ingredients, languages
        ))
        us.current_plan = {}
        for day_name, slots in plan.items():
            us.current_plan[day_name] = {sk: r.to_dict() if r else None for sk, r in slots.items()}

        log.info(f"[{session['user']}] Plan: {list(us.current_plan.keys())}")
        return jsonify({"success": True, "plan": us.current_plan})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"Plan generieren fehlgeschlagen: {e}"}), 500


@app.route("/api/regenerate-day", methods=["POST"])
@cookidoo_route
def api_regenerate_day():
    us = get_user_session(session["user"])
    data = request.get_json() or {}
    day_name = data.get("day")
    slot_key = data.get("slot_key", "m")  # "m", "a", "m_v", "m_d", "a_v", "a_d"
    custom_ratio = data.get("custom_ratio", 70)
    max_time_minutes = data.get("max_time_minutes")
    categories = data.get("categories", [])
    cuisines = data.get("cuisines", [])
    languages = data.get("languages", [])
    preferred_ingredients = data.get("preferred_ingredients", [])
    exclude_ingredients = data.get("exclude_ingredients", [])
    # Per-day override (optional)
    override_category = data.get("override_category", "")
    override_cuisine = data.get("override_cuisine", "")

    # Effektive Kategorie/Küche bestimmen
    eff_categories = [override_category] if override_category else categories
    eff_cuisines = [override_cuisine] if override_cuisine else cuisines

    # Slot-Typ bestimmen
    slot_type = "starter" if "_v" in slot_key else "dessert" if "_d" in slot_key else "main"

    # Aktuell geplante Rezepte ausschliessen (ausser dem neu zu würfelnden)
    exclude_ids = []
    for d, slots in us.current_plan.items():
        for sk, r in slots.items():
            if r is not None and not (d == day_name and sk == slot_key):
                exclude_ids.append(r["id"])

    try:
        if eff_categories or eff_cuisines or preferred_ingredients or languages:
            run_async(us.planner.search_with_filters(eff_categories, eff_cuisines, preferred_ingredients, languages))

        recipe = run_async(us.planner.generate_single(
            custom_ratio, exclude_ids, max_time_minutes, slot_type, exclude_ingredients, languages
        ))

        if day_name not in us.current_plan:
            us.current_plan[day_name] = {}

        if recipe:
            us.current_plan[day_name][slot_key] = recipe.to_dict()

        return jsonify({"success": True, "recipe": us.current_plan[day_name].get(slot_key)})
    except Exception as e:
        return jsonify({"error": f"Rezept generieren fehlgeschlagen: {e}"}), 500


@app.route("/api/save", methods=["POST"])
@cookidoo_route
def api_save():
    us = get_user_session(session["user"])
    data = request.get_json() or {}
    week_offset = data.get("week_offset", 0)
    clear_first = data.get("clear_first", False)

    if not us.current_plan:
        return jsonify({"error": "Kein Plan vorhanden"}), 400

    add_to_shopping_list = data.get("add_to_shopping_list", False)

    try:
        if clear_first:
            run_async(us.planner.clear_calendar_week(week_offset))

        result = run_async(us.planner.save_to_calendar(us.current_plan, week_offset, add_to_shopping_list))

        return jsonify({"success": True, **result})
    except Exception as e:
        return jsonify({"error": f"Speichern fehlgeschlagen: {e}"}), 500


# ===== Filter (serverseitig gespeichert pro User) =====

@app.route("/api/filters", methods=["GET"])
@login_required
def api_get_filters():
    filters = get_user_filters(session["user"])
    if filters:
        return jsonify({"success": True, "filters": filters})
    return jsonify({"success": True, "filters": None})


@app.route("/api/filters", methods=["POST"])
@login_required
def api_save_filters():
    filters = request.get_json() or {}
    save_user_filters(session["user"], filters)
    return jsonify({"success": True})


# ===== Cookidoo-Zugangsdaten (gespeichert pro User) =====

@app.route("/api/cookidoo-credentials", methods=["GET"])
@cookidoo_route
def api_get_cookidoo_credentials():
    creds = get_cookidoo_credentials(session["user"])
    if creds:
        return jsonify({"has_credentials": True, **creds})
    return jsonify({"has_credentials": False})


@app.route("/api/cookidoo-credentials", methods=["POST"])
@cookidoo_route
def api_save_cookidoo_credentials():
    data = request.get_json() or {}
    email = data.get("email", "")
    password = data.get("password", "")
    country = data.get("country", "de")
    language = data.get("language", "de-DE")
    if not email or not password:
        return jsonify({"error": "E-Mail und Passwort erforderlich"}), 400
    save_cookidoo_credentials(session["user"], email, password, country, language)
    return jsonify({"success": True})


@app.route("/api/ingredient-suggestions", methods=["GET"])
@cookidoo_route
def api_ingredient_suggestions():
    query = request.args.get("q", "").strip()
    if len(query) < 2:
        return jsonify({"count": 0, "suggestions": []})
    us = get_user_session(session["user"])
    try:
        result = run_async(us.planner.ingredient_suggestions(query))
        log.debug(f"[{session['user']}] ingredient_suggestions '{query}': {result}")
        return jsonify(result)
    except Exception as e:
        log.warning(f"[{session['user']}] ingredient_suggestions Fehler: {e}")
        return jsonify({"count": 0, "suggestions": []})


@app.route("/api/cookidoo-credentials", methods=["DELETE"])
@cookidoo_route
def api_clear_cookidoo_credentials():
    clear_cookidoo_credentials(session["user"])
    return jsonify({"success": True})


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    debug = os.getenv("FLY_APP_NAME") is None
    app.run(debug=debug, host="0.0.0.0", port=port, use_reloader=False)
