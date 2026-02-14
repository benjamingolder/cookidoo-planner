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

# Suchbegriffe die Hauptgerichte liefern
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

# Titel-Keywords die KEINE Hauptgerichte sind -> ausfiltern
EXCLUDE_TITLE_KEYWORDS = [
    "smoothie", "shake", "drink", "cocktail", "limonade", "saft",
    "sirup", "latte", "tee", "kaffee", "punsch", "bowle", "eistee",
    "kuchen", "torte", "muffin", "brownie", "cookie", "keks",
    "praline", "konfekt", "bonbon", "schokolade", "trüffel",
    "eis ", "sorbet", "mousse", "crème", "pudding", "panna cotta",
    "marmelade", "konfitüre", "gelee", "kompott", "aufstrich süss",
    "brot ", "brötchen", "zopf", "weggli",
    "baby", "brei ",
    "dip", "pesto", "mayonnaise", "ketchup", "senf",
    "gewürzmischung", "gewürzpaste", "brühe", "fond", "bouillon",
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
        }


WEEKDAYS_DE = [
    "Montag", "Dienstag", "Mittwoch", "Donnerstag",
    "Freitag", "Samstag", "Sonntag",
]


def _is_main_course(title: str) -> bool:
    """Prüfe ob ein Rezept ein Hauptgericht ist (Titel-basiert)."""
    title_lower = title.lower()
    return not any(kw in title_lower for kw in EXCLUDE_TITLE_KEYWORDS)


def _parse_algolia_hit(hit: dict, country: str, language: str) -> RecipeInfo | None:
    """Algolia-Suchergebnis in RecipeInfo umwandeln."""
    recipe_id = hit.get("id", "")
    name = hit.get("title", "")
    if not recipe_id or not name:
        return None

    # Titel-Filter: keine Drinks, Desserts etc.
    if not _is_main_course(name):
        return None

    total_time = int(float(hit.get("totalTime", 0)))

    # Bild-URL - Algolia gibt "image" mit Platzhaltern {assethost} und {transformation}
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

    # Rezept-URL
    domain_map = {"de": "cookidoo.de", "at": "cookidoo.at", "ch": "cookidoo.ch",
                  "gb": "cookidoo.co.uk", "us": "cookidoo.thermomix.com"}
    domain = domain_map.get(country, f"cookidoo.{country}")
    url = f"https://{domain}/recipes/recipe/{language}/{recipe_id}"

    return RecipeInfo(
        id=recipe_id,
        name=name,
        total_time=total_time,
        source="search",
        collection_name="Cookidoo",
        thumbnail=thumbnail,
        image=image,
        url=url,
    )


class CookidooPlanner:
    def __init__(self):
        self._cookidoo: Cookidoo | None = None
        self._session: aiohttp.ClientSession | None = None
        self._custom_recipes: list[RecipeInfo] = []
        self._managed_recipes: list[RecipeInfo] = []
        self._search_recipes: list[RecipeInfo] = []
        self._logged_in = False
        self._country = "de"
        self._language = "de-DE"
        self._algolia_api_key: str | None = None

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
                email=email,
                password=password,
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

    async def _search_algolia(self, query: str, count: int = 40, filters: str = "") -> list[RecipeInfo]:
        if not self._session or not self._algolia_api_key:
            return []

        headers = {
            "X-Algolia-Application-Id": ALGOLIA_APP_ID,
            "X-Algolia-API-Key": self._algolia_api_key,
            "Content-Type": "application/json",
        }
        payload = {
            "query": query,
            "hitsPerPage": count,
        }
        if filters:
            payload["filters"] = filters

        try:
            async with self._session.post(ALGOLIA_SEARCH_URL, headers=headers, json=payload) as resp:
                if resp.status != 200:
                    body = await resp.text()
                    log.warning(f"Algolia Suche fehlgeschlagen: {resp.status} - {body[:300]}")
                    return []
                data = await resp.json()
                recipes = []
                all_hits = data.get("hits", [])
                if all_hits:
                    log.info(f"Algolia sample hit image: {all_hits[0].get('image', 'MISSING')}")
                for hit in all_hits:
                    recipe = _parse_algolia_hit(hit, self._country, self._language)
                    if recipe:
                        recipes.append(recipe)
                log.info(f"Algolia '{query}': {len(recipes)} Hauptgerichte")
                return recipes
        except Exception as e:
            log.warning(f"Algolia Suche Fehler: {e}")
            return []

    async def search_with_filters(self, categories: list[str] = None, cuisines: list[str] = None) -> int:
        """Lade Rezepte via Algolia mit optionalen Filtern."""
        search_terms = list(SEARCH_TERMS)

        # Kategorie-spezifische Suchbegriffe hinzufügen
        category_terms = {
            "vegetarisch": ["vegetarisch", "gemüse", "veggie", "vegetarische"],
            "vegan": ["vegan", "vegane", "pflanzlich"],
            "low carb": ["low carb", "kohlenhydratarm", "ohne kohlenhydrate"],
            "high protein": ["high protein", "eiweiss", "proteinreich"],
        }
        cuisine_terms = {
            "italienisch": ["italienisch", "pasta", "risotto", "pizza", "gnocchi", "lasagne"],
            "asiatisch": ["asiatisch", "asia", "wok", "thai", "chinesisch", "japanisch"],
            "mexikanisch": ["mexikanisch", "burrito", "taco", "enchilada", "quesadilla"],
            "indisch": ["indisch", "curry", "tikka", "masala", "dal"],
            "mediterran": ["mediterran", "griechisch", "spanisch", "mittelmeer"],
            "orientalisch": ["orientalisch", "falafel", "hummus", "couscous", "marokkanisch"],
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

        # Wenn keine Filter, nutze die Standard-Suchbegriffe
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

        # Wenn Kategorie-Filter aktiv: zusätzlich Titel-Filter
        if categories:
            cat_keywords = []
            for cat in categories:
                cat_keywords.extend(category_terms.get(cat, [cat]))
            # Behalte Rezepte die mindestens ein Keyword im Titel haben
            filtered = [r for r in self._search_recipes
                        if any(kw.lower() in r.name.lower() for kw in cat_keywords)]
            # Falls der Titel-Filter zu aggressiv ist, behalte alle
            if len(filtered) >= 10:
                self._search_recipes = filtered

        log.info(f"Algolia Suche mit Filtern: {len(self._search_recipes)} Rezepte (categories={categories}, cuisines={cuisines})")
        return len(self._search_recipes)

    async def load_collections(self) -> dict:
        if not self._cookidoo or not self._logged_in:
            raise RuntimeError("Nicht eingeloggt")

        self._custom_recipes = []
        self._managed_recipes = []
        self._search_recipes = []

        # Custom Collections
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

        # Managed Collections
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

        # Algolia-Suche als Ergänzung (nur Hauptgerichte via Titel-Filter)
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
            log.info(f"Algolia-Suche ergab {len(self._search_recipes)} Hauptgerichte")

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

    async def generate_plan(
        self,
        days: list[int] | None = None,
        custom_ratio: int = 70,
        exclude_ids: list[str] | None = None,
    ) -> dict[str, RecipeInfo | None]:
        if days is None:
            days = list(range(7))

        exclude = set(exclude_ids or [])
        seen_ids: set[str] = set()

        available_custom = []
        for r in self._custom_recipes:
            if r.id not in exclude and r.id not in seen_ids:
                seen_ids.add(r.id)
                available_custom.append(r)

        available_other = []
        for r in self._managed_recipes + self._search_recipes:
            if r.id not in exclude and r.id not in seen_ids:
                seen_ids.add(r.id)
                available_other.append(r)

        n_custom = round(len(days) * custom_ratio / 100)
        n_other = len(days) - n_custom

        if len(available_custom) < n_custom:
            n_custom = len(available_custom)
            n_other = len(days) - n_custom
        if len(available_other) < n_other:
            n_other = len(available_other)
            n_custom = min(len(available_custom), len(days) - n_other)

        selected = (
            random.sample(available_custom, min(n_custom, len(available_custom)))
            + random.sample(available_other, min(n_other, len(available_other)))
        )
        random.shuffle(selected)

        enriched = await asyncio.gather(*[self._enrich_recipe(r) for r in selected])

        plan: dict[str, RecipeInfo | None] = {}
        for i, day_idx in enumerate(days):
            plan[WEEKDAYS_DE[day_idx]] = enriched[i] if i < len(enriched) else None
        return plan

    async def generate_single(
        self, custom_ratio: int = 70, exclude_ids: list[str] | None = None,
    ) -> RecipeInfo | None:
        exclude = set(exclude_ids or [])
        available_custom = [r for r in self._custom_recipes if r.id not in exclude]
        available_other = [r for r in self._managed_recipes + self._search_recipes if r.id not in exclude]

        use_custom = random.randint(1, 100) <= custom_ratio
        if use_custom and available_custom:
            recipe = random.choice(available_custom)
        elif available_other:
            recipe = random.choice(available_other)
        elif available_custom:
            recipe = random.choice(available_custom)
        else:
            return None
        return await self._enrich_recipe(recipe)

    async def save_to_calendar(
        self, plan: dict[str, dict], week_offset: int = 0, add_to_shopping_list: bool = False,
    ) -> dict:
        if not self._cookidoo or not self._logged_in:
            raise RuntimeError("Nicht eingeloggt")

        today = date.today()
        monday = today - timedelta(days=today.weekday()) + timedelta(weeks=week_offset)

        saved = []
        errors = []
        recipe_ids_for_shopping = []

        for day_name, recipe_data in plan.items():
            if recipe_data is None:
                continue
            try:
                day_idx = WEEKDAYS_DE.index(day_name)
            except ValueError:
                continue

            target_date = monday + timedelta(days=day_idx)
            recipe_id = recipe_data["id"]

            try:
                await self._cookidoo.add_recipes_to_calendar(target_date, [recipe_id])
                saved.append({"day": day_name, "recipe": recipe_data["name"]})
                recipe_ids_for_shopping.append(recipe_id)
            except Exception as e:
                errors.append({"day": day_name, "error": str(e)})

        # Zutaten zur Einkaufsliste hinzufügen
        shopping_added = 0
        if add_to_shopping_list and recipe_ids_for_shopping:
            try:
                items = await self._cookidoo.add_ingredient_items_for_recipes(recipe_ids_for_shopping)
                shopping_added = len(items)
                log.info(f"Einkaufsliste: {shopping_added} Zutaten hinzugefügt")
            except Exception as e:
                log.warning(f"Einkaufsliste Fehler: {e}")
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

        # Listen direkt laden
        lists_response = await self._bring.load_lists()
        self._lists = [
            {"uuid": lst.listUuid, "name": lst.name}
            for lst in lists_response.lists
        ]

        return {"lists": self._lists}

    async def get_lists(self) -> list[dict]:
        if not self._bring or not self._logged_in:
            raise RuntimeError("Bring! nicht eingeloggt")
        lists_response = await self._bring.load_lists()
        self._lists = [
            {"uuid": lst.listUuid, "name": lst.name}
            for lst in lists_response.lists
        ]
        return self._lists

    async def add_ingredients(
        self, list_uuid: str, cookidoo: Cookidoo, recipe_ids: list[str],
    ) -> int:
        """Zutaten aus Cookidoo-Rezepten zur Bring!-Liste hinzufügen."""
        if not self._bring or not self._logged_in:
            raise RuntimeError("Bring! nicht eingeloggt")

        # Zutaten von Cookidoo holen
        items = await cookidoo.add_ingredient_items_for_recipes(recipe_ids)

        # Zu Bring! hinzufügen
        added = 0
        for item in items:
            try:
                await self._bring.save_item(
                    list_uuid,
                    item.name,
                    specification=item.description,
                )
                added += 1
            except Exception as e:
                log.warning(f"Bring! Item '{item.name}' fehlgeschlagen: {e}")

        log.info(f"Bring!: {added}/{len(items)} Zutaten hinzugefügt")
        return added

    async def close(self):
        if self._session:
            await self._session.close()
            self._session = None
        self._logged_in = False
