// Cookidoo Wochenplan-Generator - Frontend

const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

let currentPlan = {};
let lockedDays = new Set();

// --- Helpers ---

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
    if (!response.ok || result.error) {
        throw new Error(result.error || "Unbekannter Fehler");
    }
    return result;
}

function getSelectedDays() {
    return Array.from(document.querySelectorAll(".day-cb:checked"))
        .map(cb => parseInt(cb.value));
}

function getCustomRatio() {
    return parseInt(document.getElementById("custom-ratio").value);
}

function getSelectedFilters(containerId) {
    const container = document.getElementById(containerId);
    const checked = Array.from(container.querySelectorAll("input[type=checkbox]:checked"));
    // If "alle" is checked, return empty array (no filter)
    if (checked.some(cb => cb.value === "alle")) return [];
    return checked.map(cb => cb.value);
}

// --- Filter Tag Toggle Logic ---

function initFilterTags(containerId) {
    const container = document.getElementById(containerId);
    const checkboxes = container.querySelectorAll("input[type=checkbox]");
    const alleCheckbox = container.querySelector("input[value=alle]");

    checkboxes.forEach(cb => {
        cb.addEventListener("change", () => {
            if (cb.value === "alle" && cb.checked) {
                // "Alle" selected -> uncheck all others
                checkboxes.forEach(other => {
                    if (other !== cb) {
                        other.checked = false;
                        other.closest(".filter-tag").classList.remove("active");
                    }
                });
                cb.closest(".filter-tag").classList.add("active");
            } else if (cb.value !== "alle") {
                // Specific filter selected -> uncheck "Alle"
                if (alleCheckbox) {
                    alleCheckbox.checked = false;
                    alleCheckbox.closest(".filter-tag").classList.remove("active");
                }
                cb.closest(".filter-tag").classList.toggle("active", cb.checked);

                // If nothing is checked, re-check "Alle"
                const anyChecked = Array.from(checkboxes).some(c => c.checked);
                if (!anyChecked && alleCheckbox) {
                    alleCheckbox.checked = true;
                    alleCheckbox.closest(".filter-tag").classList.add("active");
                }
            }
        });
    });
}

// --- Day Filter Toggle ---

function initDayFilters() {
    const container = document.getElementById("day-filters");
    container.querySelectorAll(".day-cb").forEach(cb => {
        cb.addEventListener("change", () => {
            cb.closest(".filter-tag").classList.toggle("active", cb.checked);
        });
    });
}

// ===== Auth =====

function showScreen(screenId) {
    ["auth-screen", "login-screen", "main-app"].forEach(id => {
        document.getElementById(id).classList.add("hidden");
    });
    document.getElementById(screenId).classList.remove("hidden");
}

// Auth Tabs
document.querySelectorAll(".auth-tab").forEach(tab => {
    tab.addEventListener("click", () => {
        document.querySelectorAll(".auth-tab").forEach(t => t.classList.remove("active"));
        document.querySelectorAll(".auth-tab-content").forEach(c => c.classList.add("hidden"));
        tab.classList.add("active");
        document.querySelector(`.auth-tab-content[data-tab="${tab.dataset.tab}"]`).classList.remove("hidden");
    });
});

// Auth Login
document.getElementById("auth-login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideStatus("auth-status");

    const username = document.getElementById("auth-username").value;
    const password = document.getElementById("auth-password").value;

    try {
        const result = await apiCall("/api/auth/login", { username, password });
        onAuthSuccess(result.username);
    } catch (err) {
        showStatus("auth-status", err.message, "error");
    }
});

// Auth Register
document.getElementById("auth-register-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideStatus("auth-status");

    const username = document.getElementById("reg-username").value;
    const password = document.getElementById("reg-password").value;
    const invite_code = document.getElementById("reg-invite").value;

    try {
        const result = await apiCall("/api/auth/register", { username, password, invite_code });
        onAuthSuccess(result.username);
    } catch (err) {
        showStatus("auth-status", err.message, "error");
    }
});

function onAuthSuccess(username) {
    document.getElementById("app-user-name").textContent = username;
    document.getElementById("header-right").classList.remove("hidden");
    showScreen("login-screen");
}

// Logout
document.getElementById("logout-btn").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    document.getElementById("header-right").classList.add("hidden");
    showScreen("auth-screen");
});

// Invite Code
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
    setTimeout(() => {
        document.getElementById("invite-copy-btn").textContent = "Kopieren";
    }, 2000);
});

document.getElementById("invite-close-btn").addEventListener("click", () => {
    document.getElementById("invite-modal").classList.add("hidden");
});

// Session Check on Load
async function checkAuthStatus() {
    try {
        const resp = await fetch("/api/auth/status");
        const data = await resp.json();
        if (data.logged_in) {
            onAuthSuccess(data.username);
        } else {
            showScreen("auth-screen");
        }
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

    showLoading("Anmelden bei Cookidoo...");

    try {
        const loginResult = await apiCall("/api/login", { email, password, country, language });

        showLoading("Sammlungen werden geladen...");
        const collResult = await apiCall("/api/collections");

        let infoHtml =
            `<strong>${collResult.custom_recipes}</strong> Rezepte in ` +
            `<strong>${collResult.custom_collections}</strong> eigenen Sammlungen | ` +
            `<strong>${collResult.managed_recipes}</strong> Rezepte in ` +
            `<strong>${collResult.managed_collections}</strong> Cookidoo-Menüs`;
        if (collResult.search_recipes > 0) {
            infoHtml += ` | <strong>${collResult.search_recipes}</strong> Rezepte via Cookidoo-Suche`;
        }
        document.getElementById("collection-info").innerHTML = infoHtml;

        // Hide login, show main app
        showScreen("main-app");

        hideLoading();
    } catch (err) {
        hideLoading();
        showStatus("login-status", err.message, "error");
    }
});

// --- Country/Language Sync ---

document.getElementById("country").addEventListener("change", (e) => {
    const lang = document.getElementById("language");
    const map = { de: "de-DE", at: "de-AT", ch: "de-CH" };
    lang.value = map[e.target.value] || "de-DE";
});

// --- Ratio Slider ---

document.getElementById("custom-ratio").addEventListener("input", (e) => {
    const val = parseInt(e.target.value);
    document.getElementById("ratio-display").textContent =
        `${val}% eigene / ${100 - val}% neue`;
});

// --- Plan generieren ---

document.getElementById("generate-btn").addEventListener("click", generatePlan);
document.getElementById("regenerate-all-btn").addEventListener("click", generatePlan);

async function generatePlan() {
    const days = getSelectedDays();
    if (days.length === 0) {
        alert("Bitte mindestens einen Tag auswählen.");
        return;
    }

    showLoading("Wochenplan wird erstellt...");
    lockedDays.clear();

    const categories = getSelectedFilters("category-filters");
    const cuisines = getSelectedFilters("cuisine-filters");

    try {
        const result = await apiCall("/api/generate", {
            days,
            custom_ratio: getCustomRatio(),
            categories,
            cuisines,
        });
        currentPlan = result.plan;
        renderPlan();
        document.getElementById("plan-section").classList.remove("hidden");
        hideLoading();
    } catch (err) {
        hideLoading();
        alert("Fehler: " + err.message);
    }
}

// --- Plan rendern ---

function renderPlan() {
    const grid = document.getElementById("plan-grid");
    grid.innerHTML = "";

    const selectedDays = getSelectedDays();

    for (const dayIdx of selectedDays) {
        const dayName = WEEKDAYS[dayIdx];
        const recipe = currentPlan[dayName];
        const isLocked = lockedDays.has(dayName);

        const card = document.createElement("div");
        card.className = `day-card${isLocked ? " locked" : ""}`;
        card.innerHTML = buildDayCard(dayName, recipe, isLocked);
        grid.appendChild(card);
    }

    // Event Listeners
    grid.querySelectorAll(".btn-reroll").forEach(btn => {
        btn.addEventListener("click", () => rerollDay(btn.dataset.day));
    });

    grid.querySelectorAll(".btn-lock").forEach(btn => {
        btn.addEventListener("click", () => toggleLock(btn.dataset.day));
    });
}

function buildDayCard(dayName, recipe, isLocked) {
    const lockIcon = isLocked ? "🔒" : "🔓";
    const lockClass = isLocked ? " locked" : "";

    let bodyHtml;
    if (recipe) {
        const imgHtml = recipe.thumbnail || recipe.image
            ? `<img class="recipe-image" src="${recipe.image || recipe.thumbnail}" alt="${escapeHtml(recipe.name)}" loading="lazy">`
            : `<div class="recipe-image-placeholder">🍽️</div>`;

        const nameHtml = recipe.url
            ? `<a href="${recipe.url}" target="_blank" rel="noopener">${escapeHtml(recipe.name)}</a>`
            : escapeHtml(recipe.name);

        const sourceLabels = { custom: "Eigene", managed: "Menü", search: "Entdecken" };
        const sourceLabel = sourceLabels[recipe.source] || "Neu";
        const sourceClass = recipe.source === "custom" ? "custom" : "managed";

        bodyHtml = `
            ${imgHtml}
            <div class="recipe-info">
                <div class="recipe-name">${nameHtml}</div>
                <div class="recipe-meta">
                    <span>${recipe.total_time_str}</span>
                    <span class="recipe-source ${sourceClass}">${sourceLabel}</span>
                </div>
            </div>
        `;
    } else {
        bodyHtml = `<div class="no-recipe">Kein Rezept verfügbar</div>`;
    }

    return `
        <div class="day-card-header">
            <h3>${dayName}</h3>
            <div class="day-card-actions">
                <button class="btn-icon btn-reroll" data-day="${dayName}" title="Neu würfeln"${isLocked ? " disabled" : ""}>🎲</button>
                <button class="btn-icon btn-lock${lockClass}" data-day="${dayName}" title="${isLocked ? "Entsperren" : "Sperren"}">${lockIcon}</button>
            </div>
        </div>
        <div class="day-card-body">${bodyHtml}</div>
    `;
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

// --- Einzelnen Tag neu würfeln ---

async function rerollDay(dayName) {
    if (lockedDays.has(dayName)) return;

    showLoading(`${dayName} wird neu gewürfelt...`);

    const categories = getSelectedFilters("category-filters");
    const cuisines = getSelectedFilters("cuisine-filters");

    try {
        const result = await apiCall("/api/regenerate-day", {
            day: dayName,
            custom_ratio: getCustomRatio(),
            categories,
            cuisines,
        });
        currentPlan[dayName] = result.recipe;
        renderPlan();
        hideLoading();
    } catch (err) {
        hideLoading();
        alert("Fehler: " + err.message);
    }
}

// --- Tag sperren/entsperren ---

function toggleLock(dayName) {
    if (lockedDays.has(dayName)) {
        lockedDays.delete(dayName);
    } else {
        lockedDays.add(dayName);
    }
    renderPlan();
}

// --- In Cookidoo speichern ---

document.getElementById("save-btn").addEventListener("click", async () => {
    const weekOffset = parseInt(document.getElementById("week-offset").value);
    const clearFirst = document.getElementById("clear-first").checked;
    const addShoppingList = document.getElementById("add-shopping-list").checked;
    const addToBring = bringConnected && document.getElementById("add-to-bring").checked;
    const bringListUuid = addToBring ? document.getElementById("bring-list").value : "";

    const weekLabel = ["diese", "nächste", "übernächste"][weekOffset];
    let confirmMsg = `Plan für ${weekLabel} Woche in Cookidoo speichern?`;
    if (addShoppingList) {
        confirmMsg += "\n\nZutaten werden auch zur Einkaufsliste hinzugefügt.";
    }
    if (addToBring) {
        const listName = document.getElementById("bring-list").selectedOptions[0]?.textContent || "Bring!";
        confirmMsg += `\n\nZutaten werden zu Bring! (${listName}) hinzugefügt.`;
    }
    if (!confirm(confirmMsg)) return;

    showLoading("Wird in Cookidoo gespeichert...");
    hideStatus("save-status");

    try {
        const result = await apiCall("/api/save", {
            week_offset: weekOffset,
            clear_first: clearFirst,
            add_to_shopping_list: addShoppingList,
            add_to_bring: addToBring,
            bring_list_uuid: bringListUuid,
        });

        let msg = `${result.saved.length} Rezepte gespeichert!`;
        if (result.shopping_added > 0) {
            msg += ` ${result.shopping_added} Zutaten zur Einkaufsliste hinzugefügt.`;
        }
        if (result.bring_added > 0) {
            msg += ` ${result.bring_added} Zutaten zu Bring! hinzugefügt.`;
        }
        if (result.errors && result.errors.length > 0) {
            msg += ` (${result.errors.length} Fehler)`;
        }
        showStatus("save-status", msg, result.errors?.length ? "info" : "success");
        hideLoading();
    } catch (err) {
        hideLoading();
        showStatus("save-status", err.message, "error");
    }
});

// --- Bring! Integration ---

let bringConnected = false;

document.getElementById("bring-toggle").addEventListener("click", () => {
    const body = document.getElementById("bring-body");
    const btn = document.getElementById("bring-expand-btn");
    body.classList.toggle("hidden");
    btn.classList.toggle("open");
});

document.getElementById("bring-login-btn").addEventListener("click", async () => {
    const email = document.getElementById("bring-email").value;
    const password = document.getElementById("bring-password").value;

    if (!email || !password) {
        alert("Bitte Bring! E-Mail und Passwort eingeben.");
        return;
    }

    showLoading("Verbinde mit Bring!...");

    try {
        const result = await apiCall("/api/bring/login", { email, password });

        // Listen-Dropdown befüllen
        const select = document.getElementById("bring-list");
        select.innerHTML = "";
        for (const list of result.lists) {
            const opt = document.createElement("option");
            opt.value = list.uuid;
            opt.textContent = list.name;
            select.appendChild(opt);
        }

        // UI umschalten
        document.getElementById("bring-login-row").classList.add("hidden");
        document.getElementById("bring-connected").classList.remove("hidden");
        document.getElementById("bring-status").textContent = "Verbunden";
        document.getElementById("bring-status").classList.add("connected");
        document.getElementById("add-to-bring").checked = true;
        bringConnected = true;

        hideLoading();
    } catch (err) {
        hideLoading();
        alert("Bring! Login fehlgeschlagen: " + err.message);
    }
});

// --- Init ---

initFilterTags("category-filters");
initFilterTags("cuisine-filters");
initDayFilters();
checkAuthStatus();
