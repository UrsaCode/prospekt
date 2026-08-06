// Prospekt — Dashboard SPA Logic

const PER_PAGE = 30;
const TYPES = ["all", "email", "phone", "social", "custom"];

const state = {
  page: "overview",
  contactFilter: "all",
  contactPage: 1,
  scanPage: 1,
  search: "",
  patternsDirty: false,
  contactSort: "newest",
  notExported: false,
  hideRole: false,
  duplicatesOnly: false,
  rolesOnly: false,
  selected: new Set(),
  scanState: "all",
  scanSort: "contacts",
  scanSelected: new Set(),
  range: "12w",
};

let prefs = { ...PROSPEKT.DEFAULT_SETTINGS };

const IC = {
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
};

// ── Escaping ─────────────────────────────────────────────────────────────
// Must be safe in attribute position too. The previous implementation round
// tripped through textContent/innerHTML, which leaves " and ' untouched — so
// any scraped value containing a quote broke out of the attribute it was
// rendered into (and any regex containing a quote was silently truncated when
// the settings editor re-read it from the input's value attribute).
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = value =>
  value === null || value === undefined ? "" : String(value).replace(/[&<>"']/g, c => ESCAPES[c]);

// Only absolute http(s) survives — blocks javascript:/data: URLs harvested from
// pages, and is also what decides whether a row gets an "open" button.
// Deliberately parsed WITHOUT a base: resolving relative to location.href turned
// any non-URL value ("ada@site0.com") into a same-origin http URL, so every
// email and phone row sprouted an open button. That only looked correct in the
// packaged extension because its base scheme is chrome-extension:.
function safeUrl(url) {
  if (!url) return "";
  const raw = String(url).trim();
  if (!/^https?:\/\//i.test(raw)) return "";
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────
// Resolves `undefined` when the message itself failed, and whatever the handler
// returned (including null) when it succeeded. Callers that would otherwise
// mistake "the worker is unreachable" for "there is nothing stored" — and then
// save defaults over real data — depend on being able to tell them apart.
const bg = msg => new Promise(resolve => {
  try {
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) {
        console.warn("[Prospekt]", msg.action, chrome.runtime.lastError.message);
        return resolve(undefined);
      }
      resolve(res);
    });
  } catch (err) {
    console.warn("[Prospekt]", msg.action, err);
    resolve(undefined);
  }
});

const failed = res => res === undefined || res?.ok === false;

const timeAgo = iso => {
  if (!iso) return "—";
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 0) return "just now";
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 604800) return Math.floor(s / 86400) + "d ago";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const fullDate = iso => (iso
  ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })
  : "—");

// "2026-08-05" is a local calendar day, not a UTC instant. Parsing it bare made
// new Date() treat it as UTC midnight, shifting weekday labels a day west of UTC.
const weekdayLabel = key => {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short" });
};

const num = n => Number(n || 0).toLocaleString();

function toast(text) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.classList.add("visible");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("visible"), 2800);
}

function downloadFile(content, filename) {
  // ﻿ so Excel reads it as UTF-8; revoke after the download starts rather
  // than in the same tick, which could abort large exports.
  const blob = new Blob(["﻿" + content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 30000);
}

// ── Favicons ─────────────────────────────────────────────────────────────
// Remote favicons are off by default: fetching them would announce every
// domain in the library to third-party servers, which contradicts the
// local-only promise. A deterministic monogram is used instead.
function monogram(domain) {
  const name = String(domain || "?").replace(/^www\./, "");
  const ch = (name.charAt(0) || "?").toUpperCase();
  let hue = 7;
  for (const c of name) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  return `<span class="fav fav-mono" style="--mono-h:${hue}" aria-hidden="true">${esc(ch)}</span>`;
}

function favCell(domain, faviconUrl) {
  const src = prefs.remoteFavicons ? safeUrl(faviconUrl) : "";
  if (!src) return monogram(domain);
  return `<img class="fav" src="${esc(src)}" alt="" loading="lazy" data-mono="${esc(domain || "")}">`;
}

function attachFaviconFallbacks(root) {
  root.querySelectorAll("img.fav[data-mono]").forEach(img => {
    img.addEventListener("error", () => { img.outerHTML = monogram(img.dataset.mono); }, { once: true });
  });
}

const domainCell = (domain, favicon) =>
  `<div class="cell-domain">${favCell(domain, favicon)}<span class="domain-text">${esc(domain || "—")}</span></div>`;

// ── Init ─────────────────────────────────────────────────────────────────
const PAGES = ["overview", "contacts", "scans", "insights", "settings"];

// Lets the action context menu deep-link straight to a page or an export.
function routeFromHash(hash) {
  const key = String(hash || location.hash || "").replace(/^#/, "").trim();
  if (!key) return false;
  if (key === "export-contacts" || key === "export-scans") {
    doExport(key === "export-scans" ? "scans" : "contacts");
    return false;
  }
  if (!PAGES.includes(key)) return false;
  document.querySelector(`.nav-item[data-page="${key}"]`)?.click();
  return true;
}

document.addEventListener("DOMContentLoaded", async () => {
  prefs = { ...PROSPEKT.DEFAULT_SETTINGS, ...(await bg({ action: "getSettings" }) || {}) };
  setupNav();
  setupSearch();
  setupExport();
  setupAutoScanToggle();
  setupDrawer();
  setupRange();
  setupModal();
  setupSettingsIO();
  reflectAutoScan();
  if (!routeFromHash()) renderPage("overview");
});

// A hash-only change on an already-open tab doesn't reload the page.
window.addEventListener("hashchange", () => routeFromHash());
chrome.runtime.onMessage?.addListener?.(msg => {
  if (msg?.action === "dashboardRoute") routeFromHash(msg.hash);
});

function reflectAutoScan() {
  const btn = document.getElementById("autoScanToggle");
  const on = prefs.autoScan !== false;
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-checked", String(on));
  btn.title = on ? "Auto-scan is on — click to pause" : "Auto-scan is paused — click to resume";
}

function setupAutoScanToggle() {
  document.getElementById("autoScanToggle").addEventListener("click", async () => {
    const next = prefs.autoScan === false;
    const saved = await bg({ action: "saveSettings", settings: { autoScan: next } });
    if (failed(saved) || !saved) return toast("Couldn't change that");
    prefs = saved;
    reflectAutoScan();
    toast(next ? "Auto-scan resumed" : "Auto-scan paused");
    // Settings page mirrors the same switch.
    if (state.page === "settings") renderPage("settings");
  });
}

function setupNav() {
  document.querySelectorAll(".nav-item").forEach(item => {
    item.addEventListener("click", () => {
      if (!confirmLeaveSettings()) return;
      document.querySelectorAll(".nav-item").forEach(n => {
        n.classList.remove("active");
        n.removeAttribute("aria-current");
      });
      item.classList.add("active");
      item.setAttribute("aria-current", "page");
      renderPage(item.dataset.page);
    });
  });
}

// Pattern edits live only in the DOM until saved, so leaving the page would
// throw them away without warning.
function confirmLeaveSettings() {
  if (state.page !== "settings" || !state.patternsDirty) return true;
  const ok = confirm("You have unsaved pattern changes. Leave without saving?");
  if (ok) setDirty(false);
  return ok;
}

function setupSearch() {
  let timer;
  document.getElementById("globalSearch").addEventListener("input", e => {
    clearTimeout(timer);
    const value = e.target.value;
    timer = setTimeout(() => {
      state.search = value;
      if (state.page === "contacts") { state.contactPage = 1; renderContacts(); }
      else if (state.page === "scans") { state.scanPage = 1; renderScans(); }
    }, 250);
  });
}

function setupExport() {
  document.getElementById("exportContactsBtn")
    .addEventListener("click", e => doExport(e.currentTarget.dataset.exportType || "contacts"));
}

async function doExport(type) {
  if (type === "insights") {
    const rep = await bg({ action: "exportInsights", range: state.range });
    if (!rep?.csv) return toast("Export failed");
    downloadFile(rep.csv, `prospekt-insights-${state.range}.csv`);
    return toast("Report exported");
  }
  const res = await bg({ action: "exportCSV", type });
  if (res?.csv) {
    downloadFile(res.csv, `prospekt-${type}.csv`);
    toast(type === "scans" ? "Scan history exported" : "Contacts exported");
  } else {
    toast("Export failed — try reopening the dashboard");
  }
}

// ── Page Router ──────────────────────────────────────────────────────────
async function renderPage(page) {
  state.page = page;
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.getElementById(`page-${page}`).classList.add("active");

  const titles = { overview: "Overview", contacts: "Contacts", scans: "Scan history", insights: "Insights", settings: "Settings" };
  document.getElementById("pageTitle").textContent = titles[page] || page;
  // Each renderer fills its own subtitle; clear it so a stale one never carries
  // across pages.
  document.getElementById("pageSubtitle").textContent = "";

  // Search only applies to two pages — leaving a stale query visible on the
  // others made the numbers look wrong. The label and export target follow the
  // page too, so "Export all" never means something different from what you see.
  const searchable = page === "contacts" || page === "scans";
  const searchBox = document.querySelector(".search-global");
  searchBox.style.visibility = searchable ? "visible" : "hidden";
  const input = document.getElementById("globalSearch");
  input.placeholder = page === "scans" ? "Search domains" : "Search value, domain, or page";

  const exportBtn = document.getElementById("exportContactsBtn");
  const exportFor = { scans: "scans", insights: "insights" }[page] || "contacts";
  exportBtn.lastChild.textContent =
    exportFor === "scans" ? " Export scans" : exportFor === "insights" ? " Export report" : " Export all";
  exportBtn.dataset.exportType = exportFor;

  // Controls that only mean something on one page.
  document.getElementById("rangeSelect").style.display = page === "insights" ? "" : "none";
  document.getElementById("settingsIO").style.display = page === "settings" ? "" : "none";
  exportBtn.style.display = page === "settings" ? "none" : "";

  const stats = await bg({ action: "getStats" });
  document.getElementById("navContactCount").textContent = num(stats?.totalContacts);
  document.getElementById("navScanCount").textContent = num(stats?.totalScans);

  switch (page) {
    case "overview": return renderOverview();
    case "contacts": return renderContacts();
    case "scans": return renderScans();
    case "insights": return renderInsights();
    case "settings": return renderSettings();
  }
}

const EMPTY_STATS = {
  totalContacts: 0, totalScans: 0, totalDomains: 0,
  emails: 0, phones: 0, socials: 0, customs: 0,
  topDomains: [], platformCounts: {}, customLabelCounts: {}, dailyScans: [],
};

function sparkline(dailyScans) {
  const days = dailyScans || [];
  if (!days.length) return `<div class="chart-empty">No activity yet</div>`;
  const max = Math.max(...days.map(d => d.count), 1);
  return days.map(d => {
    const h = Math.max(4, (d.count / max) * 100);
    return `<div class="mini-bar" style="height:${h}%" title="${esc(d.count)} on ${esc(d.date)}"><span class="mini-bar-label">${esc(weekdayLabel(d.date))}</span></div>`;
  }).join("");
}

// ══════════════════════════════════════════════════════════════════════════
// OVERVIEW
// ══════════════════════════════════════════════════════════════════════════
const truncate = (s, n) => {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n) + "…" : str;
};

/** Coloured type pill. Falls back to a known literal so the class is never
 *  built from an unvalidated value. */
function typeChip(c) {
  const type = TYPES.includes(c.type) ? c.type : "other";
  const text = c.type === "social" ? (c.platform || "social")
    : c.type === "custom" ? (c.label || "custom")
    : c.type;
  return `<span class="cell-type type-${esc(type)}" title="${esc(c.type)}">${esc(truncate(text, 18))}</span>`;
}

const statCard = (label, value, tone) => `
  <div class="stat-card">
    <div class="stat-card-label"><span class="dot dot-${tone}"></span> ${esc(label)}</div>
    <div class="stat-card-value tone-${tone}">${num(value)}</div>
  </div>`;

const TYPE_META = [
  { key: "email", label: "Emails", plural: "emails" },
  { key: "phone", label: "Phones", plural: "phones" },
  { key: "social", label: "Socials", plural: "socials" },
  { key: "custom", label: "Custom", plural: "customs" },
];

const shortDate = iso => (iso
  ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" })
  : "—");

async function renderOverview() {
  const el = document.getElementById("page-overview");
  const o = await bg({ action: "getOverview" });

  if (!o) {
    el.innerHTML = emptyState("⚠️", "Couldn't load your library",
      "The background worker didn't respond. Reload this page to try again.");
    return;
  }

  document.getElementById("pageSubtitle").textContent =
    o.collectingSince ? `collecting since ${shortDate(o.collectingSince)}` : "nothing collected yet";

  if (!o.totalContacts) {
    el.innerHTML = emptyState("📭", "Nothing collected yet",
      "Browse a few sites and Prospekt will start keeping what it finds. Everything stays on this device.");
    return;
  }

  const maxDay = Math.max(...o.dailyContacts.map(d => d.count), 1);
  const splitBar = TYPE_META
    .filter(t => o.byType[t.key] > 0)
    .map(t => `<i style="flex:${o.byType[t.key]};background:var(--${t.key})"></i>`).join("");

  const pct = n => (o.totalContacts ? Math.round((n / o.totalContacts) * 100) : 0);

  el.innerHTML = `
    <div class="ov-grid">
      <section class="panel">
        <div class="panel-hd">
          <h2>The collection</h2>
          <button type="button" class="panel-link" data-goto="contacts">Browse all →</button>
        </div>
        <div class="panel-body" style="padding-bottom:0">
          <div class="coll-top">
            <div class="coll-n">${num(o.totalContacts)}</div>
            <div class="coll-lbl">Contacts kept<br>across ${num(o.totalDomains)} domains</div>
            <div class="coll-delta">
              <b>${o.addedThisWeek ? "+" + num(o.addedThisWeek) : "0"}</b>
              <span>this week</span>
            </div>
          </div>
          <div class="split-bar">${splitBar}</div>
        </div>
        <div class="split-cells">
          ${TYPE_META.map(t => `
            <div class="split-cell">
              <div class="k"><i style="background:var(--${t.key})"></i>${esc(t.label)}</div>
              <div><span class="v">${num(o.byType[t.key] || 0)}</span><span class="p">${pct(o.byType[t.key] || 0)}%</span></div>
            </div>`).join("")}
        </div>
      </section>

      <section class="panel">
        <div class="panel-hd"><h2>Hit rate</h2></div>
        <div class="panel-body">
          <div class="hit-n">${o.hitRate}%</div>
          <p class="hit-copy">of the ${num(o.pagesScanned)} page${o.pagesScanned === 1 ? "" : "s"}
             you've browsed gave up at least one contact.</p>
          <div class="spark">
            ${o.dailyContacts.map((d, i) => `<i class="${i === o.dailyContacts.length - 1 ? "now" : ""}"
                 style="height:${Math.max(4, (d.count / maxDay) * 100)}%"
                 title="${esc(d.count)} on ${esc(d.date)}"></i>`).join("")}
          </div>
          <div class="spark-axis"><span>14 days ago</span><span>today</span></div>
        </div>
      </section>
    </div>

    <div class="ov-grid-2">
      <section class="panel">
        <div class="panel-hd">
          <h2>Richest domains</h2>
          <button type="button" class="panel-link" data-goto="scans">Full history →</button>
        </div>
        ${o.richestDomains.map(d => {
          const bar = TYPE_META.filter(t => d[t.key] > 0)
            .map(t => `<i style="flex:${d[t.key]};background:var(--${t.key})"></i>`).join("");
          return `<div class="dom-row">
            ${favCell(d.domain, null)}
            <div class="dom-main">
              <div class="dom-name">${esc(d.domain)}</div>
              <div class="dom-bar" style="width:${Math.max(30, (d.total / o.richestDomains[0].total) * 100)}%">${bar}</div>
            </div>
            <div class="dom-n">${num(d.total)}</div>
            <div class="dom-when">${esc(timeAgo(d.lastSeen))}</div>
          </div>`;
        }).join("")}
      </section>

      <section class="panel">
        <div class="panel-hd">
          <h2>Latest finds</h2>
          <button type="button" class="panel-link" id="copyLatest">Copy newest ${o.latest.length}</button>
        </div>
        ${o.latest.map(f => {
          const kind = f.type === "social" ? (f.platform || "social")
            : f.type === "custom" ? (f.label || "custom") : f.type;
          const meta = [kind, f.domain, f.source].filter(Boolean).map(esc).join(" · ");
          return `<div class="find-row">
            <span class="find-dot" style="background:var(--${TYPE_META.some(t => t.key === f.type) ? f.type : "email"})"></span>
            <div class="find-main">
              <div class="find-val">${esc(f.value)}</div>
              <div class="find-meta">${meta}</div>
            </div>
            <div class="find-when">${esc(timeAgo(f.added_at))}</div>
          </div>`;
        }).join("")}
      </section>
    </div>

    <section class="panel">
      <div class="panel-hd"><h2>Needs a look</h2></div>
      <div class="look">
        <div class="look-cell">
          <h3><b>${num(o.needsALook.neverExported)}</b> contacts never exported</h3>
          <p>${o.needsALook.lastExportAt
              ? `Collected since your last CSV on ${esc(shortDate(o.needsALook.lastExportAt))}. Export them before you clear old scan records.`
              : `You haven't exported anything yet. Take a copy before you clear old scan records.`}</p>
          <button type="button" class="btn btn-accent btn-sm" id="lookExport">Export these</button>
        </div>
        <div class="look-cell">
          <h3><b>${num(o.needsALook.roleAddresses)}</b> role addresses</h3>
          <p>info@, sales@, support@ and similar. Useful for some outreach, dead weight for most.</p>
          <button type="button" class="btn btn-sm" id="lookRole">Review them</button>
        </div>
        <div class="look-cell">
          <h3><b>${num(o.needsALook.barrenDomains)}</b> domains gave nothing</h3>
          <p>Scanned repeatedly with zero matches. Either skip them or widen your extraction patterns.</p>
          <button type="button" class="btn btn-sm" id="lookPatterns">Tune patterns</button>
        </div>
      </div>
    </section>
  `;

  attachFaviconFallbacks(el);
  el.querySelectorAll("[data-goto]").forEach(b =>
    b.addEventListener("click", () => document.querySelector(`.nav-item[data-page="${b.dataset.goto}"]`)?.click()));

  el.querySelector("#copyLatest")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(o.latest.map(f => f.value).join("\n"));
      toast(`Copied ${o.latest.length} contacts`);
    } catch { toast("Clipboard blocked by the browser"); }
  });
  el.querySelector("#lookExport")?.addEventListener("click", () => doExport("contacts"));
  el.querySelector("#lookRole")?.addEventListener("click", () => {
    state.contactFilter = "email";
    state.roleOnly = true;
    document.querySelector('.nav-item[data-page="contacts"]').click();
  });
  el.querySelector("#lookPatterns")?.addEventListener("click", () => {
    location.hash = "settings";
    document.querySelector('.nav-item[data-page="settings"]').click();
  });
}


// ══════════════════════════════════════════════════════════════════════════
// CONTACTS
// ══════════════════════════════════════════════════════════════════════════
// A value found in the last hour still reads as "just came in".
const NEW_WINDOW_MS = 3600000;
const isFresh = iso => !!iso && (Date.now() - new Date(iso).getTime()) < NEW_WINDOW_MS;

const CT_TOGGLES = [
  { key: "notExported", label: "Not exported" },
  { key: "hideRole", label: "Hide role addresses" },
  { key: "duplicatesOnly", label: "Duplicates only" },
  { key: "rolesOnly", label: "Role addresses only" },
];

const SORTS = [
  { key: "newest", label: "Newest first" },
  { key: "oldest", label: "Oldest first" },
  { key: "domain", label: "By domain" },
];

// id -> contact, so the drawer can open without another round trip.
let contactsOnScreen = new Map();

function contactFilters() {
  const f = {};
  if (state.contactFilter !== "all") f.type = state.contactFilter;
  if (state.search) f.search = state.search;
  for (const t of CT_TOGGLES) if (state[t.key]) f[t.key] = true;
  if (state.contactSort && state.contactSort !== "newest") f.sort = state.contactSort;
  return f;
}

async function renderContacts() {
  const el = document.getElementById("page-contacts");
  const base = contactFilters();
  const filters = { ...base, limit: PER_PAGE, offset: (state.contactPage - 1) * PER_PAGE };

  let res = await bg({ action: "getContacts", filters });
  let total = res?.total || 0;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));

  // Deleting or filtering can strand us past the last page.
  if (state.contactPage > pages) {
    state.contactPage = pages;
    filters.offset = (pages - 1) * PER_PAGE;
    res = await bg({ action: "getContacts", filters });
    total = res?.total || 0;
  }

  const rows = res?.items || [];
  const counts = res?.typeCounts || {};
  const start = (state.contactPage - 1) * PER_PAGE;

  contactsOnScreen = new Map(rows.map(c => [c.id, c]));
  // Drop selections that are no longer on screen so the bulk bar can't act on
  // rows the user can't see.
  state.selected = new Set([...(state.selected || [])].filter(id => contactsOnScreen.has(id)));

  document.getElementById("pageSubtitle").textContent = `${num(total)} kept`;

  const chip = (key, label, tone) => `
    <button type="button" class="ct-chip ${state.contactFilter === key ? "on" : ""}" data-filter="${key}">
      ${tone ? `<i style="background:var(--${tone})"></i>` : ""}${esc(label)}
      <b>${num(counts[key] ?? 0)}</b>
    </button>`;

  const selCount = state.selected.size;

  el.innerHTML = `
    <div class="ct-bar">
      <div class="ct-chips">
        ${chip("all", "All")}
        ${TYPE_META.map(t => chip(t.key, t.label.replace(/s$/, ""), t.key)).join("")}
      </div>
      ${CT_TOGGLES.map(t => `
        <button type="button" class="ct-toggle ${state[t.key] ? "on" : ""}" data-toggle="${t.key}">
          <span class="sign">${state[t.key] ? "−" : "+"}</span> ${esc(t.label)}
        </button>`).join("")}
      <div class="ct-sort">
        <select id="ctSort" aria-label="Sort contacts">
          ${SORTS.map(s => `<option value="${s.key}" ${state.contactSort === s.key ? "selected" : ""}>${esc(s.label)}</option>`).join("")}
        </select>
      </div>
    </div>

    ${selCount ? `
      <div class="bulk">
        <b>${num(selCount)}</b> selected
        <span class="spacer"></span>
        <button type="button" class="btn btn-sm btn-accent" id="bulkExport">Export selected</button>
        <button type="button" class="btn btn-sm btn-danger" id="bulkDelete">Delete selected</button>
        <button type="button" class="btn btn-sm btn-ghost" id="bulkClear">Clear</button>
      </div>` : ""}

    ${total === 0 ? emptyState("📭", "No contacts match",
        state.search || CT_TOGGLES.some(t => state[t.key])
          ? "Try clearing a filter or searching for something else."
          : "Browse some websites and contacts will appear automatically.") : `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th class="cell-check"><input type="checkbox" class="check" id="selAll"
                ${rows.length && rows.every(r => state.selected.has(r.id)) ? "checked" : ""}
                aria-label="Select all on this page"></th>
            <th style="width:104px">Type</th>
            <th>Value</th>
            <th style="width:190px">Domain</th>
            <th style="width:220px">Found on</th>
            <th style="width:104px">When</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(c => `
            <tr class="row-click ${state.selected.has(c.id) ? "is-selected" : ""}" data-id="${esc(c.id)}">
              <td class="cell-check">
                <input type="checkbox" class="check row-check" data-id="${esc(c.id)}"
                  ${state.selected.has(c.id) ? "checked" : ""} aria-label="Select ${esc(c.value)}">
              </td>
              <td>${typeChip(c)}</td>
              <td class="cell-value">${esc(c.value)}${badgesFor(c)}</td>
              <td>${domainCell(c.found_at?.domain, c.found_at?.favicon)}</td>
              <td class="cell-page" title="${esc(c.found_at?.pageTitle || "")}">${esc(c.found_at?.pageTitle || "—")}</td>
              <td class="cell-time" title="${esc(fullDate(c.added_at))}">${esc(timeAgo(c.added_at))}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
    ${pagination(start, total, state.contactPage, pages, "c")}
    `}
  `;

  attachFaviconFallbacks(el);
  wireContacts(el);
}

function badgesFor(c) {
  let out = "";
  if (isFresh(c.added_at)) out += `<span class="badge badge-new">New</span>`;
  if (c.isRole) out += `<span class="badge badge-role">Role</span>`;
  if (c.isDuplicate) out += `<span class="badge badge-dup">Duplicate</span>`;
  return out;
}

function wireContacts(el) {
  el.querySelectorAll(".ct-chip").forEach(b => b.addEventListener("click", () => {
    state.contactFilter = b.dataset.filter;
    state.contactPage = 1;
    renderContacts();
  }));

  el.querySelectorAll("[data-toggle]").forEach(b => b.addEventListener("click", () => {
    const key = b.dataset.toggle;
    state[key] = !state[key];
    // "Hide role addresses" and "Role addresses only" contradict each other.
    if (key === "hideRole" && state.hideRole) state.rolesOnly = false;
    if (key === "rolesOnly" && state.rolesOnly) state.hideRole = false;
    state.contactPage = 1;
    renderContacts();
  }));

  el.querySelector("#ctSort")?.addEventListener("change", e => {
    state.contactSort = e.target.value;
    state.contactPage = 1;
    renderContacts();
  });

  el.querySelector("#cPrev")?.addEventListener("click", () => { state.contactPage--; renderContacts(); });
  el.querySelector("#cNext")?.addEventListener("click", () => { state.contactPage++; renderContacts(); });

  el.querySelector("#selAll")?.addEventListener("change", e => {
    const ids = [...contactsOnScreen.keys()];
    if (e.target.checked) ids.forEach(id => state.selected.add(id));
    else ids.forEach(id => state.selected.delete(id));
    renderContacts();
  });

  el.querySelectorAll(".row-check").forEach(box => box.addEventListener("click", e => {
    e.stopPropagation();                       // don't open the drawer
    const id = box.dataset.id;
    if (box.checked) state.selected.add(id); else state.selected.delete(id);
    box.closest("tr")?.classList.toggle("is-selected", box.checked);
    renderContacts();
  }));

  el.querySelectorAll("tr.row-click").forEach(tr => tr.addEventListener("click", () => {
    openContactDrawer(tr.dataset.id);
  }));

  el.querySelector("#bulkClear")?.addEventListener("click", () => { state.selected.clear(); renderContacts(); });

  el.querySelector("#bulkExport")?.addEventListener("click", async () => {
    const res = await bg({ action: "exportSelection", ids: [...state.selected] });
    if (!res?.csv) return toast("Export failed");
    downloadFile(res.csv, "prospekt-selection.csv");
    toast(`Exported ${state.selected.size} contacts`);
  });

  el.querySelector("#bulkDelete")?.addEventListener("click", async () => {
    const n = state.selected.size;
    if (!confirm(`Delete ${n} selected contact${n === 1 ? "" : "s"}? This cannot be undone.`)) return;
    const res = await bg({ action: "deleteContacts", ids: [...state.selected] });
    if (!res?.ok) return toast("Delete failed");
    state.selected.clear();
    toast(`Deleted ${res.removed} contact${res.removed === 1 ? "" : "s"}`);
    renderPage("contacts");
  });
}

const pagination = (start, total, page, pages, prefix) => `
  <div class="pagination">
    <span>Showing ${num(start + 1)}–${num(Math.min(start + PER_PAGE, total))} of ${num(total)}</span>
    <div class="pagination-btns">
      <button type="button" class="pg-btn" id="${prefix}Prev" ${page <= 1 ? "disabled" : ""}>← Prev</button>
      <span class="pg-indicator">${num(page)} / ${num(pages)}</span>
      <button type="button" class="pg-btn" id="${prefix}Next" ${page >= pages ? "disabled" : ""}>Next →</button>
    </div>
  </div>`;

const emptyState = (icon, title, body) =>
  `<div class="empty"><div class="empty-icon" aria-hidden="true">${icon}</div><h3>${esc(title)}</h3><p>${esc(body)}</p></div>`;

// ══════════════════════════════════════════════════════════════════════════
// CONTACT DRAWER
// ══════════════════════════════════════════════════════════════════════════
// One drawer serves both Contacts and Scan history: same shell, different rows
// and actions, so there is a single place that gets focus and Escape right.
let drawerActions = { primary: null, secondary: null };

/** Human description of how a value was found, from its stored source. */
function matchedBy(c) {
  switch (c.source) {
    case "mailto": return "mailto: link";
    case "tel": return "tel: link";
    case "schema": return "schema.org data";
    case "link": return "social pattern";
    case "custom_regex": return c.label ? `custom pattern “${c.label}”` : "custom pattern";
    case "text":
    default: return `${c.type} regex`;
  }
}

function drawerRow(key, valueHtml) {
  return `<div class="drawer-row"><div class="drawer-k">${esc(key)}</div><div class="drawer-v">${valueHtml}</div></div>`;
}

function openDrawer({ title, iconHtml = "", rows, primary, secondary }) {
  document.getElementById("drawerIcon").innerHTML = iconHtml;
  document.getElementById("drawerTitle").textContent = title;
  document.getElementById("drawerBody").innerHTML = rows;

  const p = document.getElementById("drawerPrimary");
  const s = document.getElementById("drawerSecondary");
  p.textContent = primary.label;
  s.textContent = secondary.label;
  s.className = "btn " + (secondary.tone || "");
  drawerActions = { primary: primary.run, secondary: secondary.run };

  const drawer = document.getElementById("drawer");
  drawer.hidden = false;
  requestAnimationFrame(() => {
    drawer.classList.add("open");
    document.getElementById("drawerScrim").classList.add("open");
  });
  document.getElementById("drawerClose").focus();
}

function closeDrawer() {
  const drawer = document.getElementById("drawer");
  drawer.classList.remove("open");
  document.getElementById("drawerScrim").classList.remove("open");
  // Keep it out of the tab order once hidden.
  setTimeout(() => { if (!drawer.classList.contains("open")) drawer.hidden = true; }, 240);
  drawerActions = { primary: null, secondary: null };
}

function setupDrawer() {
  document.getElementById("drawerClose").addEventListener("click", closeDrawer);
  document.getElementById("drawerScrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !document.getElementById("drawer").hidden) closeDrawer();
  });
  document.getElementById("drawerPrimary").addEventListener("click", () => drawerActions.primary?.());
  document.getElementById("drawerSecondary").addEventListener("click", () => drawerActions.secondary?.());
}

// ── Contact drawer ───────────────────────────────────────────────────────
function openContactDrawer(id) {
  const c = contactsOnScreen.get(id);
  if (!c) return;

  const pageUrl = safeUrl(c.found_at?.url);
  const pages = c.pageCount || 1;

  openDrawer({
    title: c.value,
    rows: [
      drawerRow("Type", typeChip(c)),
      drawerRow("Domain", `<span class="mono">${esc(c.found_at?.domain || "—")}</span>`),
      drawerRow("Page", `${esc(c.found_at?.pageTitle || "—")}${pageUrl
        ? `<span class="sub"><a href="${esc(pageUrl)}" target="_blank" rel="noopener noreferrer">${esc(c.found_at.url)}</a></span>` : ""}`),
      drawerRow("First seen", esc(fullDate(c.added_at))),
      drawerRow("Last seen", esc(c.last_seen_at ? timeAgo(c.last_seen_at) : timeAgo(c.added_at))),
      drawerRow("Times seen", `<span class="mono">${num(pages)}</span>
        <span class="badge badge-dup">across ${num(pages)} page${pages === 1 ? "" : "s"}</span>`),
      drawerRow("Exported", c.exported
        ? `Yes, ${esc(fullDate(c.exportedAt))}`
        : `<span style="color:var(--text-muted)">Not yet</span>`),
      c.isDuplicate
        ? drawerRow("Also found on", `<span class="mono">${num(c.domainSpread - 1)}</span> other domain${c.domainSpread === 2 ? "" : "s"}`)
        : "",
      drawerRow("Matched by", esc(matchedBy(c))),
    ].join(""),
    primary: {
      label: "Copy value",
      run: async () => {
        try { await navigator.clipboard.writeText(c.value); toast("Copied"); }
        catch { toast("Clipboard blocked by the browser"); }
      },
    },
    secondary: {
      label: "Discard",
      tone: "btn-danger",
      run: async () => {
        if (!confirm("Discard this contact? This cannot be undone.")) return;
        const res = await bg({ action: "deleteContact", contactId: c.id });
        if (!res?.ok) return toast("Delete failed");
        closeDrawer();
        toast("Contact discarded");
        renderPage("contacts");
      },
    },
  });
}

// ── Scan drawer ──────────────────────────────────────────────────────────
function openScanDrawer(id) {
  const s = scansOnScreen.get(id);
  if (!s) return;

  const c = s.counts || {};
  const producing = (s.topPages || []).map(p => `
    <div class="drawer-row">
      <div class="drawer-v" style="flex:1">${esc(p.t || "—")}</div>
      <div class="mono" style="color:var(--accent);font-weight:700">${num(p.n)}</div>
    </div>`).join("");

  openDrawer({
    title: s.found_at?.domain || "—",
    iconHtml: favCell(s.found_at?.domain, s.found_at?.favicon),
    rows: [
      drawerRow("Contacts", `<span class="mono" style="font-weight:700">${num(c.total)}</span>`),
      drawerRow("Emails", `<span class="mono">${num(c.emails)}</span>`),
      drawerRow("Phones", `<span class="mono">${num(c.phones)}</span>`),
      drawerRow("Socials", `<span class="mono">${num(c.socials)}</span>`),
      drawerRow("Custom", `<span class="mono">${num(c.customs)}</span>`),
      drawerRow("Pages scanned", `<span class="mono">${num(s.pagesScanned)}</span>`),
      drawerRow("Yield rate", yieldText(s)),
      drawerRow("First seen", esc(fullDate(s.added_at))),
      drawerRow("Last scan", esc(timeAgo(s.last_scanned_at || s.added_at))),
      s.skipped ? drawerRow("Status", `<span class="badge badge-role">On your skip list</span>`) : "",
      producing
        ? `<div class="drawer-row" style="border-bottom:none;padding-bottom:4px">
             <div class="drawer-k" style="width:auto">Pages that produced contacts</div></div>${producing}`
        : drawerRow("Pages that produced", `<span style="color:var(--text-muted)">None yet</span>`),
    ].join(""),
    primary: {
      label: "Rescan domain",
      run: () => rescanDomainFlow(s.found_at?.domain, s.found_at?.url),
    },
    secondary: {
      label: s.skipped ? "Stop skipping" : "Skip",
      run: async () => {
        const domain = s.found_at?.domain;
        await bg({ action: s.skipped ? "unskipDomain" : "skipDomain", domain });
        toast(s.skipped ? `No longer skipping ${domain}` : `Skipping ${domain}`);
        closeDrawer();
        renderPage("scans");
      },
    },
  });
}

// ══════════════════════════════════════════════════════════════════════════
// SCAN HISTORY
// ══════════════════════════════════════════════════════════════════════════
const SCAN_STATES = [
  { key: "all", label: "All" },
  { key: "yielding", label: "Yielding" },
  { key: "dry", label: "Dry" },
  { key: "skipped", label: "Skipped" },
];

const SCAN_SORTS = [
  { key: "contacts", label: "Most contacts" },
  { key: "pages", label: "Most pages" },
  { key: "yield", label: "Best yield" },
  { key: "recent", label: "Most recent" },
  { key: "domain", label: "By domain" },
];

// ── Modal ────────────────────────────────────────────────────────────────
let modalActions = [];

function openModal({ title, bodyHtml, actions }) {
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalBody").innerHTML = bodyHtml;

  modalActions = actions;
  document.getElementById("modalActions").innerHTML = actions.map((a, i) =>
    `<button type="button" class="btn ${a.tone || "btn-ghost"}" data-act="${i}">${esc(a.label)}</button>`).join("");
  document.querySelectorAll("#modalActions [data-act]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const act = modalActions[Number(btn.dataset.act)];
      if (act?.run) await act.run();
      if (act?.keepOpen !== true) closeModal();
    });
  });

  const scrim = document.getElementById("modalScrim");
  scrim.hidden = false;
  requestAnimationFrame(() => scrim.classList.add("open"));
  document.querySelector("#modalActions .btn-accent, #modalActions button")?.focus();
}

function closeModal() {
  const scrim = document.getElementById("modalScrim");
  scrim.classList.remove("open");
  setTimeout(() => { if (!scrim.classList.contains("open")) scrim.hidden = true; }, 200);
  modalActions = [];
}

function setupModal() {
  document.getElementById("modalClose").addEventListener("click", closeModal);
  document.getElementById("modalScrim").addEventListener("click", e => {
    if (e.target.id === "modalScrim") closeModal();   // scrim only, not the panel
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !document.getElementById("modalScrim").hidden) closeModal();
  });
}

/**
 * Rescanning only works on a page that is actually open — Prospekt reads the
 * DOM of tabs you are viewing, it does not fetch anything. Rather than telling
 * the user that and leaving them to it, offer to open the page here.
 */
async function rescanDomainFlow(domain, lastUrl) {
  if (!domain) return;
  const info = await bg({ action: "domainTabs", domain });
  const open = info?.count || 0;
  const home = `https://${domain}/`;
  const page = safeUrl(lastUrl);
  const actions = [];

  if (open) {
    actions.push({
      label: `Rescan ${open} open tab${open === 1 ? "" : "s"}`,
      tone: "btn-accent",
      run: async () => {
        const res = await bg({ action: "rescanDomain", domain });
        toast(res?.notified ? `Re-scanning ${res.notified} tab${res.notified === 1 ? "" : "s"}` : "Couldn't reach those tabs");
      },
    });
  }

  if (page && page !== home) {
    actions.push({
      label: open ? "Open last page" : "Open last page and scan",
      tone: open ? "btn-ghost" : "btn-accent",
      run: async () => {
        const res = await bg({ action: "openAndScan", url: page, domain });
        toast(res?.ok ? "Opened — scanning once it loads" : (res?.error || "Couldn't open that page"));
      },
    });
  }

  actions.push({
    label: page && page !== home ? "Open homepage" : "Open site and scan",
    tone: open || (page && page !== home) ? "btn-ghost" : "btn-accent",
    run: async () => {
      const res = await bg({ action: "openAndScan", url: home, domain });
      toast(res?.ok ? "Opened — scanning once it loads" : (res?.error || "Couldn't open that site"));
    },
  });

  actions.push({ label: "Cancel" });

  openModal({
    title: `Rescan ${domain}`,
    bodyHtml: `
      <p>Prospekt reads pages you have open — it never fetches anything on its own.</p>
      <p class="modal-state">${open
        ? `<b>${num(open)}</b> tab${open === 1 ? " is" : "s are"} open on this domain and can be re-scanned now.`
        : `No tabs are open on this domain. Opening one will scan it as soon as it loads.`}</p>
      ${page && page !== home ? `<p class="modal-url mono">${esc(page)}</p>` : ""}`,
    actions,
  });
}

let scansOnScreen = new Map();

/**
 * A yield rate is only meaningful once the domain has per-page data. Records
 * from before that tracking existed have none, and rendering the missing value
 * straight into the template printed a literal "undefined%". Treated as unknown
 * until the domain is scanned again — which is also the honest answer.
 */
const hasYield = s => typeof s?.yieldRate === "number";

const yieldText = s => (hasYield(s)
  ? `<span class="mono">${esc(s.yieldRate)}%</span> of pages`
  : `<span class="tone-muted">Not measured yet — rescan to find out</span>`);

async function renderScans() {
  const el = document.getElementById("page-scans");
  const filters = { limit: PER_PAGE, offset: (state.scanPage - 1) * PER_PAGE, sort: state.scanSort };
  if (state.search) filters.search = state.search;
  if (state.scanState !== "all") filters.state = state.scanState;

  let res = await bg({ action: "getScans", filters });
  let total = res?.total || 0;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));

  if (state.scanPage > pages) {
    state.scanPage = pages;
    filters.offset = (pages - 1) * PER_PAGE;
    res = await bg({ action: "getScans", filters });
    total = res?.total || 0;
  }

  const rows = res?.items || [];
  const sc = res?.stateCounts || {};
  const sum = res?.summary || {};
  const start = (state.scanPage - 1) * PER_PAGE;

  scansOnScreen = new Map(rows.map(s => [s.id, s]));
  state.scanSelected = new Set([...(state.scanSelected || [])].filter(id => scansOnScreen.has(id)));

  document.getElementById("pageSubtitle").textContent =
    sum.since ? `since ${new Date(sum.since).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}` : "";

  const usedPct = sum.recordsMax ? Math.min(100, (sum.recordsUsed / sum.recordsMax) * 100) : 0;
  const nearLimit = usedPct > 80;
  const selCount = state.scanSelected.size;

  el.innerHTML = `
    <div class="sh-strip">
      <div class="sh-cell">
        <div class="sh-k">Pages scanned</div>
        <div class="sh-v">${num(sum.pagesScanned)}</div>
      </div>
      <div class="sh-cell">
        <div class="sh-k">Domains yielding</div>
        <div class="sh-v">${num(sum.domainsYielding)}<span class="sh-of">of ${num(sum.domainsTotal)}</span></div>
      </div>
      <div class="sh-cell">
        <div class="sh-k">Dry domains</div>
        <div class="sh-v tone-phone">${num(sum.dryDomains)}</div>
      </div>
      <div class="sh-cell sh-cell-wide">
        <div class="sh-k">Record storage
          <span class="sh-quota">${num(sum.recordsUsed)} / ${num(sum.recordsMax)}</span></div>
        <div class="sh-meter"><i style="width:${usedPct}%;background:var(--${nearLimit ? "phone" : "accent"})"></i></div>
        <p class="sh-note">Past the limit, the oldest scan records are dropped.
          ${nearLimit ? "You're close — export before it wraps." : "You're well clear."}</p>
      </div>
    </div>

    <div class="ct-bar">
      <div class="ct-chips">
        ${SCAN_STATES.map(s => `
          <button type="button" class="ct-chip ${state.scanState === s.key ? "on" : ""}" data-state="${s.key}">
            ${esc(s.label)} <b>${num(sc[s.key] ?? 0)}</b>
          </button>`).join("")}
      </div>
      <div class="ct-sort">
        <select id="shSort" aria-label="Sort domains">
          ${SCAN_SORTS.map(s => `<option value="${s.key}" ${state.scanSort === s.key ? "selected" : ""}>${esc(s.label)}</option>`).join("")}
        </select>
      </div>
    </div>

    ${selCount ? `
      <div class="bulk">
        <b>${num(selCount)}</b> selected
        <span class="spacer"></span>
        <button type="button" class="btn btn-sm btn-danger" id="shDelete">Delete records</button>
        <button type="button" class="btn btn-sm btn-ghost" id="shClear">Clear</button>
      </div>` : ""}

    ${total === 0 ? emptyState("🕐", "Nothing here yet",
        state.search ? "No domain matches that search."
          : "Browse websites normally — every domain Prospekt looks at is listed here.") : `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th class="cell-check"><input type="checkbox" class="check" id="shSelAll"
              ${rows.length && rows.every(r => state.scanSelected.has(r.id)) ? "checked" : ""}
              aria-label="Select all on this page"></th>
            <th>Domain</th>
            <th class="num">Contacts</th>
            <th class="num">Pages</th>
            <th style="width:150px">Yield rate</th>
            <th style="width:96px">First seen</th>
            <th style="width:104px">Last scan</th>
            <th style="width:112px"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(s => {
            const c = s.counts || {};
            const bar = TYPE_META.filter(t => c[t.plural] > 0)
              .map(t => `<i style="flex:${c[t.plural]};background:var(--${t.key})"></i>`).join("");
            return `
            <tr class="row-click ${state.scanSelected.has(s.id) ? "is-selected" : ""} ${s.dry ? "is-dry" : ""}" data-id="${esc(s.id)}">
              <td class="cell-check">
                <input type="checkbox" class="check scan-check" data-id="${esc(s.id)}"
                  ${state.scanSelected.has(s.id) ? "checked" : ""} aria-label="Select ${esc(s.found_at?.domain)}">
              </td>
              <td>
                <div class="cell-domain">
                  ${favCell(s.found_at?.domain, s.found_at?.favicon)}
                  <div style="min-width:0">
                    <div class="dom-name">${esc(s.found_at?.domain || "—")}
                      ${s.dry ? `<span class="badge badge-role">Dry</span>` : ""}
                      ${s.skipped ? `<span class="badge badge-dup">Skipped</span>` : ""}</div>
                    <div class="dom-bar">${bar}</div>
                  </div>
                </div>
              </td>
              <td class="num num-strong">${c.total ? num(c.total) : "—"}</td>
              <td class="num">${num(s.pagesScanned)}</td>
              <td>
                <div class="yield">
                  <div class="yield-track"><i style="width:${hasYield(s) ? Math.max(2, s.yieldRate) : 0}%"></i></div>
                  <span class="yield-n ${!hasYield(s) ? "tone-muted" : s.yieldRate ? "" : "tone-phone"}"
                        title="${hasYield(s) ? "" : "No page-level data for this domain yet"}">${hasYield(s) ? esc(s.yieldRate) + "%" : "—"}</span>
                </div>
              </td>
              <td class="cell-time">${esc(shortDate(s.added_at))}</td>
              <td class="cell-time">${esc(timeAgo(s.last_scanned_at || s.added_at))}</td>
              <td class="cell-actions row-tools">
                <button type="button" class="cell-btn sh-rescan" data-domain="${esc(s.found_at?.domain)}" data-id="${esc(s.id)}" title="Rescan domain" aria-label="Rescan">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>
                </button>
                <button type="button" class="cell-btn sh-skip" data-domain="${esc(s.found_at?.domain)}" data-skipped="${s.skipped ? "1" : ""}"
                        title="${s.skipped ? "Stop skipping" : "Skip domain"}" aria-label="Skip">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.9" y1="4.9" x2="19.1" y2="19.1"/></svg>
                </button>
                <button type="button" class="cell-btn del sh-del" data-id="${esc(s.id)}" title="Delete record" aria-label="Delete">${IC.trash}</button>
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
    ${pagination(start, total, state.scanPage, pages, "s")}
    `}
  `;

  attachFaviconFallbacks(el);
  wireScans(el);
}

function wireScans(el) {
  el.querySelectorAll("[data-state]").forEach(b => b.addEventListener("click", () => {
    state.scanState = b.dataset.state;
    state.scanPage = 1;
    renderScans();
  }));

  el.querySelector("#shSort")?.addEventListener("change", e => {
    state.scanSort = e.target.value;
    state.scanPage = 1;
    renderScans();
  });

  el.querySelector("#sPrev")?.addEventListener("click", () => { state.scanPage--; renderScans(); });
  el.querySelector("#sNext")?.addEventListener("click", () => { state.scanPage++; renderScans(); });

  el.querySelector("#shSelAll")?.addEventListener("change", e => {
    const ids = [...scansOnScreen.keys()];
    if (e.target.checked) ids.forEach(id => state.scanSelected.add(id));
    else ids.forEach(id => state.scanSelected.delete(id));
    renderScans();
  });

  el.querySelectorAll(".scan-check").forEach(box => box.addEventListener("click", e => {
    e.stopPropagation();
    if (box.checked) state.scanSelected.add(box.dataset.id);
    else state.scanSelected.delete(box.dataset.id);
    renderScans();
  }));

  // Row tools must not also open the drawer.
  el.querySelectorAll(".row-tools").forEach(td => td.addEventListener("click", e => e.stopPropagation()));

  el.querySelectorAll(".sh-rescan").forEach(b => b.addEventListener("click", () => {
    const rec = scansOnScreen.get(b.dataset.id);
    rescanDomainFlow(b.dataset.domain, rec?.found_at?.url);
  }));

  el.querySelectorAll(".sh-skip").forEach(b => b.addEventListener("click", async () => {
    const skipped = !!b.dataset.skipped;
    await bg({ action: skipped ? "unskipDomain" : "skipDomain", domain: b.dataset.domain });
    toast(skipped ? `No longer skipping ${b.dataset.domain}` : `Skipping ${b.dataset.domain}`);
    renderPage("scans");
  }));

  el.querySelectorAll(".sh-del").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Delete this domain's record and every contact found on it?")) return;
    await bg({ action: "deleteScan", scanId: b.dataset.id });
    toast("Record deleted");
    renderPage("scans");
  }));

  el.querySelectorAll("tr.row-click").forEach(tr =>
    tr.addEventListener("click", () => openScanDrawer(tr.dataset.id)));

  el.querySelector("#shClear")?.addEventListener("click", () => { state.scanSelected.clear(); renderScans(); });

  el.querySelector("#shDelete")?.addEventListener("click", async () => {
    const n = state.scanSelected.size;
    if (!confirm(`Delete ${n} record${n === 1 ? "" : "s"} and every contact found on ${n === 1 ? "it" : "them"}?`)) return;
    const res = await bg({ action: "deleteScans", ids: [...state.scanSelected] });
    if (!res?.ok) return toast("Delete failed");
    state.scanSelected.clear();
    toast(`Deleted ${res.removed} record${res.removed === 1 ? "" : "s"}`);
    renderPage("scans");
  });
}

// ══════════════════════════════════════════════════════════════════════════
// INSIGHTS
// ══════════════════════════════════════════════════════════════════════════
const RANGE_OPTIONS = [
  { key: "7d", label: "7D" },
  { key: "30d", label: "30D" },
  { key: "12w", label: "12W" },
  { key: "all", label: "All" },
];

const RANGE_SUBTITLE = { "7d": "7 days", "30d": "30 days", "12w": "12 weeks", all: "all time" };

async function renderInsights() {
  const el = document.getElementById("page-insights");
  const i = await bg({ action: "getInsights", range: state.range });

  if (!i) {
    el.innerHTML = emptyState("⚠️", "Couldn't load insights",
      "The background worker didn't respond. Reload this page to try again.");
    return;
  }

  document.getElementById("pageSubtitle").textContent = RANGE_SUBTITLE[i.range] || "";

  const anyData = i.patterns.some(p => p.matches > 0);
  if (!anyData) {
    el.innerHTML = emptyState("📊", "Nothing in this window",
      "No contacts were collected in this period. Widen the range, or browse a few sites first.");
    return;
  }

  // ── What came in ──
  const peak = Math.max(...i.series.map(w => w.total), 1);
  const axis = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(peak * f)).reverse();

  const bars = i.series.map(w => `
    <div class="ins-col" title="${esc(w.label)}: ${num(w.total)}">
      <div class="ins-stack" style="height:${(w.total / peak) * 100}%">
        ${TYPE_META.filter(t => w[t.key] > 0).map(t =>
          `<i style="flex:${w[t.key]};background:var(--${t.key})"></i>`).join("")}
      </div>
      <span class="ins-x">${esc(w.label)}</span>
    </div>`).join("");

  // ── Pattern performance ──
  const patternRows = i.patterns.map(p => `
    <tr>
      <td>
        <div class="pat-name"><span class="pat-dot" style="background:var(--${p.type})"></span>${esc(p.name)}</div>
        <div class="pat-src mono">${esc(truncate(p.regex, 64))}</div>
      </td>
      <td class="num num-strong">${num(p.matches)}</td>
      <td>
        <div class="yield">
          <div class="yield-track"><i style="width:${Math.max(2, p.bar)}%;background:var(--${p.type})"></i></div>
          <span class="yield-n">${p.share}%</span>
        </div>
      </td>
      <td class="cell-time">${esc(p.lastMatch ? timeAgo(p.lastMatch) : "never")}</td>
      <td><span class="health health-${p.health.tone}">${esc(p.health.text)}</span></td>
    </tr>`).join("");

  // ── Email quality ──
  const q = i.emailQuality;
  const qPct = n => (q.total ? Math.round((n / q.total) * 100) : 0);
  const others = Math.max(0, q.companyDomainCount - q.topCompanyDomains.length);
  const qualityRows = [
    { label: "Company domains", n: q.company, tone: "email",
      hint: q.topCompanyDomains.length
        ? `${q.topCompanyDomains.join(", ")}${others ? `, and ${num(others)} others` : ""}` : "" },
    { label: "Free providers", n: q.free, tone: "social", hint: "gmail, outlook, yahoo, proton" },
    { label: "Role addresses", n: q.role, tone: "phone", hint: "info@, sales@, support@, hello@" },
  ].map(r => `
    <div class="qual">
      <div class="qual-hd">
        <span class="qual-label">${esc(r.label)}<small>${esc(r.hint)}</small></span>
        <span class="qual-n">${num(r.n)}<small>${qPct(r.n)}%</small></span>
      </div>
      <div class="qual-track"><i style="width:${Math.max(1, qPct(r.n))}%;background:var(--${r.tone})"></i></div>
    </div>`).join("");

  // ── Social platforms ──
  const socialMax = Math.max(...i.socials.items.map(s => s.count), 1);
  const socialRows = i.socials.items.map(s => `
    <div class="qual">
      <div class="qual-hd">
        <span class="qual-label">${esc(s.label)}</span>
        <span class="qual-n">${num(s.count)}<small>${i.socials.total ? Math.round((s.count / i.socials.total) * 100) : 0}%</small></span>
      </div>
      <div class="qual-track"><i style="width:${Math.max(1, (s.count / socialMax) * 100)}%;background:var(--social)"></i></div>
    </div>`).join("") || `<div class="chart-empty">No social profiles collected yet</div>`;

  // ── Yield distribution ──
  const distMax = Math.max(...i.distribution.map(b => b.count), 1);
  const dist = i.distribution.map(b => `
    <div class="dist-col">
      <span class="dist-n">${num(b.count)}</span>
      <div class="dist-bar" style="height:${Math.max(3, (b.count / distMax) * 100)}%"></div>
      <span class="dist-lbl">${esc(b.label)}<small>${esc(b.sub)}</small></span>
    </div>`).join("");

  el.innerHTML = `
    <section class="panel">
      <div class="panel-hd">
        <h2>What came in <span class="hd-sub">new contacts per week</span></h2>
        <div class="legend">
          ${TYPE_META.map(t => `<span><i style="background:var(--${t.key})"></i>${esc(t.label.replace(/s$/, ""))}</span>`).join("")}
        </div>
      </div>
      <div class="panel-body">
        <div class="ins-chart">
          <div class="ins-axis">${axis.map(v => `<span>${num(v)}</span>`).join("")}</div>
          <div class="ins-plot">${bars}</div>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-hd">
        <h2>Pattern performance <span class="hd-sub">what each regex is actually catching</span></h2>
        <button type="button" class="panel-link" data-goto="settings">Edit patterns →</button>
      </div>
      <div class="table-wrap" style="border:none;border-radius:0">
        <table class="data-table">
          <thead><tr>
            <th>Pattern</th><th class="num">Matches</th>
            <th style="width:170px">Share</th><th style="width:110px">Last match</th>
            <th style="width:190px">Health</th>
          </tr></thead>
          <tbody>${patternRows}</tbody>
        </table>
      </div>
    </section>

    <div class="ov-grid-2">
      <section class="panel">
        <div class="panel-hd"><h2>Email quality <span class="hd-sub">${num(q.total)} addresses</span></h2></div>
        <div class="panel-body">
          ${qualityRows}
          <p class="ins-note">Free-provider and role addresses are still contacts — they're just rarely
            the person you want. <button type="button" class="linkish" data-goto="contacts">Filter them out on Contacts</button>.</p>
        </div>
      </section>

      <section class="panel">
        <div class="panel-hd"><h2>Social platforms <span class="hd-sub">${num(i.socials.total)} profiles</span></h2></div>
        <div class="panel-body">${socialRows}</div>
      </section>
    </div>

    <section class="panel">
      <div class="panel-hd"><h2>Yield distribution <span class="hd-sub">${num(i.domainsTotal)} domains by contacts per page</span></h2></div>
      <div class="panel-body">
        <div class="dist">${dist}</div>
        <p class="ins-note">Most of what you browse gives up nothing — that's normal.
          ${i.zeroDomains ? `The ${num(i.zeroDomains)} domains in the zero bucket have been scanned repeatedly;
          skipping them cuts wasted work without costing you contacts.` : ""}
          ${i.unratedDomains ? `${num(i.unratedDomains)} older domains aren't shown here — they predate
          per-page tracking and will appear once they're scanned again.` : ""}</p>
      </div>
    </section>
  `;

  el.querySelectorAll("[data-goto]").forEach(b =>
    b.addEventListener("click", () => document.querySelector(`.nav-item[data-page="${b.dataset.goto}"]`)?.click()));
}

function setupRange() {
  const wrap = document.getElementById("rangeSelect");
  wrap.innerHTML = RANGE_OPTIONS.map(r =>
    `<button type="button" class="range-btn ${state.range === r.key ? "on" : ""}" data-range="${r.key}">${esc(r.label)}</button>`).join("");
  wrap.querySelectorAll(".range-btn").forEach(b => b.addEventListener("click", () => {
    state.range = b.dataset.range;
    setupRange();
    renderInsights();
  }));
}


// ══════════════════════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════════════════════
function setDirty(dirty) {
  state.patternsDirty = dirty;
  document.getElementById("patternSaveBar")?.classList.toggle("visible", dirty);
}

const SETTINGS_TABS = [
  { key: "scanning", label: "Scanning" },
  { key: "patterns", label: "Patterns" },
  { key: "social", label: "Social" },
  { key: "custom", label: "Custom" },
  { key: "filters", label: "Filter lists" },
  { key: "data", label: "Data" },
  { key: "danger", label: "Danger zone" },
];

const FILTER_LISTS = [
  { id: "skipDomainsTags", key: "skipDomains", label: "Skip domains", hint: "Pages on these domains are never read" },
  { id: "junkDomainsTags", key: "junkEmailDomains", label: "Junk email domains", hint: "Addresses on these domains are discarded" },
  { id: "junkPrefixesTags", key: "junkEmailPrefixes", label: "Junk email prefixes", hint: "Addresses whose local part matches exactly are discarded" },
  { id: "junkSocialTags", key: "junkSocialPaths", label: "Junk social paths", hint: "Social URLs on these path segments are discarded" },
];

// ── Regex tester ─────────────────────────────────────────────────────────
/**
 * Highlight every match in `text`. Built by slicing the raw string and escaping
 * each segment, so the output is safe even though the input is user text.
 */
function highlightMatches(text, source, flags, validate) {
  let re;
  try {
    re = new RegExp(source, flags.includes("g") ? flags : flags + "g");
  } catch (e) {
    return { error: e.message, html: esc(text), count: 0, kept: 0, dropped: 0 };
  }

  let out = "";
  let last = 0;
  let count = 0;
  let dropped = 0;
  let guard = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    // A pattern that can match the empty string would otherwise spin forever.
    if (m.index === re.lastIndex) { re.lastIndex++; continue; }
    if (++guard > 2000) break;
    // Extraction runs validation after matching, so a raw match count would
    // overstate what actually gets kept. Rejected matches are shown struck out.
    const ok = validate ? validate(m[0]) : true;
    if (!ok) dropped++;
    out += esc(text.slice(last, m.index))
      + `<mark class="${ok ? "" : "rejected"}">${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
    count++;
  }
  out += esc(text.slice(last));
  return { html: out, count, kept: count - dropped, dropped, truncated: guard > 2000 };
}

function runTester(id) {
  const panel = document.getElementById(`test-${id}`);
  if (!panel || panel.hidden) return;
  const input = document.getElementById(id);
  const flags = document.getElementById(`${id}-flags`)?.value || "g";
  const text = panel.querySelector(".tester-input").value;
  // Only the phone pattern has a post-match validator today.
  const validate = id === "pat-phone" ? PROSPEKT.isValidPhone : null;
  const res = highlightMatches(text, input.value, flags, validate);

  const count = panel.querySelector(".tester-count");
  const out = panel.querySelector(".tester-out");
  if (res.error) {
    count.textContent = "invalid regex";
    count.className = "tester-count is-bad";
    out.innerHTML = `<span class="tester-err">${esc(res.error)}</span>`;
    return;
  }
  const plural = n => `${n} match${n === 1 ? "" : "es"}`;
  count.textContent = res.dropped
    ? `${plural(res.count)} · ${res.kept} kept, ${res.dropped} discarded by validation`
    : plural(res.count) + (res.truncated ? " (showing first 2000)" : "");
  count.className = "tester-count" + (res.kept ? " is-ok" : "") + (res.dropped ? " has-drops" : "");
  out.innerHTML = res.html;
}

function testerPanel(id) {
  return `
    <div class="tester" id="test-${id}" hidden>
      <label class="tester-k">Sample text</label>
      <textarea class="tester-input" spellcheck="false" rows="6">${esc(PROSPEKT.SAMPLE_TEXT)}</textarea>
      <div class="tester-count">—</div>
      <pre class="tester-out"></pre>
    </div>`;
}

// ── Page ─────────────────────────────────────────────────────────────────
async function renderSettings() {
  const el = document.getElementById("page-settings");

  const storedPatterns = await bg({ action: "getPatterns" });
  if (storedPatterns === undefined) {
    el.innerHTML = emptyState("⚠️", "Couldn't load your settings",
      "The background worker didn't respond. Reload this page to try again — nothing has been changed.");
    return;
  }

  const settings = { ...PROSPEKT.DEFAULT_SETTINGS, ...(await bg({ action: "getSettings" }) || {}) };
  prefs = settings;
  const P = PROSPEKT.resolvePatterns(storedPatterns);
  const D = PROSPEKT.DEFAULTS;
  const insights = await bg({ action: "getInsights", range: "all" });
  const health = Object.fromEntries((insights?.patterns || []).map(p => [p.name, p]));
  const ov = await bg({ action: "getOverview" }) || {};
  const scanList = await bg({ action: "getScans", filters: { limit: 1 } });

  document.getElementById("pageSubtitle").textContent = "v" + chrome.runtime.getManifest().version;

  const meter = (used, max) => {
    const pct = max ? Math.min(100, (used / max) * 100) : 0;
    return `<div class="lim-meter">
      <div class="lim-head"><span>${num(used)} stored</span><span>${Math.round(pct)}%</span></div>
      <div class="lim-track"><i style="width:${Math.max(1, pct)}%;background:var(--${pct > 85 ? "phone" : "accent"})"></i></div>
    </div>`;
  };

  const healthBadge = name => {
    const h = health[name]?.health;
    if (!h) return "";
    return `<span class="health health-${h.tone}">${esc(h.text)}</span>`;
  };

  const statLine = name => {
    const h = health[name];
    if (!h) return "";
    return `<span class="pc-stat">${num(h.matches)} matches${h.lastMatch ? ` · last ${esc(timeAgo(h.lastMatch))}` : ""}</span>`;
  };

  const patternCard = (id, name, tone, source, flags, flagsId) => `
    <div class="pc">
      <div class="pc-hd">
        <span class="pat-dot" style="background:var(--${tone})"></span>
        <span class="pc-name">${esc(name)}</span>
        ${statLine(name)}
        <span class="pc-spacer"></span>
        ${healthBadge(name)}
      </div>
      <div class="pc-body">
        <div class="pat-input-wrap">
          <span class="pat-slash">/</span>
          <input type="text" class="pat-input" id="${id}" value="${esc(source)}" spellcheck="false">
          <span class="pat-slash">/</span>
          <input type="text" class="pat-flags" id="${flagsId}" value="${esc(flags)}" spellcheck="false" aria-label="${esc(name)} flags">
          <button type="button" class="pat-test-btn" data-test="${id}">Test</button>
        </div>
        <div class="pat-error" id="${id}-error" role="status"></div>
        ${testerPanel(id)}
      </div>
    </div>`;

  const socialRows = (P.socialPatterns || []).map(sp => socialRowHtml(sp)).join("");
  const customCards = (P.customPatterns || []).map((cp, i) => `
    <div class="pc" data-custom-row="${i}">
      <div class="pc-hd">
        <span class="pat-dot" style="background:var(--custom)"></span>
        <input type="text" class="tbl-input custom-label pc-label" value="${esc(cp.label)}" placeholder="Label" aria-label="Custom pattern label">
        ${statLine(cp.label)}
        <span class="pc-spacer"></span>
        ${healthBadge(cp.label)}
        <button type="button" class="cell-btn del custom-del" title="Remove" aria-label="Remove pattern">${IC.trash}</button>
      </div>
      <div class="pc-body">
        <div class="pat-input-wrap">
          <span class="pat-slash">/</span>
          <input type="text" class="pat-input custom-regex" id="cx-${i}" value="${esc(cp.regex)}" spellcheck="false">
          <span class="pat-slash">/</span>
          <input type="text" class="pat-flags custom-flags" id="cx-${i}-flags" value="${esc(cp.flags || "g")}" spellcheck="false" aria-label="Flags">
          <button type="button" class="pat-test-btn" data-test="cx-${i}">Test</button>
        </div>
        ${testerPanel(`cx-${i}`)}
      </div>
    </div>`).join("");

  const tagList = (list, items) => `
    <div class="pat-row">
      <label class="pat-label" for="${list.id}-input">
        ${esc(list.label)}<small class="pat-desc">${esc(list.hint)}</small>
      </label>
      <div class="list-tools">
        <span class="list-count">${num(items.length)}</span>
        <button type="button" class="linkish" data-reset-list="${list.key}" data-target="${list.id}">Reset to default</button>
      </div>
      <div class="tag-container" id="${list.id}">
        ${items.map(tagChip).join("")}
        <input type="text" id="${list.id}-input" class="tag-input" placeholder="Add and press Enter" data-for="${list.id}">
      </div>
    </div>`;

  const byType = ov.byType || {};
  const warn = settings.storageWarning;

  el.innerHTML = `
    <nav class="set-tabs" id="setTabs">
      ${SETTINGS_TABS.map((t, i) => `<button type="button" class="set-tab ${i === 0 ? "on" : ""}" data-tab="${t.key}">${esc(t.label)}</button>`).join("")}
    </nav>

    ${warn ? `
      <div class="banner banner-warn">
        <strong>Storage limit reached on ${esc(fullDate(warn.at))}.</strong>
        ${num(warn.droppedContacts)} contacts and ${num(warn.droppedScans)} scan records were dropped to keep working.
        <button type="button" class="btn btn-ghost btn-sm" id="dismissWarnBtn">Dismiss</button>
      </div>` : ""}

    <section class="settings-group" id="set-scanning">
      <h3>Scanning</h3>
      <p class="pat-intro">Prospekt reads the text of pages you visit and keeps anything matching your patterns. Nothing leaves this device.</p>

      <div class="setting-row">
        <div class="setting-label"><label for="toggleAutoScan">Scan pages automatically</label>
          <small>Every page you open is read as it loads. Turn this off to scan only when you click the toolbar icon.</small></div>
        <button type="button" id="toggleAutoScan" class="toggle ${settings.autoScan !== false ? "on" : ""}"
                role="switch" aria-checked="${settings.autoScan !== false}" aria-label="Scan pages automatically"></button>
      </div>

      <div class="setting-row">
        <div class="setting-label"><label for="remoteFaviconsToggle">Load remote favicons</label>
          <small>Off by default. Fetching them tells each site you're browsing your saved contacts.</small></div>
        <button type="button" id="remoteFaviconsToggle" class="toggle ${settings.remoteFavicons ? "on" : ""}"
                role="switch" aria-checked="${!!settings.remoteFavicons}" aria-label="Load remote favicons"></button>
      </div>

      <div class="setting-row">
        <div class="setting-label"><label for="maxScansInput">Maximum stored domains</label>
          <small>Past this limit the oldest scan records are dropped. Contacts are kept either way.</small></div>
        <div class="setting-control">
          ${meter(scanList?.total || 0, settings.maxScans)}
          <input type="number" id="maxScansInput" value="${esc(settings.maxScans)}" min="100" max="50000" step="100" class="num-input">
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label"><label for="maxContactsInput">Maximum stored contacts</label>
          <small>Guards the extension's storage quota. At the limit, new contacts stop being saved.</small></div>
        <div class="setting-control">
          ${meter(ov.totalContacts || 0, settings.maxContacts)}
          <input type="number" id="maxContactsInput" value="${esc(settings.maxContacts)}" min="1000" max="200000" step="1000" class="num-input">
        </div>
      </div>
    </section>

    <section class="settings-group" id="set-patterns">
      <h3>Extraction patterns</h3>
      <p class="pat-intro">The regexes that pull contacts out of page text. Open the tester to see what a pattern catches before you save it — saving re-scans every open tab.</p>
      ${patternCard("pat-email", "Email", "email", P.emailRegex, P.emailFlags || "gi", "pat-email-flags")}
      ${patternCard("pat-phone", "Phone", "phone", P.phoneRegex, P.phoneFlags || "g", "pat-phone-flags")}
    </section>

    <section class="settings-group" id="set-social">
      <h3>Social platforms</h3>
      <p class="pat-intro">One row per platform. The ID is used internally, the label is what you see in the contacts table, and flags are regex flags — <code>gi</code> means global and case-insensitive.</p>
      <div class="table-wrap">
        <table class="pat-table">
          <thead><tr><th style="width:120px">Platform ID</th><th style="width:130px">Label</th><th>Pattern</th><th style="width:70px">Flags</th><th style="width:40px"><span class="sr-only">Remove</span></th></tr></thead>
          <tbody id="socialTableBody">${socialRows}</tbody>
        </table>
      </div>
      <button type="button" class="btn-add" id="addSocialBtn">+ Add platform</button>
    </section>

    <section class="settings-group" id="set-custom">
      <h3>Custom patterns</h3>
      <p class="pat-intro">Your own regexes — crypto wallets, SKUs, ticket IDs, anything. Matches are stored as <span class="cell-type type-custom">custom</span> contacts. Flags default to <code>g</code>; add <code>i</code> to ignore case.</p>
      <div id="customList">${customCards}</div>
      <button type="button" class="btn-add" id="addCustomBtn">+ Add custom pattern</button>
    </section>

    <section class="settings-group" id="set-filters">
      <h3>Filter lists</h3>
      <p class="pat-intro">Everything Prospekt should ignore. Type a value and press Enter to add it.</p>
      ${FILTER_LISTS.map(l => tagList(l, P[l.key] || [])).join("")}
    </section>

    <section class="settings-group" id="set-data">
      <h3>Data</h3>
      <p class="pat-intro">Everything is stored locally in this browser profile. Export before you clear anything.</p>
      <div class="setting-row">
        <div class="setting-label">Contacts stored
          <small>${num(byType.email)} emails · ${num(byType.phone)} phones · ${num(byType.social)} socials · ${num(byType.custom)} custom</small></div>
        <button type="button" class="btn btn-accent btn-sm" id="settingsExportContacts">Export contacts</button>
      </div>
      <div class="setting-row">
        <div class="setting-label">Scan records
          <small>${num(ov.pagesScanned)} page scans across ${num(scanList?.total || 0)} domains</small></div>
        <button type="button" class="btn btn-accent btn-sm" id="settingsExportScans">Export scans</button>
      </div>
    </section>

    <section class="settings-group danger" id="set-danger">
      <h3>Danger zone</h3>
      <p class="pat-intro">Both of these are immediate and cannot be undone.</p>
      <div class="setting-row">
        <div class="setting-label">Reset every pattern and filter list
          <small>Restores the shipped defaults. Your contacts and scan history are untouched.</small></div>
        <button type="button" class="btn btn-danger btn-sm" id="resetPatternsBtn">Reset patterns</button>
      </div>
      <div class="setting-row">
        <div class="setting-label">Delete all contacts and scan history
          <small>Removes all ${num(ov.totalContacts)} contacts and ${num(ov.pagesScanned)} page scans from this device.</small></div>
        <button type="button" class="btn btn-danger btn-sm" id="clearAllBtn">Clear everything</button>
      </div>
    </section>

    <div class="save-bar" id="patternSaveBar" role="region" aria-label="Unsaved changes">
      <span class="save-bar-text">You have unsaved pattern changes</span>
      <div class="save-bar-actions">
        <button type="button" class="btn btn-ghost btn-sm" id="discardPatternsBtn">Discard</button>
        <button type="button" class="btn btn-accent btn-sm" id="savePatternsBtn">Save changes</button>
      </div>
    </div>
  `;

  setDirty(false);
  wireSettings(el, settings, D);
}

function wireSettings(el, settings, D) {
  // #page-settings outlives each render, so this is attached exactly once.
  if (!el.dataset.dirtyWatch) {
    el.dataset.dirtyWatch = "1";
    el.addEventListener("input", e => {
      if (e.target.closest(".pat-row, .pat-table, .pc")) setDirty(true);
      // Live tester feedback as you type the pattern or the sample.
      const pc = e.target.closest(".pc");
      if (pc && (e.target.classList.contains("pat-input")
              || e.target.classList.contains("pat-flags")
              || e.target.classList.contains("tester-input"))) {
        const id = pc.querySelector(".pat-input")?.id;
        if (id) runTester(id);
      }
    });
  }

  // Tabs scroll to their section and follow the scroll position.
  const page = el;
  el.querySelectorAll(".set-tab").forEach(tab => tab.addEventListener("click", () => {
    document.getElementById("set-" + tab.dataset.tab)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  if (!el.dataset.scrollWatch) {
    el.dataset.scrollWatch = "1";
    page.addEventListener("scroll", () => {
      const tabs = [...page.querySelectorAll(".set-tab")];
      if (!tabs.length) return;
      let active = tabs[0];
      for (const t of tabs) {
        const sec = document.getElementById("set-" + t.dataset.tab);
        if (sec && sec.getBoundingClientRect().top < 220) active = t;
      }
      tabs.forEach(t => t.classList.toggle("on", t === active));
    }, { passive: true });
  }

  const toggleSetting = async (btn, key, onDone) => {
    const was = btn.classList.contains("on");
    const on = !was;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-checked", String(on));
    const next = await bg({ action: "saveSettings", settings: { [key]: on } });
    if (failed(next) || !next) {
      btn.classList.toggle("on", was);
      btn.setAttribute("aria-checked", String(was));
      return toast("Couldn't save that setting — nothing changed");
    }
    prefs = next;
    onDone?.(on);
  };

  el.querySelector("#toggleAutoScan").addEventListener("click", function () {
    toggleSetting(this, "autoScan", on => { reflectAutoScan(); toast(on ? "Auto-scan enabled" : "Auto-scan paused"); });
  });
  el.querySelector("#remoteFaviconsToggle").addEventListener("click", function () {
    toggleSetting(this, "remoteFavicons", on => toast(on ? "Remote favicons on" : "Remote favicons off"));
  });

  const saveLimits = async () => {
    const maxScans = parseInt(el.querySelector("#maxScansInput").value, 10);
    const maxContacts = parseInt(el.querySelector("#maxContactsInput").value, 10);
    if (!Number.isInteger(maxScans) || maxScans < 100 || maxScans > 50000) return toast("Max domains must be 100–50,000");
    if (!Number.isInteger(maxContacts) || maxContacts < 1000 || maxContacts > 200000) return toast("Max contacts must be 1,000–200,000");
    const next = await bg({ action: "saveSettings", settings: { maxScans, maxContacts } });
    if (failed(next) || !next) return toast("Couldn't save storage limits");
    prefs = next;
    toast("Storage limits saved");
  };
  el.querySelector("#maxScansInput").addEventListener("change", saveLimits);
  el.querySelector("#maxContactsInput").addEventListener("change", saveLimits);

  // Tester toggles
  el.querySelectorAll(".pat-test-btn").forEach(btn => btn.addEventListener("click", () => {
    const id = btn.dataset.test;
    const panel = document.getElementById(`test-${id}`);
    panel.hidden = !panel.hidden;
    btn.classList.toggle("on", !panel.hidden);
    if (!panel.hidden) runTester(id);
  }));

  el.querySelector("#addSocialBtn").addEventListener("click", () => {
    const tbody = el.querySelector("#socialTableBody");
    tbody.insertAdjacentHTML("beforeend", socialRowHtml());
    wireRowDelete(tbody.lastElementChild);
    tbody.lastElementChild.querySelector(".social-platform").focus();
    setDirty(true);
  });

  el.querySelector("#addCustomBtn").addEventListener("click", () => {
    const list = el.querySelector("#customList");
    const i = list.querySelectorAll(".pc").length;
    list.insertAdjacentHTML("beforeend", `
      <div class="pc" data-custom-row="${i}">
        <div class="pc-hd">
          <span class="pat-dot" style="background:var(--custom)"></span>
          <input type="text" class="tbl-input custom-label pc-label" value="" placeholder="Label" aria-label="Custom pattern label">
          <span class="pc-spacer"></span>
          <button type="button" class="cell-btn del custom-del" title="Remove" aria-label="Remove pattern">${IC.trash}</button>
        </div>
        <div class="pc-body">
          <div class="pat-input-wrap">
            <span class="pat-slash">/</span>
            <input type="text" class="pat-input custom-regex" id="cx-new-${i}" value="" placeholder="Regex pattern" spellcheck="false">
            <span class="pat-slash">/</span>
            <input type="text" class="pat-flags custom-flags" id="cx-new-${i}-flags" value="g" spellcheck="false" aria-label="Flags">
            <button type="button" class="pat-test-btn" data-test="cx-new-${i}">Test</button>
          </div>
          ${testerPanel(`cx-new-${i}`)}
        </div>
      </div>`);
    const row = list.lastElementChild;
    row.querySelector(".custom-del").addEventListener("click", () => { row.remove(); setDirty(true); });
    row.querySelector(".pat-test-btn").addEventListener("click", () => {
      const id = row.querySelector(".pat-test-btn").dataset.test;
      const panel = document.getElementById(`test-${id}`);
      panel.hidden = !panel.hidden;
      if (!panel.hidden) runTester(id);
    });
    row.querySelector(".custom-label").focus();
    setDirty(true);
  });

  el.querySelectorAll("#socialTableBody tr").forEach(wireRowDelete);
  el.querySelectorAll(".pc .custom-del").forEach(btn => btn.addEventListener("click", () => {
    btn.closest(".pc").remove();
    setDirty(true);
  }));

  el.querySelectorAll(".tag-input").forEach(input => {
    const commit = () => { if (commitTagInput(input)) setDirty(true); };
    input.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(); }
    });
    input.addEventListener("blur", commit);   // typing then clicking Save used to discard it
  });
  el.querySelectorAll(".tag-x").forEach(wireTagRemove);

  el.querySelectorAll("[data-reset-list]").forEach(btn => btn.addEventListener("click", () => {
    const key = btn.dataset.resetList;
    const container = document.getElementById(btn.dataset.target);
    const input = container.querySelector(".tag-input");
    container.querySelectorAll(".tag").forEach(t => t.remove());
    (PROSPEKT.DEFAULTS[key] || []).forEach(v => {
      input.insertAdjacentHTML("beforebegin", tagChip(v));
      wireTagRemove(input.previousElementSibling.querySelector(".tag-x"));
    });
    btn.closest(".pat-row").querySelector(".list-count").textContent = num((PROSPEKT.DEFAULTS[key] || []).length);
    setDirty(true);
    toast(`${key} restored to defaults — save to apply`);
  }));

  el.querySelector("#savePatternsBtn").addEventListener("click", savePatterns);
  el.querySelector("#discardPatternsBtn").addEventListener("click", () => {
    setDirty(false);
    renderSettings();
    toast("Changes discarded");
  });

  el.querySelector("#resetPatternsBtn").addEventListener("click", async () => {
    if (!confirm("Reset every pattern and filter list to defaults? Your custom patterns will be lost.")) return;
    await bg({ action: "resetPatterns" });
    setDirty(false);
    await renderSettings();
    toast("Patterns reset to defaults");
  });

  el.querySelector("#settingsExportContacts").addEventListener("click", () => doExport("contacts"));
  el.querySelector("#settingsExportScans").addEventListener("click", () => doExport("scans"));

  el.querySelector("#dismissWarnBtn")?.addEventListener("click", async () => {
    await bg({ action: "saveSettings", settings: { storageWarning: null } });
    renderPage("settings");
  });

  el.querySelector("#clearAllBtn").addEventListener("click", async () => {
    if (!confirm("Delete ALL contacts and scan history? This cannot be undone.")) return;
    await bg({ action: "clearAll" });
    toast("All data cleared");
    renderPage("settings");
  });
}

/**
 * Collect the whole editor. Returns null (and points at the offending field)
 * rather than silently dropping bad or half-filled rows.
 */
function gatherPatterns() {
  const el = document.getElementById("page-settings");
  el.querySelectorAll(".is-invalid").forEach(n => n.classList.remove("is-invalid"));
  el.querySelectorAll(".tag-input").forEach(commitTagInput);   // flush unconfirmed text

  const emailInput = el.querySelector("#pat-email");
  const phoneInput = el.querySelector("#pat-phone");
  const emailRegex = emailInput.value.trim();
  const phoneRegex = phoneInput.value.trim();
  const emailFlags = el.querySelector("#pat-email-flags").value.trim() || "gi";
  const phoneFlags = el.querySelector("#pat-phone-flags").value.trim() || "g";

  if (!emailRegex) return flagError("Email regex", emailInput, "cannot be empty");
  if (!phoneRegex) return flagError("Phone regex", phoneInput, "cannot be empty");

  let check = validateRegex(emailRegex, emailFlags);
  if (!check.ok) return flagError("Email regex", emailInput, check.error);
  check = validateRegex(phoneRegex, phoneFlags);
  if (!check.ok) return flagError("Phone regex", phoneInput, check.error);

  const socialPatterns = [];
  for (const [i, tr] of [...el.querySelectorAll("#socialTableBody tr")].entries()) {
    const platformEl = tr.querySelector(".social-platform");
    const labelEl = tr.querySelector(".social-label");
    const regexEl = tr.querySelector(".social-regex");
    const platform = platformEl.value.trim();
    const label = labelEl.value.trim();
    const regex = regexEl.value.trim();
    const flags = tr.querySelector(".social-flags").value.trim() || "gi";

    if (!platform && !label && !regex) continue;      // untouched blank row
    if (!platform) return flagError(`Social row ${i + 1}`, platformEl, "needs a platform ID");
    if (!label) return flagError(`Social row ${i + 1}`, labelEl, "needs a label");
    if (!regex) return flagError(`Social row ${i + 1}`, regexEl, "needs a regex");
    const r = validateRegex(regex, flags);
    if (!r.ok) return flagError(`Social “${label}”`, regexEl, r.error);
    socialPatterns.push({ platform, label, regex, flags });
  }

  const customPatterns = [];
  for (const [i, card] of [...el.querySelectorAll("#customList .pc")].entries()) {
    const labelEl = card.querySelector(".custom-label");
    const regexEl = card.querySelector(".custom-regex");
    const label = labelEl.value.trim();
    const regex = regexEl.value.trim();
    const flags = card.querySelector(".custom-flags").value.trim() || "g";

    if (!label && !regex) continue;
    if (!label) return flagError(`Custom pattern ${i + 1}`, labelEl, "needs a label");
    if (!regex) return flagError(`Custom pattern ${i + 1}`, regexEl, "needs a regex");
    const r = validateRegex(regex, flags);
    if (!r.ok) return flagError(`Custom “${label}”`, regexEl, r.error);
    customPatterns.push({ label, regex, flags });
  }

  const tags = id => [...el.querySelectorAll(`#${id} .tag`)].map(t => t.dataset.value).filter(Boolean);

  return {
    emailRegex, emailFlags, phoneRegex, phoneFlags,
    socialPatterns, customPatterns,
    skipDomains: tags("skipDomainsTags"),
    junkEmailDomains: tags("junkDomainsTags"),
    junkEmailPrefixes: tags("junkPrefixesTags"),
    junkSocialPaths: tags("junkSocialTags"),
  };
}

// ── Settings portability ─────────────────────────────────────────────────
function setupSettingsIO() {
  document.getElementById("exportSettingsBtn").addEventListener("click", async () => {
    const payload = await bg({ action: "exportSettings" });
    if (!payload) return toast("Export failed");
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "prospekt-settings.json";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 20000);
    toast("Settings exported");
  });

  const file = document.getElementById("importFile");
  document.getElementById("importSettingsBtn").addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    file.value = "";                      // allow re-picking the same file
    if (!f) return;
    let payload;
    try { payload = JSON.parse(await f.text()); }
    catch { return toast("That file isn't valid JSON"); }

    if (!confirm("Replace your current patterns and scanning settings with this file? Contacts and history are untouched.")) return;
    const res = await bg({ action: "importSettings", payload });
    if (!res?.ok) return toast(res?.error || "Import failed");
    prefs = res.settings;
    reflectAutoScan();
    toast("Settings imported");
    renderPage("settings");
  });
}

const tagChip = value =>
  `<span class="tag" data-value="${esc(value)}">${esc(value)}<button type="button" class="tag-x" aria-label="Remove ${esc(value)}">×</button></span>`;

const socialRowHtml = (sp = {}) => `
  <tr>
    <td><input type="text" class="tbl-input social-platform" value="${esc(sp.platform)}" placeholder="platform_id"></td>
    <td><input type="text" class="tbl-input social-label" value="${esc(sp.label)}" placeholder="Display Name"></td>
    <td><input type="text" class="tbl-input social-regex" value="${esc(sp.regex)}" placeholder="https?://…" spellcheck="false"></td>
    <td><input type="text" class="tbl-input social-flags" value="${esc(sp.flags || "gi")}" placeholder="gi" spellcheck="false"></td>
    <td><button type="button" class="cell-btn del row-del" title="Remove" aria-label="Remove row">${IC.trash}</button></td>
  </tr>`;

// Social rows only — custom patterns are cards now and own their own delete.
function wireRowDelete(row) {
  row.querySelector(".row-del")?.addEventListener("click", () => {
    row.remove();
    setDirty(true);
  });
}

function wireTagRemove(btn) {
  btn.addEventListener("click", () => { btn.closest(".tag")?.remove(); setDirty(true); });
}

function commitTagInput(input) {
  const value = input.value.trim().replace(/^,|,$/g, "").trim();
  input.value = "";
  if (!value) return false;
  const container = document.getElementById(input.dataset.for);
  const exists = [...container.querySelectorAll(".tag")].some(t => t.dataset.value === value);
  if (exists) return false;
  input.insertAdjacentHTML("beforebegin", tagChip(value));
  wireTagRemove(input.previousElementSibling.querySelector(".tag-x"));
  return true;
}

function validateRegex(source, flags) {
  try { new RegExp(source, flags); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function flagError(field, input, message) {
  input?.classList.add("is-invalid");
  input?.focus();
  toast(`${field}: ${message}`);
  return null;
}

/**
 * Collect the whole editor into a saveable object. Returns null (and points at
 * the offending field) rather than silently dropping bad or half-filled rows,
 * which is what made edits look like they "didn't save".
 */
async function savePatterns() {
  const patterns = gatherPatterns();
  if (!patterns) return;                    // gatherPatterns already reported why
  const res = await bg({ action: "savePatterns", patterns });
  if (!res?.ok) return toast("Save failed: " + (res?.error || "unknown error"));
  setDirty(false);
  const rescan = await bg({ action: "rescanTabs" });
  toast(rescan?.notified ? `Patterns saved — re-scanning ${rescan.notified} open tab${rescan.notified === 1 ? "" : "s"}` : "Patterns saved");
}

// ══════════════════════════════════════════════════════════════════════════
// SHARED ACTIONS
// ══════════════════════════════════════════════════════════════════════════
function attachActions(container) {
  container.querySelectorAll(".copy-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(btn.dataset.copy); }
      catch { return toast("Clipboard blocked by the browser"); }
      btn.innerHTML = IC.check;
      btn.classList.add("copied");
      setTimeout(() => { btn.innerHTML = IC.copy; btn.classList.remove("copied"); }, 1200);
    });
  });

  container.querySelectorAll(".open-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const url = safeUrl(btn.dataset.url);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    });
  });

  container.querySelectorAll(".del-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const res = await bg({ action: "deleteContact", contactId: btn.dataset.id });
      if (!res?.ok) { btn.disabled = false; return toast("Delete failed"); }
      toast("Contact deleted");
      renderPage("contacts");
    });
  });
}
