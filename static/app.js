// Cookidoo Wochenplan-Generator - Frontend

const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
const DAY_ABBR = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const STORAGE_KEY = "mealplan_filters_v3";

// Slot order and metadata
const SLOT_ORDER = ["m_v", "m", "m_d", "a_v", "a", "a_d"];
const SLOT_NAV_LABELS = {
    m_v: "Mittag · Vorspeise",
    m: "Mittag · Hauptgang",
    m_d: "Mittag · Dessert",
    a_v: "Abend · Vorspeise",
    a: "Abend · Hauptgang",
    a_d: "Abend · Dessert",
};
const SLOT_BADGE_LABELS = {
    m_v: "Vorspeise", m: "Hauptgang", m_d: "Dessert",
    a_v: "Vorspeise", a: "Hauptgang", a_d: "Dessert",
};
const SLOT_BADGE_CLASS = {
    m_v: "starter", m: "main", m_d: "dessert",
    a_v: "starter", a: "main", a_d: "dessert",
};

// ===== State =====

let currentPlan = {};       // {dayName: {slotKey: recipe|null}}
let planGenerated = false;
let currentUserIsAdmin = false;

// Per-day config: {dayIdx: {m,a,m_v,m_d,a_v,a_d}}
let dayConfig = {};
WEEKDAYS.forEach((_, i) => {
    dayConfig[i] = { m: true, a: false, m_v: false, m_d: false, a_v: false, a_d: false };
});

// Nav state: {dayName: slotKey} – currently visible slot per day
let dayCardNav = {};

// Per-day filter overrides: {dayIdx: {category, cuisine}}
let dayFilterOverride = {};

// Ingredient state
let excludeIngredients = [];
let preferredIngredients = [];

// Per-day filter popover
let openPerDayFilterIdx = null;
let perDayOriginalSlots = [];

// ===== Helpers =====

function showLoading(text = "Laden...") {
    document.getElementById("loading-text").textContent = text;
    document.getElementById("loading").classList.remove("hidden");
}

function hideLoading() {
    document.getElementById("loading").classList.add("hidden");
}

function showStatus(elementId, message, type = "info") {
    const el = document.getElementById(elementId);
    el.textContent = message;
    el.className = `status ${type}`;
    el.classList.remove("hidden");
}

function hideStatus(elementId) {
    document.getElementById(elementId).classList.add("hidden");
}

async function apiCall(url, data = {}) {
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || "Unbekannter Fehler");
    return result;
}

async function apiGet(url) {
    const response = await fetch(url);
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || "Unbekannter Fehler");
    return result;
}

async function apiDelete(url) {
    const response = await fetch(url, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || "Unbekannter Fehler");
    return result;
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

// ===== Slot helpers =====

function getActiveSlots(dayIdx) {
    const cfg = dayConfig[dayIdx];
    return SLOT_ORDER.filter(sk => cfg[sk]);
}

function getDaySlots() {
    // Returns {dayIdx: ["m","a","m_v",...]} for active days
    const result = {};
    for (let i = 0; i < 7; i++) {
        const slots = getActiveSlots(i);
        if (slots.length > 0) result[i] = slots;
    }
    return result;
}

function getMaxTimePerSlot() {
    const t0 = document.getElementById("max-time-0");
    const t1 = document.getElementById("max-time-1");
    return {
        m: t0 && t0.value ? parseInt(t0.value) : null,
        a: t1 && t1.value ? parseInt(t1.value) : null,
    };
}

// ===== Day Card Rendering =====

function renderDayCards() {
    const grid = document.getElementById("plan-grid");
    grid.innerHTML = "";
    WEEKDAYS.forEach((dayName, dayIdx) => {
        const wrapper = document.createElement("div");
        wrapper.className = "day-card-wrapper";

        const label = document.createElement("div");
        label.className = "day-card-label";
        label.textContent = dayName;

        const card = document.createElement("div");
        card.className = "day-card";
        const hasRecipes = planGenerated && currentPlan[dayName] && Object.keys(currentPlan[dayName]).length > 0;
        if (hasRecipes) {
            card.innerHTML = buildRecipeCard(dayName, dayIdx);
        } else {
            card.classList.add("config-card");
            const cfg = dayConfig[dayIdx];
            const anyActive = cfg.m || cfg.a;
            if (!anyActive) card.classList.add("inactive");
            card.innerHTML = buildConfigCard(dayName, dayIdx);
        }

        wrapper.appendChild(label);
        wrapper.appendChild(card);
        grid.appendChild(wrapper);
    });
    attachDayCardEvents();
}

function buildConfigCard(dayName, dayIdx) {
    const cfg = dayConfig[dayIdx];
    return `
        <div class="day-meal-config">
            <div class="day-meal-main-row">
                <button class="day-meal-main-toggle${cfg.m ? " active" : ""}" data-day="${dayIdx}" data-slot="m">
                    <span class="toggle-icon">☀</span>
                    Mittag
                </button>
                <button class="day-meal-main-toggle${cfg.a ? " active" : ""}" data-day="${dayIdx}" data-slot="a">
                    <span class="toggle-icon">🌙</span>
                    Abend
                </button>
            </div>
            <div class="day-meal-sub-row${cfg.m ? "" : " hidden"}">
                <button class="day-meal-sub-toggle${cfg.m_v ? " active" : ""}" data-day="${dayIdx}" data-slot="m_v">Vorspeise</button>
                <button class="day-meal-sub-toggle${cfg.m_d ? " active" : ""}" data-day="${dayIdx}" data-slot="m_d">Dessert</button>
            </div>
            <div class="day-meal-sub-row${cfg.a ? "" : " hidden"}">
                <button class="day-meal-sub-toggle${cfg.a_v ? " active" : ""}" data-day="${dayIdx}" data-slot="a_v">Vorspeise</button>
                <button class="day-meal-sub-toggle${cfg.a_d ? " active" : ""}" data-day="${dayIdx}" data-slot="a_d">Dessert</button>
            </div>
        </div>`;
}

function buildRecipeCard(dayName, dayIdx) {
    const activeSlots = getActiveSlots(dayIdx);
    const slots = currentPlan[dayName] || {};

    if (activeSlots.length === 0) {
        return buildConfigCard(dayName, dayIdx);
    }

    // Ensure nav state is valid
    if (!dayCardNav[dayName] || !activeSlots.includes(dayCardNav[dayName])) {
        dayCardNav[dayName] = activeSlots[0];
    }

    const currentSlotKey = dayCardNav[dayName];
    const currentSlotIdx = activeSlots.indexOf(currentSlotKey);
    const recipe = slots[currentSlotKey] || null;
    const badgeClass = SLOT_BADGE_CLASS[currentSlotKey] || "main";
    const badgeLabel = SLOT_BADGE_LABELS[currentSlotKey] || currentSlotKey;
    const hasOverride = dayFilterOverride[dayIdx] && (
        dayFilterOverride[dayIdx].category || dayFilterOverride[dayIdx].cuisine || dayFilterOverride[dayIdx].max_time
    );

    // Arrows: only if multiple slots, no label
    let arrowsHtml = "";
    if (activeSlots.length > 1) {
        const prevDisabled = currentSlotIdx === 0 ? "disabled" : "";
        const nextDisabled = currentSlotIdx === activeSlots.length - 1 ? "disabled" : "";
        arrowsHtml = `
            <button class="btn-nav-arrow btn-nav-prev" data-day="${dayName}" ${prevDisabled}>&#9664;</button>
            <button class="btn-nav-arrow btn-nav-next" data-day="${dayName}" ${nextDisabled}>&#9654;</button>`;
    }

    return `
        <div class="day-card-body">
            ${buildRecipeBody(recipe)}
            <div class="day-card-nav">
                <div class="day-card-nav-left">
                    <div class="day-card-nav-arrows">${arrowsHtml}</div>
                    <span class="slot-type-tag ${badgeClass}">${badgeLabel}</span>
                </div>
                <div class="day-card-nav-actions">
                    <button class="btn-nav-more" data-day="${dayName}" data-dayidx="${dayIdx}" data-slot="${currentSlotKey}" title="Aktionen">&#8942;</button>
                </div>
            </div>
        </div>`;
}

function buildStars(rating) {
    if (!rating || rating <= 0) return "";
    const full = Math.floor(rating);
    const half = rating - full >= 0.25 && rating - full < 0.75;
    const empty = 5 - full - (half ? 1 : 0);
    return (
        "★".repeat(full) +
        (half ? "½" : "") +
        "☆".repeat(empty)
    );
}

function buildRecipeBody(recipe) {
    if (!recipe) return `<div class="no-recipe">Kein Rezept verfügbar</div>`;

    const imgHtml = recipe.thumbnail || recipe.image
        ? `<img class="recipe-image" src="${recipe.image || recipe.thumbnail}" alt="${escapeHtml(recipe.name)}" loading="lazy">`
        : `<div class="recipe-image-placeholder">🍽️</div>`;

    const nameHtml = recipe.url
        ? `<a href="${recipe.url}" target="_blank" rel="noopener">${escapeHtml(recipe.name)}</a>`
        : escapeHtml(recipe.name);

    const starsHtml = recipe.rating > 0
        ? `<span class="recipe-stars">${buildStars(recipe.rating)}</span>`
        : "";

    return `
        ${imgHtml}
        <div class="recipe-info">
            <div class="recipe-name">${nameHtml}</div>
            <div class="recipe-meta">
                ${starsHtml}
                <span class="recipe-time">${recipe.total_time_str}</span>
            </div>
        </div>`;
}

function attachDayCardEvents() {
    const grid = document.getElementById("plan-grid");

    // Config: main toggles (Mittag / Abend)
    grid.querySelectorAll(".day-meal-main-toggle").forEach(btn => {
        btn.addEventListener("click", () => {
            const dayIdx = parseInt(btn.dataset.day);
            const slot = btn.dataset.slot;
            dayConfig[dayIdx][slot] = !dayConfig[dayIdx][slot];
            // Disable sub-slots when main is turned off
            if (!dayConfig[dayIdx][slot]) {
                if (slot === "m") { dayConfig[dayIdx].m_v = false; dayConfig[dayIdx].m_d = false; }
                if (slot === "a") { dayConfig[dayIdx].a_v = false; dayConfig[dayIdx].a_d = false; }
            }
            renderDayCards();
            saveFiltersToStorage();
        });
    });

    // Config: sub-toggles (Vorspeise / Dessert)
    grid.querySelectorAll(".day-meal-sub-toggle").forEach(btn => {
        btn.addEventListener("click", () => {
            const dayIdx = parseInt(btn.dataset.day);
            const slot = btn.dataset.slot;
            dayConfig[dayIdx][slot] = !dayConfig[dayIdx][slot];
            renderDayCards();
            saveFiltersToStorage();
        });
    });

    // Recipe: navigation
    grid.querySelectorAll(".btn-nav-prev").forEach(btn => {
        btn.addEventListener("click", () => navigateCard(btn.dataset.day, -1));
    });
    grid.querySelectorAll(".btn-nav-next").forEach(btn => {
        btn.addEventListener("click", () => navigateCard(btn.dataset.day, +1));
    });

    // Recipe: more-button → globales Dropdown öffnen
    grid.querySelectorAll(".btn-nav-more").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            openCardActionDropdown(btn);
        });
    });

}

// ===== Globales Card-Aktionsmenü =====

function openCardActionDropdown(btn) {
    const dayName = btn.dataset.day;
    const dayIdx = parseInt(btn.dataset.dayidx);
    const slotKey = btn.dataset.slot;
    const dropdown = document.getElementById("card-action-dropdown");
    const hasOverride = dayFilterOverride[dayIdx] && (
        dayFilterOverride[dayIdx].category || dayFilterOverride[dayIdx].cuisine || dayFilterOverride[dayIdx].max_time
    );
    const cfg = dayConfig[dayIdx];

    // Mahlzeit-Toggles
    function togBtn(slot, label, parentSlot) {
        const active = cfg[slot];
        const disabled = parentSlot && !cfg[parentSlot] ? " cad-disabled" : "";
        return `<button class="cad-item cad-toggle${active ? " active" : ""}${disabled}" data-cad-slot="${slot}" data-cad-day="${dayIdx}">${active ? "✓" : ""} ${label}</button>`;
    }

    dropdown.innerHTML = `
        <button class="cad-item" data-cad-action="reroll" data-cad-day="${dayName}" data-cad-slot="${slotKey}">Neu würfeln</button>
        <button class="cad-item${hasOverride ? " active" : ""}" data-cad-action="filter" data-cad-day="${dayIdx}">Menü-Filter…</button>
        <div class="cad-separator"></div>
        <div class="cad-section-label">Mahlzeiten</div>
        ${togBtn("m", "☀ Mittag")}
        ${togBtn("m_v", "↳ Vorspeise", "m")}
        ${togBtn("m_d", "↳ Dessert", "m")}
        ${togBtn("a", "🌙 Abend")}
        ${togBtn("a_v", "↳ Vorspeise", "a")}
        ${togBtn("a_d", "↳ Dessert", "a")}
    `;

    const rect = btn.getBoundingClientRect();
    const isOpen = !dropdown.classList.contains("hidden");
    dropdown.classList.toggle("hidden", isOpen);

    if (!isOpen) {
        // Erst rechtsbündig unter dem Button positionieren
        dropdown.style.top = `${rect.bottom + 4}px`;
        dropdown.style.right = `${window.innerWidth - rect.right}px`;
        dropdown.style.left = "auto";
        dropdown.style.bottom = "auto";

        // Nach dem Rendern prüfen ob das Dropdown unten aus dem Viewport ragt
        requestAnimationFrame(() => {
            const ddRect = dropdown.getBoundingClientRect();
            if (ddRect.bottom > window.innerHeight - 8) {
                dropdown.style.top = "auto";
                dropdown.style.bottom = `${window.innerHeight - rect.top + 4}px`;
            }
        });
    }

    if (!isOpen) {
        // Events binden
        dropdown.querySelectorAll("[data-cad-action='reroll']").forEach(el => {
            el.addEventListener("click", () => {
                dropdown.classList.add("hidden");
                rerollDay(el.dataset.cadDay, el.dataset.cadSlot);
            });
        });
        dropdown.querySelectorAll("[data-cad-action='filter']").forEach(el => {
            el.addEventListener("click", (e) => {
                dropdown.classList.add("hidden");
                openPerDayFilter(parseInt(el.dataset.cadDay), e);
            });
        });
        dropdown.querySelectorAll(".cad-toggle:not(.cad-disabled)").forEach(el => {
            el.addEventListener("click", async () => {
                const idx = parseInt(el.dataset.cadDay);
                const slot = el.dataset.cadSlot;
                const wasActive = dayConfig[idx][slot];
                dropdown.classList.add("hidden");

                dayConfig[idx][slot] = !wasActive;
                if (wasActive) {
                    // Slot deaktiviert → Unterslots auch deaktivieren + aus Plan entfernen
                    if (slot === "m") { dayConfig[idx].m_v = false; dayConfig[idx].m_d = false; }
                    if (slot === "a") { dayConfig[idx].a_v = false; dayConfig[idx].a_d = false; }
                    const dayName = WEEKDAYS[idx];
                    if (currentPlan[dayName]) {
                        const toRemove = slot === "m" ? ["m","m_v","m_d"] : slot === "a" ? ["a","a_v","a_d"] : [slot];
                        toRemove.forEach(s => { delete currentPlan[dayName][s]; });
                    }
                } else {
                    // Slot neu aktiviert → sofort Rezept hinzufügen
                    const dayName = WEEKDAYS[idx];
                    saveFiltersToStorage();
                    renderDayCards();
                    await rerollDay(dayName, slot);
                    return;
                }
                saveFiltersToStorage();
                renderDayCards();
            });
        });
    }
}

function navigateCard(dayName, dir) {
    const dayIdx = WEEKDAYS.indexOf(dayName);
    const activeSlots = getActiveSlots(dayIdx);
    if (activeSlots.length === 0) return;
    const current = dayCardNav[dayName] || activeSlots[0];
    const idx = activeSlots.indexOf(current);
    dayCardNav[dayName] = activeSlots[Math.max(0, Math.min(activeSlots.length - 1, idx + dir))];
    renderDayCards();
}

// ===== Per-Day Filter Popover =====

function renderPerDayMealSection(dayIdx) {
    const container = document.getElementById("per-day-meal-section");
    if (!container) return;
    const cfg = dayConfig[dayIdx];

    container.innerHTML = `
        <div class="section-label">Mahlzeiten</div>
        <div class="per-day-meal-group">
            <button class="day-meal-main-toggle compact${cfg.m ? " active" : ""}" data-pd-slot="m">
                <span class="toggle-icon">☀</span> Mittag
            </button>
            <div class="day-meal-sub-row compact${cfg.m ? "" : " hidden"}" id="pd-sub-m">
                <button class="day-meal-sub-toggle compact${cfg.m_v ? " active" : ""}" data-pd-slot="m_v">Vorspeise</button>
                <button class="day-meal-sub-toggle compact${cfg.m_d ? " active" : ""}" data-pd-slot="m_d">Dessert</button>
            </div>
        </div>
        <div class="per-day-meal-group">
            <button class="day-meal-main-toggle compact${cfg.a ? " active" : ""}" data-pd-slot="a">
                <span class="toggle-icon">🌙</span> Abend
            </button>
            <div class="day-meal-sub-row compact${cfg.a ? "" : " hidden"}" id="pd-sub-a">
                <button class="day-meal-sub-toggle compact${cfg.a_v ? " active" : ""}" data-pd-slot="a_v">Vorspeise</button>
                <button class="day-meal-sub-toggle compact${cfg.a_d ? " active" : ""}" data-pd-slot="a_d">Dessert</button>
            </div>
        </div>`;

    container.querySelectorAll("[data-pd-slot]").forEach(btn => {
        btn.addEventListener("click", () => {
            const slot = btn.dataset.pdSlot;
            dayConfig[dayIdx][slot] = !dayConfig[dayIdx][slot];
            if (!dayConfig[dayIdx][slot]) {
                if (slot === "m") { dayConfig[dayIdx].m_v = false; dayConfig[dayIdx].m_d = false; }
                if (slot === "a") { dayConfig[dayIdx].a_v = false; dayConfig[dayIdx].a_d = false; }
            }
            renderPerDayMealSection(dayIdx);
            renderDayCards();
            saveFiltersToStorage();
        });
    });
}

function openPerDayFilter(dayIdx, event) {
    openPerDayFilterIdx = dayIdx;
    perDayOriginalSlots = [...getActiveSlots(dayIdx)];

    const popover = document.getElementById("per-day-filter-popover");
    const backdrop = document.getElementById("per-day-filter-backdrop");

    document.getElementById("per-day-filter-title").textContent = `Filter: ${WEEKDAYS[dayIdx]}`;
    const override = dayFilterOverride[dayIdx] || {};
    document.getElementById("per-day-category").value = override.category || "";
    document.getElementById("per-day-cuisine").value = override.cuisine || "";
    const maxTimeEl = document.getElementById("per-day-max-time");
    if (maxTimeEl) maxTimeEl.value = override.max_time || "";

    renderPerDayMealSection(dayIdx);

    // Position popover near the button
    const btn = event.currentTarget;
    const rect = btn.getBoundingClientRect();
    if (window.innerWidth < 640) {
        popover.style.left = "50%";
        popover.style.top = "50%";
        popover.style.transform = "translate(-50%, -50%)";
    } else {
        const left = Math.min(rect.left, window.innerWidth - 320);
        popover.style.left = `${Math.max(8, left)}px`;
        popover.style.top = `${rect.bottom + 8}px`;
        popover.style.transform = "none";
    }

    popover.classList.add("open");
    backdrop.classList.add("open");
}

function closePerDayFilter() {
    document.getElementById("per-day-filter-popover").classList.remove("open");
    document.getElementById("per-day-filter-backdrop").classList.remove("open");
    openPerDayFilterIdx = null;
}

document.getElementById("per-day-filter-close").addEventListener("click", closePerDayFilter);
document.getElementById("per-day-filter-backdrop").addEventListener("click", closePerDayFilter);

document.getElementById("per-day-clear").addEventListener("click", () => {
    if (openPerDayFilterIdx === null) return;
    delete dayFilterOverride[openPerDayFilterIdx];
    document.getElementById("per-day-category").value = "";
    document.getElementById("per-day-cuisine").value = "";
    const maxTimeEl = document.getElementById("per-day-max-time");
    if (maxTimeEl) maxTimeEl.value = "";
    closePerDayFilter();
    renderDayCards();
    saveFiltersToStorage();
});

document.getElementById("per-day-apply").addEventListener("click", async () => {
    if (openPerDayFilterIdx === null) return;
    const dayIdx = openPerDayFilterIdx;
    const category = document.getElementById("per-day-category").value;
    const cuisine = document.getElementById("per-day-cuisine").value;
    const maxTimeEl = document.getElementById("per-day-max-time");
    const max_time = maxTimeEl ? maxTimeEl.value : "";
    dayFilterOverride[dayIdx] = { category, cuisine, max_time };

    // Find slots that were just added
    const currentSlots = getActiveSlots(dayIdx);
    const addedSlots = currentSlots.filter(sk => !perDayOriginalSlots.includes(sk));

    closePerDayFilter();
    renderDayCards();
    saveFiltersToStorage();

    if (planGenerated) {
        const dayName = WEEKDAYS[dayIdx];
        if (addedSlots.length > 0) {
            // Generate recipes for newly added slots
            for (const sk of addedSlots) {
                await rerollDay(dayName, sk);
            }
        } else {
            // Reroll current slot with new filter
            const slotKey = dayCardNav[dayName] || getActiveSlots(dayIdx)[0];
            if (slotKey) await rerollDay(dayName, slotKey);
        }
    }
});

// ===== Ingredient Chips =====

function addIngredient(type, value) {
    const v = value.trim();
    if (!v) return;
    if (type === "exclude") {
        if (!excludeIngredients.includes(v)) excludeIngredients.push(v);
    } else {
        if (!preferredIngredients.includes(v)) preferredIngredients.push(v);
    }
    renderIngredientChips();
    saveFiltersToStorage();
}

function removeIngredient(type, idx) {
    if (type === "exclude") excludeIngredients.splice(idx, 1);
    else preferredIngredients.splice(idx, 1);
    renderIngredientChips();
    updateFilterBadge();
    saveFiltersToStorage();
}

function renderIngredientChips() {
    const excludeContainer = document.getElementById("exclude-chips");
    const preferContainer = document.getElementById("prefer-chips");

    excludeContainer.innerHTML = excludeIngredients.map((ing, i) =>
        `<span class="ingredient-chip exclude">${escapeHtml(ing)}<button class="ingredient-chip-remove" data-type="exclude" data-idx="${i}">×</button></span>`
    ).join("");

    preferContainer.innerHTML = preferredIngredients.map((ing, i) =>
        `<span class="ingredient-chip prefer">${escapeHtml(ing)}<button class="ingredient-chip-remove" data-type="prefer" data-idx="${i}">×</button></span>`
    ).join("");

    document.querySelectorAll(".ingredient-chip-remove").forEach(btn => {
        btn.addEventListener("click", () => removeIngredient(btn.dataset.type, parseInt(btn.dataset.idx)));
    });

    updateFilterBadge();
}

// ===== Ingredient Autocomplete =====

let _autocompleteTimer = null;

function setupIngredientAutocomplete(inputId, dropdownId, addBtnId, type) {
    const input = document.getElementById(inputId);
    const dropdown = document.getElementById(dropdownId);
    const addBtn = document.getElementById(addBtnId);

    // Filter-Panel hat CSS transform → position:fixed wäre relativ zum Panel, nicht zum Viewport.
    // Durch Verschieben in <body> funktioniert fixed-Positioning korrekt.
    document.body.appendChild(dropdown);

    const doAdd = () => {
        addIngredient(type, input.value);
        input.value = "";
        dropdown.classList.add("hidden");
    };

    addBtn.addEventListener("click", doAdd);

    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); doAdd(); return; }
        // Keyboard navigation
        const items = dropdown.querySelectorAll(".ingredient-autocomplete-item[data-value]");
        const focused = dropdown.querySelector(".ingredient-autocomplete-item.focused");
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (items.length === 0) return;
            let idx = Array.from(items).indexOf(focused);
            if (e.key === "ArrowDown") idx = (idx + 1) % items.length;
            else idx = (idx - 1 + items.length) % items.length;
            items.forEach(i => i.classList.remove("focused"));
            items[idx].classList.add("focused");
            input.value = items[idx].dataset.value;
        }
        if (e.key === "Escape") dropdown.classList.add("hidden");
    });

    input.addEventListener("input", () => {
        clearTimeout(_autocompleteTimer);
        const q = input.value.trim();
        if (q.length < 2) { dropdown.classList.add("hidden"); return; }
        // Position relativ zum Input, aber fixed (entkommt overflow-Clipping des Filter-Panels)
        const rect = input.getBoundingClientRect();
        dropdown.style.top = `${rect.bottom + 2}px`;
        dropdown.style.left = `${rect.left}px`;
        dropdown.style.width = `${rect.width}px`;
        _autocompleteTimer = setTimeout(() => fetchIngredientSuggestions(q, dropdownId, type, input), 380);
    });

    input.addEventListener("blur", () => {
        setTimeout(() => dropdown.classList.add("hidden"), 200);
    });
}

async function fetchIngredientSuggestions(query, dropdownId, type, input) {
    const dropdown = document.getElementById(dropdownId);

    // Ladeindikator
    dropdown.innerHTML = `<div class="ingredient-autocomplete-loading">Suche...</div>`;
    dropdown.classList.remove("hidden");

    try {
        const resp = await fetch(`/api/ingredient-suggestions?q=${encodeURIComponent(query)}`);
        if (!resp.ok) { dropdown.classList.add("hidden"); return; }
        const data = await resp.json();

        if (!data.suggestions || data.suggestions.length === 0) {
            if (data.count > 0) {
                dropdown.innerHTML = `<div class="ingredient-autocomplete-footer">Keine Vorschläge – „${escapeHtml(query)}" in ${data.count} Rezepten gefunden</div>`;
            } else {
                dropdown.innerHTML = `<div class="ingredient-autocomplete-footer">Keine Treffer für „${escapeHtml(query)}"</div>`;
            }
            return;
        }

        dropdown.innerHTML =
            data.suggestions.map(s =>
                `<div class="ingredient-autocomplete-item" data-value="${escapeHtml(s)}"><span>${escapeHtml(s)}</span></div>`
            ).join("") +
            (data.count ? `<div class="ingredient-autocomplete-footer">In ${data.count} Cookidoo-Rezepten</div>` : "");

        dropdown.querySelectorAll(".ingredient-autocomplete-item[data-value]").forEach(item => {
            item.addEventListener("mousedown", (e) => {
                e.preventDefault();
                addIngredient(type, item.dataset.value);
                input.value = "";
                dropdown.classList.add("hidden");
            });
        });
    } catch (e) {
        dropdown.innerHTML = `<div class="ingredient-autocomplete-footer">Fehler beim Laden</div>`;
    }
}

// ===== Filter helpers =====

function getCustomRatio() {
    return parseInt(document.getElementById("custom-ratio").value);
}

function getSelectedFilters(containerId) {
    const container = document.getElementById(containerId);
    const checked = Array.from(container.querySelectorAll("input[type=checkbox]:checked"));
    if (checked.some(cb => cb.value === "alle")) return [];
    return checked.map(cb => cb.value);
}

function initFilterTags(containerId) {
    const container = document.getElementById(containerId);
    const checkboxes = container.querySelectorAll("input[type=checkbox]");
    const alleCheckbox = container.querySelector("input[value=alle]");

    checkboxes.forEach(cb => {
        cb.addEventListener("change", () => {
            if (cb.value === "alle" && cb.checked) {
                checkboxes.forEach(other => {
                    if (other !== cb) { other.checked = false; other.closest(".filter-tag").classList.remove("active"); }
                });
                cb.closest(".filter-tag").classList.add("active");
            } else if (cb.value !== "alle") {
                if (alleCheckbox) { alleCheckbox.checked = false; alleCheckbox.closest(".filter-tag").classList.remove("active"); }
                cb.closest(".filter-tag").classList.toggle("active", cb.checked);
                const anyChecked = Array.from(checkboxes).some(c => c.checked);
                if (!anyChecked && alleCheckbox) { alleCheckbox.checked = true; alleCheckbox.closest(".filter-tag").classList.add("active"); }
            }
            updateFilterBadge();
            saveFiltersToStorage();
        });
    });
}

// ===== Filter Panel =====

function openFilterPanel() {
    document.getElementById("filter-panel").classList.add("open");
    document.getElementById("filter-backdrop").classList.add("open");
    document.getElementById("filter-btn").classList.add("active");
}

function closeFilterPanel() {
    document.getElementById("filter-panel").classList.remove("open");
    document.getElementById("filter-backdrop").classList.remove("open");
    document.getElementById("filter-btn").classList.remove("active");
}

function updateFilterBadge() {
    let count = 0;
    if (getSelectedFilters("category-filters").length > 0) count++;
    if (getSelectedFilters("cuisine-filters").length > 0) count++;
    const maxTime = getMaxTimePerSlot();
    if (maxTime.m !== null || maxTime.a !== null) count++;
    if (getCustomRatio() !== 70) count++;
    if (excludeIngredients.length > 0) count++;
    if (preferredIngredients.length > 0) count++;

    const badge = document.getElementById("filter-badge");
    badge.textContent = count;
    badge.classList.toggle("hidden", count === 0);

    document.getElementById("filter-reset-btn")?.classList.toggle("hidden", count === 0);
}

function resetFilters() {
    document.querySelectorAll("#category-filters input[type=checkbox]").forEach(cb => {
        cb.checked = cb.value === "alle";
        cb.closest(".filter-tag").classList.toggle("active", cb.value === "alle");
    });
    document.querySelectorAll("#cuisine-filters input[type=checkbox]").forEach(cb => {
        cb.checked = cb.value === "alle";
        cb.closest(".filter-tag").classList.toggle("active", cb.value === "alle");
    });
    document.getElementById("max-time-0").value = "";
    document.getElementById("max-time-1").value = "";
    document.getElementById("custom-ratio").value = 70;
    document.getElementById("ratio-display").textContent = "70% eigene / 30% neue";
    excludeIngredients = [];
    preferredIngredients = [];
    renderIngredientChips();
    updateFilterBadge();
    saveFiltersToStorage();
}

// ===== Filter localStorage =====

function saveFiltersToStorage() {
    try {
        const data = {
            categories: getSelectedFilters("category-filters"),
            cuisines: getSelectedFilters("cuisine-filters"),
            max_time_0: document.getElementById("max-time-0").value,
            max_time_1: document.getElementById("max-time-1").value,
            custom_ratio: getCustomRatio(),
            day_config: dayConfig,
            day_filter_override: dayFilterOverride,
            exclude_ingredients: excludeIngredients,
            preferred_ingredients: preferredIngredients,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
        console.warn("Filter speichern fehlgeschlagen:", e);
    }
}

function loadFiltersFromStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);

        if (Array.isArray(data.categories)) {
            document.querySelectorAll("#category-filters input[type=checkbox]").forEach(cb => {
                const active = data.categories.length === 0 ? cb.value === "alle" : data.categories.includes(cb.value);
                cb.checked = active;
                cb.closest(".filter-tag").classList.toggle("active", active);
            });
        }
        if (Array.isArray(data.cuisines)) {
            document.querySelectorAll("#cuisine-filters input[type=checkbox]").forEach(cb => {
                const active = data.cuisines.length === 0 ? cb.value === "alle" : data.cuisines.includes(cb.value);
                cb.checked = active;
                cb.closest(".filter-tag").classList.toggle("active", active);
            });
        }
        if (data.max_time_0 !== undefined) document.getElementById("max-time-0").value = data.max_time_0;
        if (data.max_time_1 !== undefined) document.getElementById("max-time-1").value = data.max_time_1;
        if (data.custom_ratio !== undefined) {
            document.getElementById("custom-ratio").value = data.custom_ratio;
            document.getElementById("ratio-display").textContent = `${data.custom_ratio}% eigene / ${100 - data.custom_ratio}% neue`;
        }
        if (data.day_config) {
            for (let i = 0; i < 7; i++) {
                if (data.day_config[i]) {
                    dayConfig[i] = {
                        m: !!data.day_config[i].m, a: !!data.day_config[i].a,
                        m_v: !!data.day_config[i].m_v, m_d: !!data.day_config[i].m_d,
                        a_v: !!data.day_config[i].a_v, a_d: !!data.day_config[i].a_d,
                    };
                }
            }
        }
        if (data.day_filter_override) dayFilterOverride = data.day_filter_override;
        if (Array.isArray(data.exclude_ingredients)) excludeIngredients = data.exclude_ingredients;
        if (Array.isArray(data.preferred_ingredients)) preferredIngredients = data.preferred_ingredients;

        renderIngredientChips();
        updateFilterBadge();
    } catch (e) {
        console.warn("Filter laden fehlgeschlagen:", e);
    }
}

// ===== Auth =====

function showScreen(screenId) {
    ["auth-screen", "login-screen", "admin-screen", "main-app"].forEach(id => {
        document.getElementById(id).classList.add("hidden");
    });
    document.getElementById(screenId).classList.remove("hidden");
}

document.querySelectorAll(".auth-tab").forEach(tab => {
    tab.addEventListener("click", () => {
        document.querySelectorAll(".auth-tab").forEach(t => t.classList.remove("active"));
        document.querySelectorAll(".auth-tab-content").forEach(c => c.classList.add("hidden"));
        tab.classList.add("active");
        document.querySelector(`.auth-tab-content[data-tab="${tab.dataset.tab}"]`).classList.remove("hidden");
    });
});

document.getElementById("auth-login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideStatus("auth-status");
    const username = document.getElementById("auth-username").value;
    const password = document.getElementById("auth-password").value;
    try {
        const result = await apiCall("/api/auth/login", { username, password });
        onAuthSuccess(result.username, result.is_admin);
    } catch (err) {
        showStatus("auth-status", err.message, "error");
    }
});

document.getElementById("auth-register-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideStatus("auth-status");
    const username = document.getElementById("reg-username").value;
    const password = document.getElementById("reg-password").value;
    const invite_code = document.getElementById("reg-invite").value;
    try {
        const result = await apiCall("/api/auth/register", { username, password, invite_code });
        onAuthSuccess(result.username, result.is_admin);
    } catch (err) {
        showStatus("auth-status", err.message, "error");
    }
});

async function onAuthSuccess(username, isAdmin) {
    currentUserIsAdmin = isAdmin;
    document.getElementById("app-user-name").textContent = username;
    document.getElementById("header-right").classList.remove("hidden");
    document.getElementById("invite-btn").classList.toggle("hidden", !isAdmin);
    if (isAdmin) {
        showScreen("admin-screen");
        loadAdminData();
    } else {
        await tryAutoConnectCookidoo();
    }
}

document.getElementById("logout-btn").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    document.getElementById("header-right").classList.add("hidden");
    currentUserIsAdmin = false;
    currentPlan = {};
    planGenerated = false;
    showScreen("auth-screen");
});

document.getElementById("invite-btn").addEventListener("click", async () => {
    try {
        const result = await apiCall("/api/auth/invite");
        document.getElementById("invite-code-display").textContent = result.code;
        document.getElementById("invite-modal").classList.remove("hidden");
    } catch (err) {
        alert("Fehler: " + err.message);
    }
});

document.getElementById("invite-copy-btn").addEventListener("click", () => {
    const code = document.getElementById("invite-code-display").textContent;
    navigator.clipboard.writeText(code);
    document.getElementById("invite-copy-btn").textContent = "Kopiert!";
    setTimeout(() => { document.getElementById("invite-copy-btn").textContent = "Kopieren"; }, 2000);
});

document.getElementById("invite-close-btn").addEventListener("click", () => {
    document.getElementById("invite-modal").classList.add("hidden");
});

// ===== Cookidoo Auto-Connect =====

async function tryAutoConnectCookidoo() {
    try {
        const creds = await apiGet("/api/cookidoo-credentials");
        if (!creds.has_credentials) { showLoginScreen(false); return; }

        showLoading("Cookidoo wird verbunden...");
        try {
            await apiCall("/api/login", {
                email: creds.email, password: creds.password,
                country: creds.country, language: creds.language,
            });
            showLoading("Sammlungen werden geladen...");
            await apiCall("/api/collections");

            loadFiltersFromStorage();
            showScreen("main-app");
            renderDayCards();
            hideLoading();
            await autoPreviewPlan();
        } catch (err) {
            hideLoading();
            showLoginScreen(true);
        }
    } catch (err) {
        showLoginScreen(false);
    }
}

function showLoginScreen(hasSavedCreds) {
    showScreen("login-screen");
    const forgetRow = document.getElementById("forget-credentials-row");
    if (forgetRow) forgetRow.classList.toggle("hidden", !hasSavedCreds);
}

document.getElementById("forget-credentials-btn")?.addEventListener("click", async () => {
    try {
        await fetch("/api/cookidoo-credentials", { method: "DELETE" });
        document.getElementById("forget-credentials-row").classList.add("hidden");
        showStatus("login-status", "Zugangsdaten gelöscht.", "info");
    } catch (err) {
        console.warn("Fehler beim Löschen:", err);
    }
});

// ===== Admin Dashboard =====

async function loadAdminData() {
    try {
        const [usersResult, invitesResult] = await Promise.all([
            apiGet("/api/admin/users"),
            apiGet("/api/admin/invites"),
        ]);
        renderUserList(usersResult.users);
        renderInviteList(invitesResult.codes);
    } catch (err) {
        alert("Admin-Daten laden fehlgeschlagen: " + err.message);
    }
}

function renderUserList(users) {
    const container = document.getElementById("admin-users-list");
    if (users.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted); font-size: 0.88rem;">Keine Benutzer vorhanden.</p>';
        return;
    }
    let html = '<table class="admin-table"><thead><tr><th>Benutzer</th><th>Erstellt</th><th>Rolle</th><th>Aktionen</th></tr></thead><tbody>';
    for (const user of users) {
        const date = new Date(user.created_at).toLocaleDateString("de-CH");
        const role = user.is_admin ? '<span class="admin-badge">Admin</span>' : 'User';
        const actions = user.is_admin
            ? '<span style="color: var(--text-muted); font-size: 0.82rem;">-</span>'
            : `<button class="btn btn-secondary btn-sm btn-reset-pw" data-id="${user.id}" data-name="${user.username}">Passwort</button>
               <button class="btn btn-secondary btn-sm btn-delete-user" data-id="${user.id}" data-name="${user.username}" style="color: #dc2626; border-color: #dc2626;">Löschen</button>`;
        html += `<tr><td><strong>${user.username}</strong></td><td>${date}</td><td>${role}</td><td>${actions}</td></tr>`;
    }
    html += '</tbody></table>';
    container.innerHTML = html;
    container.querySelectorAll(".btn-reset-pw").forEach(btn => {
        btn.addEventListener("click", () => openPasswordReset(btn.dataset.id, btn.dataset.name));
    });
    container.querySelectorAll(".btn-delete-user").forEach(btn => {
        btn.addEventListener("click", () => deleteUser(btn.dataset.id, btn.dataset.name));
    });
}

function renderInviteList(codes) {
    const container = document.getElementById("admin-invites-list");
    const unused = codes.filter(c => !c.used_by);
    const used = codes.filter(c => c.used_by);
    if (codes.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted); font-size: 0.88rem;">Keine Codes vorhanden.</p>';
        return;
    }
    let html = '<table class="admin-table"><thead><tr><th>Code</th><th>Erstellt</th><th>Status</th><th></th></tr></thead><tbody>';
    for (const code of unused) {
        const date = new Date(code.created_at).toLocaleDateString("de-CH");
        html += `<tr><td><code>${code.code}</code></td><td>${date}</td><td><span style="color: var(--primary); font-weight: 500;">Offen</span></td><td><button class="btn btn-secondary btn-sm btn-delete-invite" data-code="${code.code}" style="color: #dc2626; border-color: #dc2626;">Löschen</button></td></tr>`;
    }
    for (const code of used) {
        const date = new Date(code.created_at).toLocaleDateString("de-CH");
        html += `<tr><td><code>${code.code}</code></td><td>${date}</td><td>Verwendet von <strong>${code.used_by}</strong></td><td></td></tr>`;
    }
    html += '</tbody></table>';
    container.innerHTML = html;
    container.querySelectorAll(".btn-delete-invite").forEach(btn => {
        btn.addEventListener("click", async () => {
            if (!confirm(`Code "${btn.dataset.code}" löschen?`)) return;
            try { await apiDelete(`/api/admin/invites/${btn.dataset.code}`); loadAdminData(); }
            catch (err) { alert("Fehler: " + err.message); }
        });
    });
}

document.getElementById("admin-invite-btn").addEventListener("click", async () => {
    try {
        const result = await apiCall("/api/auth/invite");
        document.getElementById("admin-invite-code").textContent = result.code;
        document.getElementById("admin-invite-result").classList.remove("hidden");
        document.getElementById("admin-invite-result").style.display = "flex";
        loadAdminData();
    } catch (err) {
        alert("Fehler: " + err.message);
    }
});

document.getElementById("admin-copy-btn").addEventListener("click", () => {
    const code = document.getElementById("admin-invite-code").textContent;
    navigator.clipboard.writeText(code);
    document.getElementById("admin-copy-btn").textContent = "Kopiert!";
    setTimeout(() => { document.getElementById("admin-copy-btn").textContent = "Kopieren"; }, 2000);
});

async function deleteUser(userId, username) {
    if (!confirm(`Benutzer "${username}" wirklich löschen?`)) return;
    try { await apiDelete(`/api/admin/users/${userId}`); loadAdminData(); }
    catch (err) { alert("Fehler: " + err.message); }
}

let resetUserId = null;

function openPasswordReset(userId, username) {
    resetUserId = userId;
    document.getElementById("reset-username").textContent = username;
    document.getElementById("reset-password").value = "";
    hideStatus("reset-status");
    document.getElementById("password-modal").classList.remove("hidden");
}

document.getElementById("reset-confirm-btn").addEventListener("click", async () => {
    const password = document.getElementById("reset-password").value;
    if (!password || password.length < 6) {
        showStatus("reset-status", "Passwort muss mindestens 6 Zeichen lang sein", "error");
        return;
    }
    try {
        await apiCall(`/api/admin/users/${resetUserId}/reset-password`, { password });
        document.getElementById("password-modal").classList.add("hidden");
        resetUserId = null;
    } catch (err) {
        showStatus("reset-status", err.message, "error");
    }
});

document.getElementById("reset-cancel-btn").addEventListener("click", () => {
    document.getElementById("password-modal").classList.add("hidden");
    resetUserId = null;
});

async function checkAuthStatus() {
    try {
        const resp = await fetch("/api/auth/status");
        const data = await resp.json();
        if (data.logged_in) await onAuthSuccess(data.username, data.is_admin);
        else showScreen("auth-screen");
    } catch {
        showScreen("auth-screen");
    }
}

// ===== Cookidoo Login =====

document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideStatus("login-status");
    const email = document.getElementById("email").value;
    const password = document.getElementById("password").value;
    const country = document.getElementById("country").value;
    const language = document.getElementById("language").value;
    const remember = document.getElementById("remember-credentials")?.checked;

    showLoading("Anmelden bei Cookidoo...");
    try {
        await apiCall("/api/login", { email, password, country, language });
        if (remember) {
            try { await apiCall("/api/cookidoo-credentials", { email, password, country, language }); }
            catch (err) { console.warn("Zugangsdaten speichern fehlgeschlagen:", err); }
        }
        showLoading("Sammlungen werden geladen...");
        await apiCall("/api/collections");
        loadFiltersFromStorage();
        showScreen("main-app");
        renderDayCards();
        hideLoading();
        await autoPreviewPlan();
    } catch (err) {
        hideLoading();
        showStatus("login-status", err.message, "error");
    }
});

document.getElementById("country").addEventListener("change", (e) => {
    const lang = document.getElementById("language");
    const map = { de: "de-DE", at: "de-AT", ch: "de-CH" };
    lang.value = map[e.target.value] || "de-DE";
});

document.getElementById("custom-ratio").addEventListener("input", (e) => {
    const val = parseInt(e.target.value);
    document.getElementById("ratio-display").textContent = `${val}% eigene / ${100 - val}% neue`;
    updateFilterBadge();
    saveFiltersToStorage();
});

["max-time-0", "max-time-1"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => { updateFilterBadge(); saveFiltersToStorage(); });
});

// ===== Auto-Preview Plan =====

async function autoPreviewPlan() {
    const daySlots = getDaySlots();
    if (Object.keys(daySlots).length === 0) return;

    showLoading("Vorschau wird erstellt...");
    try {
        const result = await apiCall("/api/generate", {
            day_slots: daySlots,
            custom_ratio: getCustomRatio(),
            categories: getSelectedFilters("category-filters"),
            cuisines: getSelectedFilters("cuisine-filters"),
            preferred_ingredients: preferredIngredients,
            exclude_ingredients: excludeIngredients,
            max_time_per_slot: getMaxTimePerSlot(),
        });
        currentPlan = result.plan;
        planGenerated = true;
        dayCardNav = {};
        renderDayCards();
        showSaveSection();
    } catch (err) {
        console.warn("Auto-Vorschau fehlgeschlagen:", err);
    } finally {
        hideLoading();
    }
}

function showSaveSection() {
    document.getElementById("save-section").classList.remove("hidden");
    document.getElementById("plan-section").classList.add("has-save-bar");
}

// ===== Plan generieren =====

document.getElementById("generate-btn")?.addEventListener("click", generatePlan);

async function generatePlan() {
    const daySlots = getDaySlots();
    if (Object.keys(daySlots).length === 0) {
        alert("Bitte mindestens einen Tag mit Mittag oder Abend aktivieren.");
        return;
    }
    showLoading("Wochenplan wird erstellt...");
    try {
        const result = await apiCall("/api/generate", {
            day_slots: daySlots,
            custom_ratio: getCustomRatio(),
            categories: getSelectedFilters("category-filters"),
            cuisines: getSelectedFilters("cuisine-filters"),
            preferred_ingredients: preferredIngredients,
            exclude_ingredients: excludeIngredients,
            max_time_per_slot: getMaxTimePerSlot(),
        });
        currentPlan = result.plan;
        planGenerated = true;
        dayCardNav = {};
        renderDayCards();
        showSaveSection();
        hideLoading();
    } catch (err) {
        hideLoading();
        alert("Fehler: " + err.message);
    }
}

// ===== Einzelnen Slot neu würfeln =====

async function rerollDay(dayName, slotKey) {
    const dayIdx = WEEKDAYS.indexOf(dayName);
    const override = dayFilterOverride[dayIdx] || {};
    let maxTimeMinutes;
    if (override.max_time) {
        maxTimeMinutes = parseInt(override.max_time);
    } else {
        const maxTimePerSlot = getMaxTimePerSlot();
        // m/m_v/m_d → mittag limit; a/a_v/a_d → abend limit
        maxTimeMinutes = slotKey.startsWith("a") ? maxTimePerSlot.a : maxTimePerSlot.m;
    }

    showLoading(`${dayName} wird neu gewürfelt...`);
    try {
        const result = await apiCall("/api/regenerate-day", {
            day: dayName,
            slot_key: slotKey,
            custom_ratio: getCustomRatio(),
            categories: getSelectedFilters("category-filters"),
            cuisines: getSelectedFilters("cuisine-filters"),
            preferred_ingredients: preferredIngredients,
            exclude_ingredients: excludeIngredients,
            max_time_minutes: maxTimeMinutes,
            override_category: override.category || "",
            override_cuisine: override.cuisine || "",
        });
        if (!currentPlan[dayName]) currentPlan[dayName] = {};
        currentPlan[dayName][slotKey] = result.recipe;
        renderDayCards();
        hideLoading();
    } catch (err) {
        hideLoading();
        alert("Fehler: " + err.message);
    }
}

// ===== In Cookidoo speichern =====

document.getElementById("save-btn").addEventListener("click", async () => {
    const weekOffset = parseInt(document.getElementById("week-offset").value);
    const clearFirst = document.getElementById("clear-first").checked;
    const addShoppingList = document.getElementById("add-shopping-list").checked;

    const weekLabel = ["diese", "nächste", "übernächste"][weekOffset];
    let confirmMsg = `Plan für ${weekLabel} Woche in Cookidoo speichern?`;
    if (addShoppingList) confirmMsg += "\n\nZutaten werden auch zur Einkaufsliste hinzugefügt.";
    if (!confirm(confirmMsg)) return;

    showLoading("Wird in Cookidoo gespeichert...");
    hideStatus("save-status");
    try {
        const result = await apiCall("/api/save", {
            week_offset: weekOffset,
            clear_first: clearFirst,
            add_to_shopping_list: addShoppingList,
        });
        let msg = `${result.saved.length} Rezepte gespeichert!`;
        if (result.shopping_added > 0) msg += ` ${result.shopping_added} Zutaten zur Einkaufsliste hinzugefügt.`;
        if (result.errors && result.errors.length > 0) msg += ` (${result.errors.length} Fehler)`;
        showStatus("save-status", msg, result.errors?.length ? "info" : "success");
        hideLoading();
    } catch (err) {
        hideLoading();
        showStatus("save-status", err.message, "error");
    }
});

// ===== Init =====

initFilterTags("category-filters");
initFilterTags("cuisine-filters");

document.getElementById("filter-btn").addEventListener("click", openFilterPanel);
document.getElementById("filter-close-btn").addEventListener("click", closeFilterPanel);
document.getElementById("filter-backdrop").addEventListener("click", closeFilterPanel);
document.getElementById("filter-reset-btn").addEventListener("click", resetFilters);
document.getElementById("filter-apply-btn").addEventListener("click", () => {
    saveFiltersToStorage();
    closeFilterPanel();
    if (planGenerated) {
        generatePlan();
    } else {
        autoPreviewPlan();
    }
});

setupIngredientAutocomplete("exclude-ingredient-input", "exclude-autocomplete", "add-exclude-btn", "exclude");
setupIngredientAutocomplete("prefer-ingredient-input", "prefer-autocomplete", "add-prefer-btn", "prefer");

// Globaler Handler: Card-Aktionsmenü bei Klick außerhalb schließen
document.addEventListener("click", () => {
    document.getElementById("card-action-dropdown")?.classList.add("hidden");
});

renderDayCards();
checkAuthStatus();
