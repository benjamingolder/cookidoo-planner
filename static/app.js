// Cookidoo Wochenplan-Generator - Frontend

const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

let currentPlan = {};
let lockedDays = new Set();
let currentUserIsAdmin = false;

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

async function apiGet(url) {
    const response = await fetch(url);
    const result = await response.json();
    if (!response.ok || result.error) {
        throw new Error(result.error || "Unbekannter Fehler");
    }
    return result;
}

async function apiDelete(url) {
    const response = await fetch(url, { method: "DELETE" });
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
                checkboxes.forEach(other => {
                    if (other !== cb) {
                        other.checked = false;
                        other.closest(".filter-tag").classList.remove("active");
                    }
                });
                cb.closest(".filter-tag").classList.add("active");
            } else if (cb.value !== "alle") {
                if (alleCheckbox) {
                    alleCheckbox.checked = false;
                    alleCheckbox.closest(".filter-tag").classList.remove("active");
                }
                cb.closest(".filter-tag").classList.toggle("active", cb.checked);

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
    ["auth-screen", "login-screen", "admin-screen", "main-app"].forEach(id => {
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
        onAuthSuccess(result.username, result.is_admin);
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
        onAuthSuccess(result.username, result.is_admin);
    } catch (err) {
        showStatus("auth-status", err.message, "error");
    }
});

function onAuthSuccess(username, isAdmin) {
    currentUserIsAdmin = isAdmin;
    document.getElementById("app-user-name").textContent = username;
    document.getElementById("header-right").classList.remove("hidden");

    // Einladen-Button nur für Admin
    document.getElementById("invite-btn").classList.toggle("hidden", !isAdmin);

    if (isAdmin) {
        showScreen("admin-screen");
        loadAdminData();
    } else {
        showScreen("login-screen");
    }
}

// Logout
document.getElementById("logout-btn").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    document.getElementById("header-right").classList.add("hidden");
    currentUserIsAdmin = false;
    showScreen("auth-screen");
});

// Invite Code (Header Button)
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
               <button class="btn btn-secondary btn-sm btn-delete-user" data-id="${user.id}" data-name="${user.username}" style="color: #dc2626; border-color: #dc2626;">L&ouml;schen</button>`;
        html += `<tr><td><strong>${user.username}</strong></td><td>${date}</td><td>${role}</td><td>${actions}</td></tr>`;
    }
    html += '</tbody></table>';
    container.innerHTML = html;

    // Event listeners
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
        html += `<tr><td><code>${code.code}</code></td><td>${date}</td><td><span style="color: var(--primary); font-weight: 500;">Offen</span></td><td><button class="btn btn-secondary btn-sm btn-delete-invite" data-code="${code.code}" style="color: #dc2626; border-color: #dc2626;">L&ouml;schen</button></td></tr>`;
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
            try {
                await apiDelete(`/api/admin/invites/${btn.dataset.code}`);
                loadAdminData();
            } catch (err) {
                alert("Fehler: " + err.message);
            }
        });
    });
}

// Admin - Invite Code
document.getElementById("admin-invite-btn").addEventListener("click", async () => {
    try {
        const result = await apiCall("/api/auth/invite");
        document.getElementById("admin-invite-code").textContent = result.code;
        document.getElementById("admin-invite-result").classList.remove("hidden");
        document.getElementById("admin-invite-result").style.display = "flex";
        loadAdminData(); // Refresh lists
    } catch (err) {
        alert("Fehler: " + err.message);
    }
});

document.getElementById("admin-copy-btn").addEventListener("click", () => {
    const code = document.getElementById("admin-invite-code").textContent;
    navigator.clipboard.writeText(code);
    document.getElementById("admin-copy-btn").textContent = "Kopiert!";
    setTimeout(() => {
        document.getElementById("admin-copy-btn").textContent = "Kopieren";
    }, 2000);
});

// Admin - Delete User
async function deleteUser(userId, username) {
    if (!confirm(`Benutzer "${username}" wirklich löschen?`)) return;
    try {
        await apiDelete(`/api/admin/users/${userId}`);
        loadAdminData();
    } catch (err) {
        alert("Fehler: " + err.message);
    }
}

// Admin - Password Reset
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

// Session Check on Load
async function checkAuthStatus() {
    try {
        const resp = await fetch("/api/auth/status");
        const data = await resp.json();
        if (data.logged_in) {
            onAuthSuccess(data.username, data.is_admin);
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

        document.getElementById("collection-info").innerHTML = "";

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

    const weekLabel = ["diese", "nächste", "übernächste"][weekOffset];
    let confirmMsg = `Plan für ${weekLabel} Woche in Cookidoo speichern?`;
    if (addShoppingList) {
        confirmMsg += "\n\nZutaten werden auch zur Einkaufsliste hinzugefügt.";
    }
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
        if (result.shopping_added > 0) {
            msg += ` ${result.shopping_added} Zutaten zur Einkaufsliste hinzugefügt.`;
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

// --- Init ---

initFilterTags("category-filters");
initFilterTags("cuisine-filters");
initDayFilters();
checkAuthStatus();
