"""Cookidoo Wochenplan-Generator - Planungslogik."""

import asyncio
import logging
import random
import re
from dataclasses import dataclass
from datetime import date, timedelta

import aiohttp
from bring_api import Bring, BringItemOperation
from cookidoo_api import Cookidoo, CookidooConfig
from cookidoo_api.helpers import get_localization_options
from cookidoo_api.types import CookidooCollection

log = logging.getLogger("cookidoo")

# Algolia-Konfiguration
ALGOLIA_APP_ID = "3TA8NT85XJ"
ALGOLIA_SEARCH_URL = f"https://{ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/recipes-production/query"

# ===== Suchbegriffe =====

SEARCH_TERMS = [
    "Pasta", "Nudeln", "Risotto", "Lasagne", "Gnocchi",
    "Reis", "Kartoffel", "Auflauf", "Eintopf", "Pfanne", "Bowl",
    "Curry", "Wrap", "Burger", "Quiche", "Gratin",
    "Hähnchen", "Poulet", "Rind", "Schwein", "Lamm",
    "Lachs", "Fisch", "Garnelen", "Tofu", "Hackfleisch",
    "Gemüsepfanne", "Brokkoli", "Zucchini", "Kürbis", "Pilze",
    "Spinat", "Blumenkohl", "Süsskartoffel",
    "Thai Curry", "Mexikanisch", "Indisch", "Mediterran",
    "Couscous", "Quinoa", "Linsen", "Falafel",
    "One Pot", "Familienessen", "Mittagessen", "Abendessen",
]

STARTER_SEARCH_TERMS = [
    "Vorspeise", "Suppe", "Cremesuppe", "Tomatensuppe",
    "Linsensuppe", "Minestrone", "Gazpacho",
    "Salat", "Blattsalat", "Caprese", "Griechischer Salat",
    "Bruschetta", "Antipasti", "Tapas", "Frittata",
    "Carpaccio", "Ceviche", "Terrine",
    "Miso Suppe", "Ramen", "Tom Kha",
    "Borscht", "Kürbissuppe", "Zwiebelsuppe",
]

DESSERT_SEARCH_TERMS = [
    "Dessert", "Nachtisch", "Kuchen", "Torte",
    "Tiramisu", "Panna Cotta", "Crème Brûlée",
    "Mousse au Chocolat", "Cheesecake", "Tarte",
    "Brownie", "Muffin", "Waffel", "Crêpe",
    "Pudding", "Griessbrei", "Eis", "Sorbet",
    "Soufflé", "Parfait", "Strudel",
]

# Keywords-Listen für Typ-Erkennung
_STARTER_KEYWORDS = [
    "suppe", "cremesuppe", "velout", "consommé", "bouillon",
    "salat", "caprese", "carpaccio", "ceviche", "bruschetta",
    "crostini", "antipasti", "tapas", "frittata", "terrine",
    "gazpacho", "minestrone", "borscht", "ramen", "miso",
    "vorspeise", "starter", "amuse-bouche",
]

_DESSERT_KEYWORDS = [
    "kuchen", "torte", "tarte", "strudel", "cheesecake",
    "brownie", "muffin", "cookie", "keks", "waffel", "crêpe",
    "palatschinken", "tiramisu", "panna cotta", "crème brûlée",
    "mousse au chocolat", "soufflé", "parfait", "pudding",
    "griessbrei", "eis ", " eis", "sorbet", "dessert", "nachtisch",
    "schokoladenkuchen", "obsttorte", "apfelstrudel",
]

# Ausschluss-Keywords für Hauptgerichte (main course filter)
EXCLUDE_TITLE_KEYWORDS = [
    # Getränke
    "smoothie", "shake", "drink", "cocktail", "limonade", "saft",
    "sirup", "latte", "tee", "kaffee", "punsch", "bowle", "eistee",
    "juice", "espresso",
    # Desserts (werden separat geplant)
    "kuchen", "torte", "muffin", "brownie", "cookie", "keks",
    "praline", "konfekt", "bonbon", "trüffel",
    "sorbet", "mousse au chocolat", "crème brûlée", "pudding",
    "panna cotta", "tiramisu", "waffel", "palatschinken", "crêpe",
    "cheesecake", "tarte tatin", "strudel", "soufflé",
    "marmelade", "konfitüre", "gelee", "kompott",
    # Frühstück / Snacks
    "brot ", "brötchen", "zopf", "weggli", "müsli", "granola",
    "baby", "brei ",
    # Saucen / Condiments
    "dip", "pesto", "mayonnaise", "ketchup", "senf",
    "gewürzmischung", "gewürzpaste", "brühe", "fond", "bouillon",
    "marinade", "vinaigrette",
    # Typische Vorspeisen (werden separat geplant)
    "bruschetta", "crostini", "antipasti", "tapas", "amuse-bouche",
    "carpaccio",
]


@dataclass
class RecipeInfo:
    id: str
    name: str
    total_time: int  # Sekunden
    source: str  # "custom", "managed" oder "search"
    collection_name: str
    thumbnail: str | None = None
    image: str | None = None
    url: str | None = None
    rating: float = 0.0

    def total_time_str(self) -> str:
        minutes = self.total_time // 60
        if minutes >= 60:
            h, m = divmod(minutes, 60)
            return f"{h} Std. {m} Min." if m else f"{h} Std."
        return f"{minutes} Min."

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "total_time": self.total_time,
            "total_time_str": self.total_time_str(),
            "source": self.source,
            "collection_name": self.collection_name,
            "thumbnail": self.thumbnail,
            "image": self.image,
            "url": self.url,
            "rating": self.rating,
        }


WEEKDAYS_DE = [
    "Montag", "Dienstag", "Mittwoch", "Donnerstag",
    "Freitag", "Samstag", "Sonntag",
]

# Slot-Reihenfolge für Plan-Navigation
SLOT_ORDER = ["m_v", "m", "m_d", "a_v", "a", "a_d"]


def _is_main_course(title: str) -> bool:
    title_lower = title.lower()
    return not any(kw in title_lower for kw in EXCLUDE_TITLE_KEYWORDS)


def _is_starter(title: str) -> bool:
    t = title.lower()
    return any(kw in t for kw in _STARTER_KEYWORDS)


def _is_dessert(title: str) -> bool:
    t = title.lower()
    return any(kw in t for kw in _DESSERT_KEYWORDS)


def _parse_algolia_hit(hit: dict, country: str, language: str, recipe_type: str = "main") -> "RecipeInfo | None":
    recipe_id = hit.get("id", "")
    name = hit.get("title", "")
    if not recipe_id or not name:
        return None

    # Typ-spezifischer Filter
    if recipe_type == "main" and not _is_main_course(name):
        return None
    elif recipe_type == "starter" and not _is_starter(name):
        return None
    elif recipe_type == "dessert" and not _is_dessert(name):
        return None

    total_time = int(float(hit.get("totalTime", 0)))
    rating = float(hit.get("rating", hit.get("averageRating", hit.get("ratingValue", 0))) or 0)

    thumbnail = None
    image = None
    img_url = hit.get("image", "")
    if img_url:
        img_url = img_url.replace("{assethost}", "assets.tmecosys.com")
        if "{transformation}" in img_url:
            thumbnail = img_url.replace("{transformation}", "t_web_rdp_recipe_584x480")
            image = img_url.replace("{transformation}", "t_web_rdp_recipe_584x480")
        else:
            thumbnail = img_url
            image = img_url

    domain_map = {"de": "cookidoo.de", "at": "cookidoo.at", "ch": "cookidoo.ch",
                  "gb": "cookidoo.co.uk", "us": "cookidoo.thermomix.com"}
    domain = domain_map.get(country, f"cookidoo.{country}")
    url = f"https://{domain}/recipes/recipe/{language}/{recipe_id}"

    return RecipeInfo(
        id=recipe_id, name=name, total_time=total_time,
        source="search", collection_name="Cookidoo",
        thumbnail=thumbnail, image=image, url=url,
        rating=rating,
    )


class CookidooPlanner:
    def __init__(self):
        self._cookidoo: Cookidoo | None = None
        self._session: aiohttp.ClientSession | None = None
        self._custom_recipes: list[RecipeInfo] = []
        self._managed_recipes: list[RecipeInfo] = []
        self._search_recipes: list[RecipeInfo] = []
        self._starter_recipes: list[RecipeInfo] = []
        self._dessert_recipes: list[RecipeInfo] = []
        self._logged_in = False
        self._country = "de"
        self._language = "de-DE"
        self._algolia_api_key: str | None = None
        # None = unbekannt, "" = kein Facet verfügbar, str = funktionierender Facet-Name
        self._ingredient_facet: str | None = None

    async def login(self, email: str, password: str, country: str = "de", language: str = "de-DE") -> dict:
        if self._session:
            await self._session.close()

        self._session = aiohttp.ClientSession()
        self._country = country
        self._language = language

        localizations = await get_localization_options(country=country, language=language)
        if not localizations:
            localizations = await get_localization_options(country=country)
        if not localizations:
            raise ValueError(f"Keine Lokalisierung gefunden für {country}/{language}")

        self._cookidoo = Cookidoo(
            self._session,
            cfg=CookidooConfig(
                email=email, password=password,
                localization=localizations[0],
            ),
        )

        await self._cookidoo.login()
        user_info = await self._cookidoo.get_user_info()
        subscription = await self._cookidoo.get_active_subscription()
        self._logged_in = True
        await self._fetch_algolia_key()

        return {
            "username": user_info.username,
            "subscription_active": subscription.active if subscription else False,
        }

    async def _fetch_algolia_key(self):
        if not self._session:
            return
        domain_map = {"de": "cookidoo.de", "at": "cookidoo.at", "ch": "cookidoo.ch",
                      "gb": "cookidoo.co.uk", "us": "cookidoo.thermomix.com"}
        domain = domain_map.get(self._country, f"cookidoo.{self._country}")
        search_url = f"https://{domain}/search/{self._language}"
        try:
            async with self._session.get(search_url) as resp:
                html = await resp.text()
                match = re.search(r'"apiKey"\s*:\s*"([A-Za-z0-9+/=]{40,})"', html)
                if match:
                    self._algolia_api_key = match.group(1)
                    log.info(f"Algolia API-Key gefunden ({len(self._algolia_api_key)} chars)")
                else:
                    log.warning("Algolia API-Key nicht im HTML gefunden")
        except Exception as e:
            log.warning(f"Algolia Key fetch fehlgeschlagen: {e}")

    async def _search_algolia(self, query: str, count: int = 40,
                               filters: str = "", recipe_type: str = "main") -> list[RecipeInfo]:
        if not self._session or not self._algolia_api_key:
            return []

        headers = {
            "X-Algolia-Application-Id": ALGOLIA_APP_ID,
            "X-Algolia-API-Key": self._algolia_api_key,
            "Content-Type": "application/json",
        }
        payload = {"query": query, "hitsPerPage": count}
        if filters:
            payload["filters"] = filters

        try:
            async with self._session.post(ALGOLIA_SEARCH_URL, headers=headers, json=payload) as resp:
                if resp.status != 200:
                    return []
                data = await resp.json()
                recipes = []
                for hit in data.get("hits", []):
                    recipe = _parse_algolia_hit(hit, self._country, self._language, recipe_type)
                    if recipe:
                        recipes.append(recipe)
                log.info(f"Algolia '{query}' [{recipe_type}]: {len(recipes)} Treffer")
                return recipes
        except Exception as e:
            log.warning(f"Algolia Suche Fehler: {e}")
            return []

    async def _search_typed_pool(self, search_terms: list[str], recipe_type: str,
                                  count_per_term: int = 30) -> list[RecipeInfo]:
        """Lädt Rezepte eines bestimmten Typs (starter/dessert/main) via Algolia."""
        terms = random.sample(search_terms, min(10, len(search_terms)))
        results = await asyncio.gather(
            *[self._search_algolia(t, count_per_term, recipe_type=recipe_type) for t in terms]
        )
        seen: set[str] = set()
        pool: list[RecipeInfo] = []
        for lst in results:
            for r in lst:
                if r.id not in seen:
                    seen.add(r.id)
                    pool.append(r)
        return pool

    async def search_with_filters(
        self,
        categories: list[str] | None = None,
        cuisines: list[str] | None = None,
        preferred_ingredients: list[str] | None = None,
    ) -> int:
        """Lade Hauptgerichte via Algolia mit optionalen Filtern."""
        search_terms = list(SEARCH_TERMS)

        category_terms = {
            "vegetarisch": ["vegetarisch", "gemüse", "veggie"],
            "vegan": ["vegan", "vegane", "pflanzlich"],
            "low carb": ["low carb", "kohlenhydratarm"],
            "high protein": ["high protein", "eiweiss", "proteinreich"],
        }
        cuisine_terms = {
            "italienisch": ["italienisch", "pasta", "risotto", "pizza"],
            "asiatisch": ["asiatisch", "asia", "wok", "thai"],
            "mexikanisch": ["mexikanisch", "burrito", "taco", "enchilada"],
            "indisch": ["indisch", "curry", "tikka", "masala"],
            "mediterran": ["mediterran", "griechisch", "spanisch"],
            "orientalisch": ["orientalisch", "falafel", "hummus", "couscous"],
        }

        if categories:
            extra = []
            for cat in categories:
                extra.extend(category_terms.get(cat, [cat]))
            search_terms = extra + search_terms[:10]

        if cuisines:
            extra = []
            for c in cuisines:
                extra.extend(cuisine_terms.get(c, [c]))
            search_terms = extra + search_terms[:10]

        if preferred_ingredients:
            search_terms = list(preferred_ingredients) + search_terms[:10]

        terms_to_use = random.sample(search_terms, min(20, len(search_terms)))

        self._search_recipes = []
        results = await asyncio.gather(
            *[self._search_algolia(term, count=40) for term in terms_to_use]
        )
        seen_ids = {r.id for r in self._custom_recipes + self._managed_recipes}
        for recipe_list in results:
            for recipe in recipe_list:
                if recipe.id not in seen_ids:
                    seen_ids.add(recipe.id)
                    self._search_recipes.append(recipe)

        if categories:
            cat_keywords = []
            for cat in categories:
                cat_keywords.extend(category_terms.get(cat, [cat]))
            filtered = [r for r in self._search_recipes
                        if any(kw.lower() in r.name.lower() for kw in cat_keywords)]
            if len(filtered) >= 10:
                self._search_recipes = filtered

        log.info(f"Algolia Suche: {len(self._search_recipes)} Hauptgerichte")
        return len(self._search_recipes)

    async def load_collections(self) -> dict:
        if not self._cookidoo or not self._logged_in:
            raise RuntimeError("Nicht eingeloggt")

        self._custom_recipes = []
        self._managed_recipes = []
        self._search_recipes = []
        self._starter_recipes = []
        self._dessert_recipes = []

        _, custom_pages = await self._cookidoo.count_custom_collections()
        custom_collections: list[CookidooCollection] = []
        for page in range(custom_pages):
            custom_collections.extend(await self._cookidoo.get_custom_collections(page=page))

        for coll in custom_collections:
            for chapter in coll.chapters:
                for recipe in chapter.recipes:
                    self._custom_recipes.append(RecipeInfo(
                        id=recipe.id, name=recipe.name, total_time=recipe.total_time,
                        source="custom", collection_name=coll.name,
                    ))

        _, managed_pages = await self._cookidoo.count_managed_collections()
        managed_collections: list[CookidooCollection] = []
        for page in range(managed_pages):
            managed_collections.extend(await self._cookidoo.get_managed_collections(page=page))

        for coll in managed_collections:
            for chapter in coll.chapters:
                for recipe in chapter.recipes:
                    self._managed_recipes.append(RecipeInfo(
                        id=recipe.id, name=recipe.name, total_time=recipe.total_time,
                        source="managed", collection_name=coll.name,
                    ))

        total_from_collections = len(self._custom_recipes) + len(self._managed_recipes)
        if total_from_collections < 20:
            log.info(f"Nur {total_from_collections} Rezepte aus Sammlungen, starte Algolia-Suche...")
            search_terms = random.sample(SEARCH_TERMS, min(20, len(SEARCH_TERMS)))
            results = await asyncio.gather(
                *[self._search_algolia(term, count=40) for term in search_terms]
            )
            seen_ids = {r.id for r in self._custom_recipes + self._managed_recipes}
            for recipe_list in results:
                for recipe in recipe_list:
                    if recipe.id not in seen_ids:
                        seen_ids.add(recipe.id)
                        self._search_recipes.append(recipe)

        return {
            "custom_recipes": len(self._custom_recipes),
            "managed_recipes": len(self._managed_recipes),
            "search_recipes": len(self._search_recipes),
            "custom_collections": len(custom_collections),
            "managed_collections": len(managed_collections),
        }

    async def _enrich_recipe(self, recipe: RecipeInfo) -> RecipeInfo:
        if recipe.thumbnail and recipe.image:
            return recipe
        if not self._cookidoo:
            return recipe
        try:
            details = await self._cookidoo.get_recipe_details(recipe.id)
            recipe.thumbnail = details.thumbnail
            recipe.image = details.image
            recipe.url = details.url
        except Exception:
            pass
        return recipe

    @staticmethod
    def _filter_by_time(recipes: list[RecipeInfo], max_minutes: int | None) -> list[RecipeInfo]:
        if max_minutes is None:
            return recipes
        max_seconds = max_minutes * 60
        return [r for r in recipes if r.total_time == 0 or r.total_time <= max_seconds]

    @staticmethod
    def _filter_by_ingredients(recipes: list[RecipeInfo], exclude_ingredients: list[str] | None) -> list[RecipeInfo]:
        if not exclude_ingredients:
            return recipes
        exclude_lower = [i.lower().strip() for i in exclude_ingredients if i.strip()]
        if not exclude_lower:
            return recipes
        return [r for r in recipes if not any(excl in r.name.lower() for excl in exclude_lower)]

    def _get_pool_for_slot(self, slot_key: str) -> list[RecipeInfo]:
        """Gibt den Recipe-Pool für einen Slot zurück."""
        if slot_key in ("m_v", "a_v"):
            return self._starter_recipes
        elif slot_key in ("m_d", "a_d"):
            return self._dessert_recipes
        else:  # "m", "a"
            return self._custom_recipes + self._managed_recipes + self._search_recipes

    async def _ensure_starter_pool(self):
        if not self._starter_recipes:
            self._starter_recipes = await self._search_typed_pool(STARTER_SEARCH_TERMS, "starter")
            log.info(f"Vorspeisen-Pool geladen: {len(self._starter_recipes)}")

    async def _ensure_dessert_pool(self):
        if not self._dessert_recipes:
            self._dessert_recipes = await self._search_typed_pool(DESSERT_SEARCH_TERMS, "dessert")
            log.info(f"Dessert-Pool geladen: {len(self._dessert_recipes)}")

    async def generate_plan(
        self,
        day_slots: dict[int, list[str]],  # {dayIdx: ["m","a","m_v","m_d","a_v","a_d"]}
        custom_ratio: int = 70,
        exclude_ids: list[str] | None = None,
        max_time_per_slot: dict[str, int | None] | None = None,  # {"m": 60, "a": None}
        exclude_ingredients: list[str] | None = None,
    ) -> dict[str, dict[str, RecipeInfo | None]]:
        """Generiert einen Wochenplan mit pro-Tag-Konfiguration und Vorspeise/Dessert.

        Returns: {dayName: {slotKey: recipe_or_None}}
        """
        if not day_slots:
            return {}

        if max_time_per_slot is None:
            max_time_per_slot = {"m": None, "a": None}

        # Lazy-load Vorspeise/Dessert Pools
        all_slot_keys = {sk for slots in day_slots.values() for sk in slots}
        if any(sk in ("m_v", "a_v") for sk in all_slot_keys):
            await self._ensure_starter_pool()
        if any(sk in ("m_d", "a_d") for sk in all_slot_keys):
            await self._ensure_dessert_pool()

        exclude = set(exclude_ids or [])
        seen_global: set[str] = set()
        exclude_ingr = exclude_ingredients or []

        # Plan-Struktur initialisieren
        plan: dict[str, dict[str, RecipeInfo | None]] = {}
        for day_idx, slots in day_slots.items():
            plan[WEEKDAYS_DE[day_idx]] = {sk: None for sk in slots}

        # Zeit-Mapping: Mittag-Slots → "m", Abend-Slots → "a"
        def time_key(slot_key: str) -> str:
            return "m" if slot_key.startswith("m") else "a"

        # Verarbeitung in fester Reihenfolge (m_v → m → m_d → a_v → a → a_d)
        for slot_key in SLOT_ORDER:
            days_for_slot = [
                (day_idx, WEEKDAYS_DE[day_idx])
                for day_idx, slots in day_slots.items()
                if slot_key in slots
            ]
            if not days_for_slot:
                continue

            n = len(days_for_slot)
            max_time = max_time_per_slot.get(time_key(slot_key))

            base_pool = self._get_pool_for_slot(slot_key)
            filtered = self._filter_by_time(base_pool, max_time)
            filtered = self._filter_by_ingredients(filtered, exclude_ingr)
            available = [r for r in filtered if r.id not in exclude and r.id not in seen_global]

            if slot_key in ("m", "a"):
                # Custom-Ratio für Hauptgänge
                available_custom = [r for r in available if r in self._custom_recipes]
                available_other = [r for r in available if r not in self._custom_recipes]

                n_custom = round(n * custom_ratio / 100)
                n_other = n - n_custom

                if len(available_custom) < n_custom:
                    n_custom = len(available_custom)
                    n_other = n - n_custom
                if len(available_other) < n_other:
                    n_other = len(available_other)
                    n_custom = min(len(available_custom), n - n_other)

                selected = (
                    random.sample(available_custom, min(n_custom, len(available_custom)))
                    + random.sample(available_other, min(n_other, len(available_other)))
                )
            else:
                # Vorspeise/Dessert: einfach zufällig
                selected = random.sample(available, min(n, len(available)))

            random.shuffle(selected)
            enriched = await asyncio.gather(*[self._enrich_recipe(r) for r in selected])

            for r in enriched:
                seen_global.add(r.id)

            for i, (day_idx, day_name) in enumerate(days_for_slot):
                plan[day_name][slot_key] = enriched[i] if i < len(enriched) else None

        return plan

    async def generate_single(
        self,
        custom_ratio: int = 70,
        exclude_ids: list[str] | None = None,
        max_time_minutes: int | None = None,
        slot_type: str = "main",
        exclude_ingredients: list[str] | None = None,
    ) -> RecipeInfo | None:
        """Generiert ein einzelnes Rezept (für Reroll)."""
        # Sicherstellen dass der Pool geladen ist
        if slot_type == "starter":
            await self._ensure_starter_pool()
            base_pool = self._starter_recipes
        elif slot_type == "dessert":
            await self._ensure_dessert_pool()
            base_pool = self._dessert_recipes
        else:
            base_pool = self._custom_recipes + self._managed_recipes + self._search_recipes

        exclude = set(exclude_ids or [])
        filtered = self._filter_by_time(base_pool, max_time_minutes)
        filtered = self._filter_by_ingredients(filtered, exclude_ingredients or [])
        available = [r for r in filtered if r.id not in exclude]

        if slot_type == "main":
            available_custom = [r for r in available if r in self._custom_recipes]
            available_other = [r for r in available if r not in self._custom_recipes]
            use_custom = random.randint(1, 100) <= custom_ratio
            if use_custom and available_custom:
                recipe = random.choice(available_custom)
            elif available_other:
                recipe = random.choice(available_other)
            elif available_custom:
                recipe = random.choice(available_custom)
            else:
                return None
        else:
            if not available:
                return None
            recipe = random.choice(available)

        return await self._enrich_recipe(recipe)

    async def ingredient_suggestions(self, query: str, limit: int = 10) -> dict:
        """Suche Zutaten via Algolia.

        Strategie:
        1. Facet-Suche auf möglichen Attributnamen (mit Caching des funktionierenden).
        2. Reguläre Suche mit Attributen aus dem Hit (ingredientNames-Feld im Rezept).
        3. Fallback: Wort-Extraktion aus Rezepttiteln.
        """
        q = query.strip()
        if not self._session or not self._algolia_api_key or len(q) < 2:
            return {"count": 0, "suggestions": []}

        headers = {
            "X-Algolia-Application-Id": ALGOLIA_APP_ID,
            "X-Algolia-API-Key": self._algolia_api_key,
            "Content-Type": "application/json",
        }
        base = f"https://{ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/recipes-production"

        # ── 1. Facet-Suche ──────────────────────────────────────────────────────
        # Kandidaten in absteigender Wahrscheinlichkeit; bereits bekannter Facet zuerst
        if self._ingredient_facet:
            facet_candidates = [self._ingredient_facet]
        elif self._ingredient_facet is None:
            facet_candidates = [
                "ingredientNames", "ingredients", "ingredient",
                "ingredientList", "zutaten",
            ]
        else:
            facet_candidates = []  # "" = bereits als nicht verfügbar bestätigt

        for facet_name in facet_candidates:
            try:
                url = f"{base}/facets/{facet_name}/query"
                async with self._session.post(
                    url, headers=headers,
                    json={"facetQuery": q, "maxFacetHits": limit},
                ) as resp:
                    if resp.status == 200:
                        if not self._ingredient_facet:
                            self._ingredient_facet = facet_name
                            log.info(f"Ingredient-Facet gefunden: '{facet_name}'")
                        data = await resp.json()
                        hits = data.get("facetHits", [])
                        return {
                            "count": sum(h.get("count", 1) for h in hits),
                            "suggestions": [h["value"] for h in hits],
                        }
            except Exception as e:
                log.debug(f"Facet '{facet_name}' fehlgeschlagen: {e}")

        # Alle Kandidaten erfolglos → kein Facet verfügbar
        if self._ingredient_facet is None:
            self._ingredient_facet = ""
            log.info("Kein Ingredient-Facet verfügbar, nutze Fallback")

        # ── 2. Reguläre Suche: Zutaten-Felder aus den Hits ──────────────────────
        try:
            payload = {
                "query": q,
                "hitsPerPage": 20,
                "attributesToRetrieve": [
                    "title", "ingredientNames", "ingredients",
                    "ingredientList", "mainIngredient",
                ],
            }
            async with self._session.post(ALGOLIA_SEARCH_URL, headers=headers, json=payload) as resp:
                if resp.status != 200:
                    return {"count": 0, "suggestions": []}
                data = await resp.json()
                nb_hits = data.get("nbHits", 0)
                hits = data.get("hits", [])
                q_lower = q.lower()

                # Zutaten aus dedizierten Feldern sammeln
                ingredient_freq: dict[str, int] = {}
                for hit in hits:
                    for field in ("ingredientNames", "ingredientList"):
                        val = hit.get(field)
                        if isinstance(val, list):
                            for item in val:
                                name = item if isinstance(item, str) else (
                                    item.get("name") or item.get("title") or "" if isinstance(item, dict) else ""
                                )
                                if name and q_lower in name.lower():
                                    ingredient_freq[name] = ingredient_freq.get(name, 0) + 1

                if ingredient_freq:
                    sorted_ingr = sorted(ingredient_freq, key=lambda x: (-ingredient_freq[x], len(x)))
                    return {"count": nb_hits, "suggestions": sorted_ingr[:limit]}

                # ── 3. Letzter Fallback: Wörter aus Rezepttiteln ──────────────
                word_freq: dict[str, int] = {}
                for hit in hits:
                    for word in hit.get("title", "").split():
                        w = word.strip("()[],.:-/–—»«'\"!?;")
                        if len(w) >= len(q) and q_lower in w.lower():
                            word_freq[w] = word_freq.get(w, 0) + 1

                sorted_words = sorted(word_freq, key=lambda x: (-word_freq[x], len(x)))
                return {"count": nb_hits, "suggestions": sorted_words[:limit]}

        except Exception as e:
            log.warning(f"Ingredient suggestions Fehler: {e}")
            return {"count": 0, "suggestions": []}

    async def save_to_calendar(
        self, plan: dict[str, dict[str, dict]], week_offset: int = 0,
        add_to_shopping_list: bool = False,
    ) -> dict:
        if not self._cookidoo or not self._logged_in:
            raise RuntimeError("Nicht eingeloggt")

        today = date.today()
        monday = today - timedelta(days=today.weekday()) + timedelta(weeks=week_offset)

        saved = []
        errors = []
        recipe_ids_for_shopping = []

        for day_name, slots in plan.items():
            if not slots:
                continue
            try:
                day_idx = WEEKDAYS_DE.index(day_name)
            except ValueError:
                continue

            target_date = monday + timedelta(days=day_idx)
            recipe_ids = [r["id"] for r in slots.values() if r is not None]

            if not recipe_ids:
                continue

            try:
                await self._cookidoo.add_recipes_to_calendar(target_date, recipe_ids)
                for slot_key, r in slots.items():
                    if r is not None:
                        saved.append({"day": day_name, "slot": slot_key, "recipe": r["name"]})
                        recipe_ids_for_shopping.append(r["id"])
            except Exception as e:
                errors.append({"day": day_name, "error": str(e)})

        shopping_added = 0
        if add_to_shopping_list and recipe_ids_for_shopping:
            try:
                items = await self._cookidoo.add_ingredient_items_for_recipes(recipe_ids_for_shopping)
                shopping_added = len(items)
            except Exception as e:
                errors.append({"day": "Einkaufsliste", "error": str(e)})

        return {"saved": saved, "errors": errors, "shopping_added": shopping_added}

    async def clear_calendar_week(self, week_offset: int = 0) -> int:
        if not self._cookidoo or not self._logged_in:
            raise RuntimeError("Nicht eingeloggt")

        today = date.today()
        monday = today - timedelta(days=today.weekday()) + timedelta(weeks=week_offset)
        calendar_days = await self._cookidoo.get_recipes_in_calendar_week(monday)
        removed = 0

        for i, cal_day in enumerate(calendar_days):
            target_date = monday + timedelta(days=i)
            for recipe in cal_day.recipes:
                try:
                    await self._cookidoo.remove_recipe_from_calendar(target_date, recipe.id)
                    removed += 1
                except Exception:
                    pass
        return removed

    async def close(self):
        if self._session:
            await self._session.close()
            self._session = None
        self._logged_in = False

    def get_cookidoo(self) -> Cookidoo | None:
        return self._cookidoo


class BringIntegration:
    """Bring! Einkaufslisten-Integration."""

    def __init__(self):
        self._bring: Bring | None = None
        self._session: aiohttp.ClientSession | None = None
        self._logged_in = False
        self._lists: list[dict] = []

    async def login(self, email: str, password: str) -> dict:
        if self._session:
            await self._session.close()
        self._session = aiohttp.ClientSession()
        self._bring = Bring(self._session, email, password)
        await self._bring.login()
        self._logged_in = True
        lists_response = await self._bring.load_lists()
        self._lists = [{"uuid": lst.listUuid, "name": lst.name} for lst in lists_response.lists]
        return {"lists": self._lists}

    async def close(self):
        if self._session:
            await self._session.close()
            self._session = None
        self._logged_in = False
