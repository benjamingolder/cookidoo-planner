"""Cookidoo Wochenplan-Generator - Flask Web-App."""

import asyncio
import logging
import os
import threading

from dotenv import load_dotenv

logging.basicConfig(
    filename=os.getenv("LOG_FILE", "/home/benjamin/cookidoo-planner/debug.log"),
    level=logging.DEBUG,
    format="%(asctime)s %(message)s",
)
log = logging.getLogger("cookidoo")
from flask import Flask, jsonify, render_template, request, session

from auth import create_invite_code, init_db, login_required, register_user, verify_user
from planner import BringIntegration, CookidooPlanner

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", os.urandom(24))

# Persistenter Event-Loop in eigenem Thread
_loop = asyncio.new_event_loop()
_loop_thread = threading.Thread(target=_loop.run_forever, daemon=True)
_loop_thread.start()

# Globaler Planner (pro Server-Instanz)
_planner = CookidooPlanner()
_bring = BringIntegration()
# Aktueller Plan im Speicher
_current_plan: dict = {}

# Datenbank initialisieren
init_db()


def run_async(coro):
    """Async-Coroutine im persistenten Event-Loop ausführen."""
    future = asyncio.run_coroutine_threadsafe(coro, _loop)
    return future.result(timeout=120)


# ===== Auth-Routen =====

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/auth/status", methods=["GET"])
def api_auth_status():
    if "user" in session:
        return jsonify({"logged_in": True, "username": session["user"]})
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
    session.pop("user", None)
    return jsonify({"success": True})


@app.route("/api/auth/invite", methods=["POST"])
@login_required
def api_auth_invite():
    code = create_invite_code(session["user"])
    return jsonify({"success": True, "code": code})


# ===== Cookidoo-Routen =====

@app.route("/api/login", methods=["POST"])
@login_required
def api_login():
    data = request.get_json()
    email = data.get("email", os.getenv("COOKIDOO_EMAIL", ""))
    password = data.get("password", os.getenv("COOKIDOO_PASSWORD", ""))
    country = data.get("country", os.getenv("COOKIDOO_COUNTRY", "de"))
    language = data.get("language", os.getenv("COOKIDOO_LANGUAGE", "de-DE"))

    if not email or not password:
        return jsonify({"error": "E-Mail und Passwort erforderlich"}), 400

    try:
        result = run_async(_planner.login(email, password, country, language))
        return jsonify({"success": True, **result})
    except Exception as e:
        return jsonify({"error": f"Login fehlgeschlagen: {e}"}), 401


@app.route("/api/collections", methods=["POST"])
@login_required
def api_load_collections():
    try:
        result = run_async(_planner.load_collections())
        log.info(f"Collections geladen: {result}")
        log.info(f"Custom Rezepte: {len(_planner._custom_recipes)}")
        log.info(f"Managed Rezepte: {len(_planner._managed_recipes)}")
        if _planner._custom_recipes:
            r = _planner._custom_recipes[0]
            log.info(f"Beispiel Custom: id={r.id}, name={r.name}")
        if _planner._managed_recipes:
            r = _planner._managed_recipes[0]
            log.info(f"Beispiel Managed: id={r.id}, name={r.name}")
        return jsonify({"success": True, **result})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"Sammlungen laden fehlgeschlagen: {e}"}), 500


@app.route("/api/generate", methods=["POST"])
@login_required
def api_generate():
    global _current_plan
    data = request.get_json() or {}
    days = data.get("days", list(range(7)))
    custom_ratio = data.get("custom_ratio", 70)
    exclude_ids = data.get("exclude_ids", [])
    categories = data.get("categories", [])
    cuisines = data.get("cuisines", [])

    try:
        # Refresh search recipes if filters are active
        if categories or cuisines:
            run_async(_planner.search_with_filters(categories, cuisines))

        plan = run_async(_planner.generate_plan(days, custom_ratio, exclude_ids))
        _current_plan = {}
        for day_name, recipe in plan.items():
            _current_plan[day_name] = recipe.to_dict() if recipe else None
        log.info(f"Generate: days={days}, ratio={custom_ratio}, categories={categories}, cuisines={cuisines}")
        log.info(f"Plan: {[(d, r['name'] if r else None) for d, r in _current_plan.items()]}")
        return jsonify({"success": True, "plan": _current_plan})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"Plan generieren fehlgeschlagen: {e}"}), 500


@app.route("/api/regenerate-day", methods=["POST"])
@login_required
def api_regenerate_day():
    global _current_plan
    data = request.get_json() or {}
    day_name = data.get("day")
    custom_ratio = data.get("custom_ratio", 70)
    categories = data.get("categories", [])
    cuisines = data.get("cuisines", [])

    # Alle aktuell verwendeten IDs als Exclude
    exclude_ids = [
        r["id"] for d, r in _current_plan.items()
        if r is not None and d != day_name
    ]

    try:
        # Refresh search recipes if filters are active
        if categories or cuisines:
            run_async(_planner.search_with_filters(categories, cuisines))

        recipe = run_async(_planner.generate_single(custom_ratio, exclude_ids))
        if recipe:
            _current_plan[day_name] = recipe.to_dict()
        return jsonify({"success": True, "recipe": _current_plan.get(day_name)})
    except Exception as e:
        return jsonify({"error": f"Rezept generieren fehlgeschlagen: {e}"}), 500


@app.route("/api/save", methods=["POST"])
@login_required
def api_save():
    global _current_plan
    data = request.get_json() or {}
    week_offset = data.get("week_offset", 0)
    clear_first = data.get("clear_first", False)

    if not _current_plan:
        return jsonify({"error": "Kein Plan vorhanden"}), 400

    add_to_shopping_list = data.get("add_to_shopping_list", False)
    add_to_bring = data.get("add_to_bring", False)
    bring_list_uuid = data.get("bring_list_uuid", "")

    try:
        if clear_first:
            run_async(_planner.clear_calendar_week(week_offset))

        result = run_async(_planner.save_to_calendar(_current_plan, week_offset, add_to_shopping_list))

        # Bring! Integration
        bring_added = 0
        if add_to_bring and bring_list_uuid:
            recipe_ids = [
                r["id"] for r in _current_plan.values() if r is not None
            ]
            cookidoo = _planner.get_cookidoo()
            if cookidoo and recipe_ids:
                try:
                    bring_added = run_async(
                        _bring.add_ingredients(bring_list_uuid, cookidoo, recipe_ids)
                    )
                except Exception as e:
                    log.warning(f"Bring! Fehler: {e}")
                    result.setdefault("errors", []).append(
                        {"day": "Bring!", "error": str(e)}
                    )

        return jsonify({"success": True, **result, "bring_added": bring_added})
    except Exception as e:
        return jsonify({"error": f"Speichern fehlgeschlagen: {e}"}), 500


@app.route("/api/bring/login", methods=["POST"])
@login_required
def api_bring_login():
    data = request.get_json() or {}
    email = data.get("email", os.getenv("BRING_EMAIL", ""))
    password = data.get("password", os.getenv("BRING_PASSWORD", ""))

    if not email or not password:
        return jsonify({"error": "Bring! E-Mail und Passwort erforderlich"}), 400

    try:
        result = run_async(_bring.login(email, password))
        return jsonify({"success": True, **result})
    except Exception as e:
        return jsonify({"error": f"Bring! Login fehlgeschlagen: {e}"}), 401


@app.route("/api/bring/lists", methods=["GET"])
@login_required
def api_bring_lists():
    try:
        lists = run_async(_bring.get_lists())
        return jsonify({"success": True, "lists": lists})
    except Exception as e:
        return jsonify({"error": f"Bring! Listen laden fehlgeschlagen: {e}"}), 500


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    debug = os.getenv("FLY_APP_NAME") is None  # Debug nur lokal
    app.run(debug=debug, host="0.0.0.0", port=port, use_reloader=False)
