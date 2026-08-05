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

// Only http(s) survives — blocks javascript:/data: URLs harvested from pages.
function safeUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(String(url), location.href);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────
const bg = msg => new Promise(resolve => {
  try {
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) {
        console.warn("[Prospekt]", msg.action, chrome.runtime.lastError.message);
        return resolve(null);
      }
      resolve(res);
    });
  } catch (err) {
    console.warn("[Prospekt]", msg.action, err);
    resolve(null);
  }
});

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
document.addEventListener("DOMContentLoaded", async () => {
  prefs = { ...PROSPEKT.DEFAULT_SETTINGS, ...(await bg({ action: "getSettings" }) || {}) };
  setupNav();
  setupSearch();
  setupExport();
  reflectAutoScan();
  renderPage("overview");
});

function reflectAutoScan() {
  const el = document.getElementById("autoScanStatus");
  const on = prefs.autoScan !== false;
  el.textContent = on ? "Active" : "Paused";
  el.classList.toggle("is-paused", !on);
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
  document.getElementById("exportContactsBtn").addEventListener("click", () => doExport("contacts"));
}

async function doExport(type) {
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

  const titles = { overview: "Overview", contacts: "Contacts", scans: "Scan History", insights: "Insights", settings: "Settings" };
  document.getElementById("pageTitle").textContent = titles[page] || page;

  // Search only applies to two pages — leaving a stale query visible on the
  // others made the numbers look wrong.
  const searchBox = document.querySelector(".search-global");
  searchBox.style.visibility = (page === "contacts" || page === "scans") ? "visible" : "hidden";

  const stats = await bg({ action: "getStats" });
  document.getElementById("navContactCount").textContent = num(stats?.totalContacts);
  document.getElementById("navScanCount").textContent = num(stats?.totalScans);

  switch (page) {
    case "overview": return renderOverview(stats);
    case "contacts": return renderContacts();
    case "scans": return renderScans();
    case "insights": return renderInsights(stats);
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
async function renderOverview(stats) {
  const s = { ...EMPTY_STATS, ...(stats || await bg({ action: "getStats" }) || {}) };
  const res = await bg({ action: "getContacts", filters: { limit: 6 } });
  const recent = res?.items || [];

  const el = document.getElementById("page-overview");
  el.innerHTML = `
    <div class="stat-grid">
      ${statCard("Total Contacts", s.totalContacts, "accent")}
      ${statCard("Emails", s.emails, "purple")}
      ${statCard("Socials", s.socials, "blue")}
      ${statCard("Domains Scanned", s.totalDomains, "amber")}
    </div>

    <div class="grid-2col">
      <section>
        <div class="section-header">
          <h2 class="section-title">Recent Contacts</h2>
          <button type="button" class="section-action" data-goto="contacts">View all →</button>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Type</th><th>Value</th><th>Found on</th><th>When</th></tr></thead>
            <tbody>${recent.length ? recent.map(c => `
              <tr>
                <td>${typeChip(c)}</td>
                <td class="cell-value">${esc(truncate(c.value, 32))}</td>
                <td>${domainCell(c.found_at?.domain, c.found_at?.favicon)}</td>
                <td class="cell-time" title="${esc(fullDate(c.added_at))}">${esc(timeAgo(c.added_at))}</td>
              </tr>`).join("")
              : `<tr><td colspan="4" class="cell-empty">No contacts yet — browse a few sites and they'll appear here.</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div class="section-header"><h2 class="section-title">Activity (Last 7 Days)</h2></div>
        <div class="chart-card chart-card-flush">
          <div class="mini-chart">${sparkline(s.dailyScans)}</div>
          <div class="chart-footnote">${num(s.totalScans)} total scans across ${num(s.totalDomains)} domains</div>
        </div>
      </section>
    </div>
  `;

  attachFaviconFallbacks(el);
  el.querySelectorAll("[data-goto]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelector(`.nav-item[data-page="${btn.dataset.goto}"]`)?.click();
    });
  });
}

const statCard = (label, value, tone) => `
  <div class="stat-card">
    <div class="stat-card-label"><span class="dot dot-${tone}"></span> ${esc(label)}</div>
    <div class="stat-card-value tone-${tone}">${num(value)}</div>
  </div>`;

const truncate = (s, n) => {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n) + "…" : str;
};

function typeChip(c) {
  const type = TYPES.includes(c.type) ? c.type : "other";
  const text = c.type === "social" ? (c.platform || "social")
    : c.type === "custom" ? (c.label || "custom")
    : c.type;
  return `<span class="cell-type type-${esc(type)}" title="${esc(c.type)}">${esc(truncate(text, 18))}</span>`;
}

// ══════════════════════════════════════════════════════════════════════════
// CONTACTS
// ══════════════════════════════════════════════════════════════════════════
async function renderContacts() {
  const el = document.getElementById("page-contacts");
  const filters = { limit: PER_PAGE, offset: (state.contactPage - 1) * PER_PAGE };
  if (state.contactFilter !== "all") filters.type = state.contactFilter;
  if (state.search) filters.search = state.search;

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
  const start = (state.contactPage - 1) * PER_PAGE;

  el.innerHTML = `
    <div class="filter-tabs" role="tablist" aria-label="Contact type">
      ${TYPES.map(t => `
        <button type="button" role="tab" class="filter-tab ${state.contactFilter === t ? "active" : ""}"
                aria-selected="${state.contactFilter === t}" data-filter="${t}">
          ${t === "all" ? "All" : esc(t.charAt(0).toUpperCase() + t.slice(1) + "s")}
        </button>`).join("")}
    </div>

    ${total === 0 ? emptyState("📭", "No contacts found",
        state.search ? "Nothing matches that search." : "Browse some websites and contacts will appear automatically.") : `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:110px">Type</th>
            <th>Value</th>
            <th style="width:170px">Domain</th>
            <th>Page</th>
            <th style="width:100px">Found</th>
            <th style="width:96px"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(c => `
            <tr data-id="${esc(c.id)}">
              <td>${typeChip(c)}</td>
              <td class="cell-value">${esc(c.value)}</td>
              <td>${domainCell(c.found_at?.domain, c.found_at?.favicon)}</td>
              <td class="cell-page" title="${esc(c.found_at?.pageTitle || "")}">${esc(c.found_at?.pageTitle || "—")}</td>
              <td class="cell-time" title="${esc(fullDate(c.added_at))}">${esc(timeAgo(c.added_at))}</td>
              <td class="cell-actions">
                <button type="button" class="cell-btn copy-btn" data-copy="${esc(c.value)}" title="Copy" aria-label="Copy value">${IC.copy}</button>
                ${safeUrl(c.value) ? `<button type="button" class="cell-btn open-btn" data-url="${esc(safeUrl(c.value))}" title="Open" aria-label="Open link">${IC.link}</button>` : ""}
                <button type="button" class="cell-btn del del-btn" data-id="${esc(c.id)}" title="Delete" aria-label="Delete contact">${IC.trash}</button>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
    ${pagination(start, total, state.contactPage, pages, "c")}
    `}
  `;

  attachFaviconFallbacks(el);

  el.querySelectorAll(".filter-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      state.contactFilter = btn.dataset.filter;
      state.contactPage = 1;
      renderContacts();
    });
  });
  el.querySelector("#cPrev")?.addEventListener("click", () => { state.contactPage--; renderContacts(); });
  el.querySelector("#cNext")?.addEventListener("click", () => { state.contactPage++; renderContacts(); });

  attachActions(el);
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
// SCAN HISTORY
// ══════════════════════════════════════════════════════════════════════════
async function renderScans() {
  const el = document.getElementById("page-scans");
  const filters = {};
  if (state.search) filters.search = state.search;

  const all = await bg({ action: "getScans", filters }) || [];
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  if (state.scanPage > pages) state.scanPage = pages;
  const start = (state.scanPage - 1) * PER_PAGE;
  const rows = all.slice(start, start + PER_PAGE);

  el.innerHTML = `
    <div class="page-toolbar">
      <div class="toolbar-meta">${num(total)} domain${total === 1 ? "" : "s"} scanned</div>
      <button type="button" class="btn btn-accent btn-sm" id="exportScansBtn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Export Scans
      </button>
    </div>

    ${total === 0 ? emptyState("🕐", "No scans yet",
        state.search ? "Nothing matches that search." : "Browse websites normally — Prospekt scans every page in the background.") : `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Domain</th>
            <th class="num">Emails</th>
            <th class="num">Phones</th>
            <th class="num">Socials</th>
            <th class="num">Custom</th>
            <th class="num">Total</th>
            <th class="num">Scans</th>
            <th style="width:100px">First Seen</th>
            <th style="width:100px">Last Scan</th>
            <th style="width:44px"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(s => {
            const c = s.counts || {};
            return `
            <tr>
              <td>${domainCell(s.found_at?.domain, s.found_at?.favicon)}</td>
              <td class="num ${c.emails ? "tone-accent" : "tone-muted"}">${num(c.emails)}</td>
              <td class="num ${c.phones ? "tone-purple" : "tone-muted"}">${num(c.phones)}</td>
              <td class="num ${c.socials ? "tone-blue" : "tone-muted"}">${num(c.socials)}</td>
              <td class="num ${c.customs ? "tone-pink" : "tone-muted"}">${num(c.customs)}</td>
              <td class="num num-strong">${num(c.total)}</td>
              <td class="num">${num(s.scan_count || 1)}</td>
              <td class="cell-time" title="${esc(fullDate(s.added_at))}">${esc(timeAgo(s.added_at))}</td>
              <td class="cell-time" title="${esc(fullDate(s.last_scanned_at || s.added_at))}">${esc(timeAgo(s.last_scanned_at || s.added_at))}</td>
              <td><button type="button" class="cell-btn del scan-del" data-scan-id="${esc(s.id)}" title="Delete scan" aria-label="Delete scan">${IC.trash}</button></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
    ${pagination(start, total, state.scanPage, pages, "s")}
    `}
  `;

  attachFaviconFallbacks(el);
  el.querySelector("#sPrev")?.addEventListener("click", () => { state.scanPage--; renderScans(); });
  el.querySelector("#sNext")?.addEventListener("click", () => { state.scanPage++; renderScans(); });
  el.querySelector("#exportScansBtn")?.addEventListener("click", () => doExport("scans"));

  el.querySelectorAll(".scan-del").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this domain's scan record and every contact found on it?")) return;
      await bg({ action: "deleteScan", scanId: btn.dataset.scanId });
      toast("Scan deleted");
      renderPage("scans");
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// INSIGHTS
// ══════════════════════════════════════════════════════════════════════════
async function renderInsights(stats) {
  const s = { ...EMPTY_STATS, ...(stats || await bg({ action: "getStats" }) || {}) };
  const el = document.getElementById("page-insights");

  if (!s.totalContacts) {
    el.innerHTML = emptyState("📊", "No data yet", "Browse some websites and analytics will build up here.");
    return;
  }

  const maxDomain = s.topDomains[0]?.count || 1;
  const tones = ["accent", "blue", "purple", "amber", "pink", "cyan", "red"];

  // Every type is represented, so the percentages actually add up to 100.
  const breakdown = [
    { label: "Emails", count: s.emails, tone: "accent" },
    { label: "Phones", count: s.phones, tone: "purple" },
    { label: "Socials", count: s.socials, tone: "blue" },
    { label: "Custom", count: s.customs, tone: "pink" },
  ].filter(t => t.count > 0);

  const barRows = (entries, offset = 0) => entries.map(([label, count], i) => {
    const max = Math.max(...entries.map(e => e[1]), 1);
    return `
      <div class="bar-h-row">
        <span class="bar-h-label" title="${esc(label)}">${esc(label)}</span>
        <div class="bar-h-track">
          <div class="bar-h-fill tone-bg-${tones[(i + offset) % tones.length]}" style="width:${Math.max(8, (count / max) * 100)}%">${num(count)}</div>
        </div>
      </div>`;
  }).join("");

  el.innerHTML = `
    <div class="stat-grid">
      ${statCard("Total Scans", s.totalScans, "accent")}
      ${statCard("Unique Domains", s.totalDomains, "blue")}
      ${statCard("Phones Found", s.phones, "purple")}
      ${statCard("Custom Matches", s.customs, "pink")}
    </div>

    <div class="grid-2col">
      <div class="chart-card">
        <h3>Top Domains by Contacts</h3>
        <div class="bar-h">
          ${s.topDomains.map((d, i) => `
            <div class="bar-h-row">
              <span class="bar-h-label" title="${esc(d.domain)}">${esc(d.domain)}</span>
              <div class="bar-h-track">
                <div class="bar-h-fill tone-bg-${tones[i % tones.length]}" style="width:${Math.max(8, (d.count / maxDomain) * 100)}%">${num(d.count)}</div>
              </div>
            </div>`).join("") || `<div class="chart-empty">No data</div>`}
        </div>
      </div>

      <div class="chart-card">
        <h3>Contact Type Breakdown</h3>
        <div class="breakdown">
          ${breakdown.map(t => {
            const pct = Math.round(t.count / s.totalContacts * 100);
            return `
            <div>
              <div class="breakdown-head">
                <span>${esc(t.label)}</span>
                <span class="tone-${t.tone} breakdown-num">${num(t.count)} (${pct}%)</span>
              </div>
              <div class="breakdown-track">
                <div class="breakdown-fill tone-bg-${t.tone}" style="width:${Math.max(2, pct)}%"></div>
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>

      <div class="chart-card">
        <h3>Social Platform Breakdown</h3>
        <div class="bar-h">
          ${barRows(Object.entries(s.platformCounts || {}).sort((a, b) => b[1] - a[1]), 2)
            || `<div class="chart-empty">No social profiles collected yet</div>`}
        </div>
      </div>

      <div class="chart-card">
        <h3>${Object.keys(s.customLabelCounts || {}).length ? "Custom Pattern Matches" : "Daily Scan Activity"}</h3>
        ${Object.keys(s.customLabelCounts || {}).length
          ? `<div class="bar-h">${barRows(Object.entries(s.customLabelCounts).sort((a, b) => b[1] - a[1]), 4)}</div>`
          : `<div class="mini-chart mini-chart-tall">${sparkline(s.dailyScans)}</div>`}
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════════════════════
function setDirty(dirty) {
  state.patternsDirty = dirty;
  document.getElementById("patternSaveBar")?.classList.toggle("visible", dirty);
}

async function renderSettings() {
  const el = document.getElementById("page-settings");
  const settings = { ...PROSPEKT.DEFAULT_SETTINGS, ...(await bg({ action: "getSettings" }) || {}) };
  prefs = settings;
  const stats = { ...EMPTY_STATS, ...(await bg({ action: "getStats" }) || {}) };
  const P = PROSPEKT.resolvePatterns(await bg({ action: "getPatterns" }));
  const D = PROSPEKT.DEFAULTS;

  const regexRow = (id, label, value, placeholder) => `
    <div class="pat-row">
      <label class="pat-label" for="${id}">${esc(label)}</label>
      <div class="pat-input-wrap">
        <span class="pat-slash" aria-hidden="true">/</span>
        <input type="text" class="pat-input" id="${id}" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false">
        <span class="pat-slash" aria-hidden="true">/</span>
        <button type="button" class="pat-test-btn" data-test="${id}">Test</button>
      </div>
      <div class="pat-error" id="${id}-error" role="status"></div>
    </div>`;

  const tagList = (id, label, description, items) => `
    <div class="pat-row">
      <label class="pat-label" for="${id}-input">${esc(label)}<small class="pat-desc">${esc(description)}</small></label>
      <div class="tag-container" id="${id}">
        ${(items || []).map(item => tagChip(item)).join("")}
        <input type="text" id="${id}-input" class="tag-input" placeholder="Type &amp; press Enter" data-for="${id}">
      </div>
    </div>`;

  const socialRows = (P.socialPatterns || []).map(sp => socialRowHtml(sp)).join("");
  const customRows = (P.customPatterns || []).map(cp => customRowHtml(cp)).join("");
  const hasCustoms = (P.customPatterns || []).length > 0;

  el.innerHTML = `
    <div class="settings-group">
      <h3>Scanning</h3>
      <div class="setting-row">
        <div class="setting-label"><label for="toggleAutoScan">Auto-scan pages</label><small>Extract contacts from every page you visit</small></div>
        <button type="button" id="toggleAutoScan" class="toggle ${settings.autoScan !== false ? "on" : ""}"
                role="switch" aria-checked="${settings.autoScan !== false}" aria-label="Auto-scan pages"></button>
      </div>
      <div class="setting-row">
        <div class="setting-label"><label for="remoteFaviconsToggle">Load remote favicons</label><small>Off by default — fetching them would tell each site you're browsing your library</small></div>
        <button type="button" id="remoteFaviconsToggle" class="toggle ${settings.remoteFavicons ? "on" : ""}"
                role="switch" aria-checked="${!!settings.remoteFavicons}" aria-label="Load remote favicons"></button>
      </div>
      <div class="setting-row">
        <div class="setting-label"><label for="maxScansInput">Max stored domains</label><small>Oldest scan records are dropped past this limit</small></div>
        <div class="setting-control">
          <input type="number" id="maxScansInput" value="${esc(settings.maxScans)}" min="100" max="50000" step="100" class="num-input">
          <button type="button" class="btn btn-accent btn-sm" id="saveLimitsBtn">Save</button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label"><label for="maxContactsInput">Max stored contacts</label><small>Guards against filling the extension's storage quota</small></div>
        <div class="setting-control">
          <input type="number" id="maxContactsInput" value="${esc(settings.maxContacts)}" min="1000" max="200000" step="1000" class="num-input">
        </div>
      </div>
    </div>

    <div class="settings-group">
      <h3>Extraction Patterns</h3>
      <p class="pat-intro">Regexes used to pull contacts out of page text. Saving re-scans every open tab immediately.</p>
      ${regexRow("pat-email", "Email Regex", P.emailRegex, D.emailRegex)}
      ${regexRow("pat-phone", "Phone Regex", P.phoneRegex, D.phoneRegex)}
    </div>

    <div class="settings-group">
      <h3>Social Platform Patterns</h3>
      <p class="pat-intro">One row per platform. <strong>Platform ID</strong> is used internally, <strong>Label</strong> is what you see, <strong>Flags</strong> are regex flags (<code>gi</code> = global + case-insensitive).</p>
      <div class="table-wrap">
        <table class="pat-table">
          <thead><tr><th style="width:120px">Platform ID</th><th style="width:130px">Label</th><th>Regex</th><th style="width:70px">Flags</th><th style="width:40px"><span class="sr-only">Remove</span></th></tr></thead>
          <tbody id="socialTableBody">${socialRows}</tbody>
        </table>
      </div>
      <button type="button" class="btn-add" id="addSocialBtn">+ Add Social Platform</button>
    </div>

    <div class="settings-group">
      <h3>Custom Patterns</h3>
      <p class="pat-intro">Your own regexes — crypto wallets, SKUs, ticket IDs, anything. Matches are stored as <span class="cell-type type-custom">custom</span> contacts. Flags default to <code>g</code> (case-sensitive); add <code>i</code> to ignore case.</p>
      <div class="table-wrap" id="customTableWrap" ${hasCustoms ? "" : "hidden"}>
        <table class="pat-table">
          <thead><tr><th style="width:180px">Label</th><th>Regex</th><th style="width:70px">Flags</th><th style="width:40px"><span class="sr-only">Remove</span></th></tr></thead>
          <tbody id="customTableBody">${customRows}</tbody>
        </table>
      </div>
      <button type="button" class="btn-add" id="addCustomBtn">+ Add Custom Pattern</button>
    </div>

    <div class="settings-group">
      <h3>Filter Lists</h3>
      ${tagList("skipDomainsTags", "Skip Domains", "Pages on these domains are never scanned", P.skipDomains)}
      ${tagList("junkDomainsTags", "Junk Email Domains", "Emails from these domains are ignored", P.junkEmailDomains)}
      ${tagList("junkPrefixesTags", "Junk Email Prefixes", "Emails whose local part equals these are ignored", P.junkEmailPrefixes)}
      ${tagList("junkSocialTags", "Junk Social Paths", "Social URLs on these path segments are ignored", P.junkSocialPaths)}
    </div>

    <div class="settings-group">
      <h3>Data</h3>
      <div class="setting-row"><div class="setting-label">Contacts stored</div><span class="tone-accent mono-num">${num(stats.totalContacts)}</span></div>
      <div class="setting-row"><div class="setting-label">Scans recorded</div><span class="tone-blue mono-num">${num(stats.totalScans)}</span></div>
      <div class="setting-row">
        <div class="setting-label">Export all contacts</div>
        <button type="button" class="btn btn-accent btn-sm" id="settingsExportContacts">Export Contacts</button>
      </div>
      <div class="setting-row">
        <div class="setting-label">Export scan history</div>
        <button type="button" class="btn btn-accent btn-sm" id="settingsExportScans">Export Scans</button>
      </div>
    </div>

    <div class="settings-group danger">
      <h3>Danger Zone</h3>
      <div class="setting-row">
        <div class="setting-label">Reset patterns<small>Restore every regex and filter list to its default</small></div>
        <button type="button" class="btn btn-danger btn-sm" id="resetPatternsBtn">Reset Patterns</button>
      </div>
      <div class="setting-row">
        <div class="setting-label">Clear all data<small>Permanently delete all contacts and scan history</small></div>
        <button type="button" class="btn btn-danger btn-sm" id="clearAllBtn">Clear Everything</button>
      </div>
    </div>

    <p class="settings-footer">Prospekt v${esc(chrome.runtime.getManifest().version)} — free &amp; open source. All data stays on this device.</p>

    <div class="save-bar" id="patternSaveBar" role="region" aria-label="Unsaved changes">
      <span class="save-bar-text">You have unsaved pattern changes</span>
      <div class="save-bar-actions">
        <button type="button" class="btn btn-ghost btn-sm" id="discardPatternsBtn">Discard</button>
        <button type="button" class="btn btn-accent btn-sm" id="savePatternsBtn">Save changes</button>
      </div>
    </div>
  `;

  setDirty(false);
  wireSettings(el, settings);
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

const customRowHtml = (cp = {}) => `
  <tr>
    <td><input type="text" class="tbl-input custom-label" value="${esc(cp.label)}" placeholder="e.g. Crypto Wallets"></td>
    <td><input type="text" class="tbl-input custom-regex" value="${esc(cp.regex)}" placeholder="Regex pattern" spellcheck="false"></td>
    <td><input type="text" class="tbl-input custom-flags" value="${esc(cp.flags || "g")}" placeholder="g" spellcheck="false"></td>
    <td><button type="button" class="cell-btn del row-del" title="Remove" aria-label="Remove row">${IC.trash}</button></td>
  </tr>`;

function wireSettings(el, settings) {
  // Any edit anywhere in the pattern editor raises the save bar. v1 had a
  // single Save button buried in one group, so edits to the social table,
  // custom table and filter lists looked like they simply didn't stick.
  // #page-settings outlives each render, so this is attached exactly once.
  if (!el.dataset.dirtyWatch) {
    el.dataset.dirtyWatch = "1";
    el.addEventListener("input", e => {
      if (e.target.closest(".pat-row, .pat-table")) setDirty(true);
    });
  }

  const toggleSetting = async (btn, key, onDone) => {
    const on = !btn.classList.contains("on");
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-checked", String(on));
    const next = await bg({ action: "saveSettings", settings: { [key]: on } });
    if (next) prefs = next;
    onDone?.(on);
  };

  el.querySelector("#toggleAutoScan").addEventListener("click", function () {
    toggleSetting(this, "autoScan", on => {
      reflectAutoScan();
      toast(on ? "Auto-scan enabled" : "Auto-scan paused");
    });
  });

  el.querySelector("#remoteFaviconsToggle").addEventListener("click", function () {
    toggleSetting(this, "remoteFavicons", on => toast(on ? "Remote favicons on" : "Remote favicons off"));
  });

  el.querySelector("#saveLimitsBtn").addEventListener("click", async () => {
    const maxScans = parseInt(el.querySelector("#maxScansInput").value, 10);
    const maxContacts = parseInt(el.querySelector("#maxContactsInput").value, 10);
    if (!Number.isInteger(maxScans) || maxScans < 100 || maxScans > 50000) return toast("Max domains must be 100–50,000");
    if (!Number.isInteger(maxContacts) || maxContacts < 1000 || maxContacts > 200000) return toast("Max contacts must be 1,000–200,000");
    const next = await bg({ action: "saveSettings", settings: { maxScans, maxContacts } });
    if (next) prefs = next;
    toast("Storage limits saved");
  });

  el.querySelectorAll(".pat-test-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.test);
      const errorEl = document.getElementById(btn.dataset.test + "-error");
      const result = validateRegex(input.value, "g");
      errorEl.textContent = result.ok ? "✓ Valid regex" : "✗ " + result.error;
      errorEl.className = "pat-error " + (result.ok ? "is-ok" : "is-bad");
      clearTimeout(btn._t);
      btn._t = setTimeout(() => { errorEl.textContent = ""; errorEl.className = "pat-error"; }, 5000);
    });
  });

  el.querySelector("#addSocialBtn").addEventListener("click", () => {
    const tbody = el.querySelector("#socialTableBody");
    tbody.insertAdjacentHTML("beforeend", socialRowHtml());
    const row = tbody.lastElementChild;
    wireRowDelete(row);
    row.querySelector(".social-platform").focus();
    setDirty(true);
  });

  el.querySelector("#addCustomBtn").addEventListener("click", () => {
    el.querySelector("#customTableWrap").hidden = false;
    const tbody = el.querySelector("#customTableBody");
    tbody.insertAdjacentHTML("beforeend", customRowHtml());
    const row = tbody.lastElementChild;
    wireRowDelete(row);
    row.querySelector(".custom-label").focus();
    setDirty(true);
  });

  el.querySelectorAll("#socialTableBody tr, #customTableBody tr").forEach(wireRowDelete);

  el.querySelectorAll(".tag-input").forEach(input => {
    const commit = () => {
      const added = commitTagInput(input);
      if (added) setDirty(true);
    };
    input.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(); }
    });
    // Also commit on blur — typing a value and clicking Save used to discard it.
    input.addEventListener("blur", commit);
  });

  el.querySelectorAll(".tag-x").forEach(wireTagRemove);

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

  el.querySelector("#clearAllBtn").addEventListener("click", async () => {
    if (!confirm("Delete ALL contacts and scan history? This cannot be undone.")) return;
    await bg({ action: "clearAll" });
    toast("All data cleared");
    renderPage("settings");
  });
}

function wireRowDelete(row) {
  row.querySelector(".row-del")?.addEventListener("click", () => {
    const tbody = row.parentElement;
    row.remove();
    if (tbody?.id === "customTableBody" && !tbody.children.length) {
      document.getElementById("customTableWrap").hidden = true;
    }
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
function gatherPatterns() {
  const el = document.getElementById("page-settings");
  el.querySelectorAll(".is-invalid").forEach(n => n.classList.remove("is-invalid"));

  // Flush any tag text the user typed but never confirmed.
  el.querySelectorAll(".tag-input").forEach(commitTagInput);

  const emailInput = el.querySelector("#pat-email");
  const phoneInput = el.querySelector("#pat-phone");
  const emailRegex = emailInput.value.trim();
  const phoneRegex = phoneInput.value.trim();

  if (!emailRegex) return flagError("Email regex", emailInput, "cannot be empty");
  if (!phoneRegex) return flagError("Phone regex", phoneInput, "cannot be empty");

  let check = validateRegex(emailRegex, "gi");
  if (!check.ok) return flagError("Email regex", emailInput, check.error);
  check = validateRegex(phoneRegex, "g");
  if (!check.ok) return flagError("Phone regex", phoneInput, check.error);

  const socialPatterns = [];
  for (const [i, tr] of [...el.querySelectorAll("#socialTableBody tr")].entries()) {
    const platformEl = tr.querySelector(".social-platform");
    const labelEl = tr.querySelector(".social-label");
    const regexEl = tr.querySelector(".social-regex");
    const flagsEl = tr.querySelector(".social-flags");
    const platform = platformEl.value.trim();
    const label = labelEl.value.trim();
    const regex = regexEl.value.trim();
    const flags = flagsEl.value.trim() || "gi";

    if (!platform && !label && !regex) continue;      // untouched blank row
    if (!platform) return flagError(`Social row ${i + 1}`, platformEl, "needs a platform ID");
    if (!label) return flagError(`Social row ${i + 1}`, labelEl, "needs a label");
    if (!regex) return flagError(`Social row ${i + 1}`, regexEl, "needs a regex");
    const r = validateRegex(regex, flags);
    if (!r.ok) return flagError(`Social "${label}"`, regexEl, r.error);
    socialPatterns.push({ platform, label, regex, flags });
  }

  const customPatterns = [];
  for (const [i, tr] of [...el.querySelectorAll("#customTableBody tr")].entries()) {
    const labelEl = tr.querySelector(".custom-label");
    const regexEl = tr.querySelector(".custom-regex");
    const flagsEl = tr.querySelector(".custom-flags");
    const label = labelEl.value.trim();
    const regex = regexEl.value.trim();
    const flags = flagsEl.value.trim() || "g";

    if (!label && !regex) continue;
    if (!label) return flagError(`Custom row ${i + 1}`, labelEl, "needs a label");
    if (!regex) return flagError(`Custom row ${i + 1}`, regexEl, "needs a regex");
    const r = validateRegex(regex, flags);
    if (!r.ok) return flagError(`Custom "${label}"`, regexEl, r.error);
    customPatterns.push({ label, regex, flags });
  }

  const tags = id => [...el.querySelectorAll(`#${id} .tag`)].map(t => t.dataset.value).filter(Boolean);

  return {
    emailRegex,
    emailFlags: "gi",
    phoneRegex,
    phoneFlags: "g",
    socialPatterns,
    customPatterns,
    skipDomains: tags("skipDomainsTags"),
    junkEmailDomains: tags("junkDomainsTags"),
    junkEmailPrefixes: tags("junkPrefixesTags"),
    junkSocialPaths: tags("junkSocialTags"),
  };
}

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
