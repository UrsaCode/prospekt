// Prospekt — Popup
// A view onto the active tab's most recent scan. The background resolves the
// whole model into exactly one state, so nothing here has to infer it.

const send = msg => new Promise(resolve => {
  try {
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) return resolve(undefined);
      resolve(res);
    });
  } catch { resolve(undefined); }
});

const $ = id => document.getElementById(id);
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = v => v === null || v === undefined ? "" : String(v).replace(/[&<>"']/g, c => ESCAPES[c]);

const TYPES = [
  { key: "email", label: "EMAIL" },
  { key: "phone", label: "PHONE" },
  { key: "social", label: "SOCIAL" },
  { key: "custom", label: "CUSTOM" },
];

let model = null;
let filter = "all";

// ── Helpers ──────────────────────────────────────────────────────────────
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2200);
}

const ago = iso => {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + "M AGO";
  if (s < 86400) return Math.floor(s / 3600) + "H AGO";
  return Math.floor(s / 86400) + "D AGO";
};

function hueOf(domain) {
  let h = 7;
  for (const c of String(domain || "")) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

const show = (id, on) => $(id).classList.toggle("hidden", !on);

// ── Chrome-shaped sections ───────────────────────────────────────────────
function renderContext(page) {
  const domain = page.domain || "—";
  $("fav").textContent = (domain.charAt(0) || "?").toUpperCase();
  $("fav").style.setProperty("--h", hueOf(domain));
  $("ctxUrl").innerHTML = `<b>${esc(domain)}</b><span>${esc(page.path && page.path !== "/" ? page.path : "")}</span>`;
  $("ctxTitle").textContent = page.pageTitle || "";
}

function renderLive(on) {
  const btn = $("liveBtn");
  btn.classList.toggle("on", on);
  btn.classList.toggle("off", !on);
  $("liveLbl").textContent = on ? "LIVE" : "PAUSED";
  btn.title = on ? "Auto-scan is on — click to pause" : "Auto-scan is paused — click to resume";
}

function renderFooter(stats, skipped) {
  const s = stats || { contacts: 0, scans: 0 };
  $("footStats").innerHTML = s.contacts
    ? `<b>${s.contacts}</b> kept from this domain · <b>${s.scans}</b> scan${s.scans === 1 ? "" : "s"}`
    : `Nothing kept from this domain yet`;
  // The skipped state already offers "Stop skipping" as a primary button;
  // repeating it in the footer is just two controls doing one job.
  $("skipBtn").textContent = "Skip domain";
  $("skipBtn").classList.toggle("hidden", skipped);
}

function renderCount(result, busy) {
  show("countBlock", true);
  // A bare "0" while still scanning reads as "found nothing" before that is
  // known. Only show a number once there is one.
  const total = result?.total ?? 0;
  const unknown = busy && !result;
  $("countN").textContent = unknown ? "—" : total;
  $("countN").style.color = (!unknown && total) ? "var(--accent)" : "var(--muted)";

  if (busy) {
    $("countNew").textContent = "scanning";
    $("countNew").style.color = "var(--dim)";
  } else {
    $("countNew").textContent = result?.newCount ? `${result.newCount} new` : "nothing new";
    $("countNew").style.color = result?.newCount ? "var(--accent)" : "var(--muted)";
  }
  $("countSaved").textContent = result?.savedCount ? `${result.savedCount} already saved` : "";

  const bar = $("bar");
  bar.classList.toggle("busy", !!busy);
  bar.innerHTML = busy || !total ? "" : TYPES.map(t => {
    const n = result.counts?.[t.key + "s"] || 0;
    return n ? `<i style="flex:${n};background:var(--${t.key})"></i>` : "";
  }).join("");
}

function renderChips(result) {
  const counts = result?.counts || {};
  const present = TYPES.filter(t => (counts[t.key + "s"] || 0) > 0);
  if (!present.length) return show("chips", false);
  show("chips", true);
  $("chips").innerHTML = [
    `<button class="chip ${filter === "all" ? "on" : ""}" data-f="all">ALL <span class="n">${result.total}</span></button>`,
    ...present.map(t => `<button class="chip ${filter === t.key ? "on" : ""}" data-f="${t.key}">
        <span class="pip" style="background:var(--${t.key})"></span>${t.label}
        <span class="n">${counts[t.key + "s"]}</span></button>`),
  ].join("");
  $("chips").querySelectorAll(".chip").forEach(c => {
    c.addEventListener("click", () => { filter = c.dataset.f; render(); });
  });
}

function rowHtml(r) {
  // platform/label come from the user's own pattern config and source from ours,
  // but everything interpolated into markup gets escaped regardless.
  const kind = r.type === "social" ? (r.platform || "social")
    : r.type === "custom" ? (r.label || "custom")
    : r.type;
  const meta = [
    esc(kind),
    r.isNew ? `<span class="new">NEW</span>` : `SAVED${r.savedAt ? " " + esc(ago(r.savedAt)) : ""}`,
    r.source ? esc(r.source) : null,
  ].filter(Boolean).join(" · ");

  // Only ever one of four known literals — never interpolate a raw type.
  const type = TYPES.some(t => t.key === r.type) ? r.type : "email";

  return `<div class="row ${r.isNew ? "" : "is-saved"}">
    <span class="row-dot ${r.isNew ? "" : "saved"}" style="--type:var(--${type})"></span>
    <div class="row-body">
      <div class="row-val">${esc(r.value)}</div>
      <div class="row-meta">${meta}</div>
    </div>
  </div>`;
}

const SKELETON = Array.from({ length: 3 }, () => `
  <div class="row skel"><span class="row-dot"></span>
    <div class="row-body"><div class="row-val"></div><div class="row-meta"></div></div></div>`).join("");

function renderList(result, busy) {
  const list = $("list");
  show("list", true);
  list.classList.toggle("dimmed", !!busy);

  const rows = (result?.rows || []).filter(r => filter === "all" || r.type === filter);
  if (busy && !rows.length) { list.innerHTML = SKELETON; return; }
  if (!rows.length) {
    list.innerHTML = `<div style="padding:26px 14px;text-align:center;color:var(--muted);font-size:11.5px">Nothing of that type on this page.</div>`;
    return;
  }
  list.innerHTML = rows.map(rowHtml).join("");
}

function renderActions(result, busy) {
  show("actions", true);
  const newRows = (result?.rows || []).filter(r => r.isNew);
  $("copyLbl").textContent = newRows.length ? `Copy ${newRows.length} new` : "Copy all";
  $("copyBtn").disabled = busy || !(result?.rows || []).length;
  $("exportBtn").disabled = busy || !(result?.rows || []).length;
  $("refreshBtn").disabled = !!busy;
}

function stateBlock({ icon, title, body, actions }) {
  show("state", true);
  $("state").innerHTML = `
    <div class="state-icon">${icon}</div>
    <h2>${esc(title)}</h2>
    <p>${esc(body)}</p>
    <div class="state-actions">${actions || ""}</div>`;
}

const ICON_SEARCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`;
const ICON_BLOCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.9" y1="4.9" x2="19.1" y2="19.1"/></svg>`;

// ── Render ───────────────────────────────────────────────────────────────
function render() {
  if (!model) return;
  const { state, page, result, cached, domainStats, autoScan, version } = model;

  $("ver").textContent = version ? "v" + version : "";
  renderLive(autoScan);
  renderContext(page || {});
  renderFooter(domainStats, state === "skipped");

  ["countBlock", "chips", "list", "state", "actions"].forEach(id => show(id, false));

  if (state === "unsupported") {
    $("skipBtn").classList.add("hidden");
    $("footStats").textContent = "";
    stateBlock({
      icon: ICON_SEARCH,
      title: "Nothing to scan here",
      body: "Prospekt reads ordinary web pages. Open a site and it will start finding contacts.",
    });
    return;
  }

  if (state === "skipped") {
    stateBlock({
      icon: ICON_BLOCK,
      title: "This domain is on your skip list",
      body: "Nothing is read or stored here. Remove it from the list to start scanning again.",
      actions: `<button class="btn" id="onceBtn">Scan this page once</button>
                <button class="btn btn-primary" id="unskipBtn">Stop skipping</button>`,
    });
    $("onceBtn").addEventListener("click", async () => {
      await send({ action: "scanOnce", tabId: page.tabId });
      toast("Scanning this page once…");
    });
    $("unskipBtn").addEventListener("click", () => setSkipped(false));
    return;
  }

  if (state === "unreachable") {
    stateBlock({
      icon: ICON_SEARCH,
      title: "Can't read this page yet",
      body: "Prospekt isn't running on this tab — usually because it was open before the extension loaded. Reload the page and it will start scanning.",
      actions: `<button class="btn btn-primary" id="reloadBtn">Reload page</button>`,
    });
    $("reloadBtn").addEventListener("click", () => {
      if (model?.page?.tabId) chrome.tabs.reload(model.page.tabId);
      window.close();
    });
    return;
  }

  const busy = state === "scanning";
  const data = busy ? cached : result;

  if (busy) {
    $("ctxTitle").textContent = "Reading page…";
    renderCount(data, true);
    renderChips(data);
    renderList(data, true);
    renderActions(data, true);
    startWatchdog();
    return;
  }
  stopWatchdog();

  if (state === "empty") {
    renderCount(result, false);
    stateBlock({
      icon: ICON_SEARCH,
      title: "No contacts on this page",
      body: "Prospekt keeps watching while you scroll. Scan again after the page loads more.",
      actions: `<button class="btn" id="againBtn">Scan again</button>`,
    });
    $("againBtn").addEventListener("click", rescan);
    return;
  }

  renderCount(result, false);
  renderChips(result);
  renderList(result, false);
  renderActions(result, false);
}

// ── Scanning watchdog ────────────────────────────────────────────────────
// A scan that never reports back must not leave the popup spinning silently.
// The content script acknowledged the request, so this is a slow or stalled
// page rather than an unreachable one — offer a way forward instead of a lie.
const WATCHDOG_MS = 8000;
let watchdog = null;

function startWatchdog() {
  if (watchdog) return;
  watchdog = setTimeout(() => {
    watchdog = null;
    if (model?.state !== "scanning") return;
    stateBlock({
      icon: ICON_SEARCH,
      title: "This page is taking a while",
      body: "The scan hasn't come back yet. Heavy pages can take a moment — try again, or reload the page.",
      actions: `<button class="btn" id="wdRetry">Try again</button>
                <button class="btn btn-primary" id="wdReload">Reload page</button>`,
    });
    ["countBlock", "chips", "list", "actions"].forEach(id => show(id, false));
    $("wdRetry").addEventListener("click", () => { stopWatchdog(); load(); });
    $("wdReload").addEventListener("click", () => {
      if (model?.page?.tabId) chrome.tabs.reload(model.page.tabId);
      window.close();
    });
  }, WATCHDOG_MS);
}

function stopWatchdog() {
  clearTimeout(watchdog);
  watchdog = null;
}

// ── Actions ──────────────────────────────────────────────────────────────
async function load() {
  model = await send({ action: "getPageState" });
  if (!model) {
    stateBlock({ icon: ICON_SEARCH, title: "Couldn't reach Prospekt", body: "Reopen the popup to try again." });
    return;
  }
  render();
}

async function rescan() {
  if (!model?.page?.tabId) return;
  await send({ action: "rescanTab", tabId: model.page.tabId, bypass: true });
  await load();
}

async function setSkipped(skipped) {
  const domain = model?.page?.domain;
  if (!domain) return;
  await send({ action: skipped ? "skipDomain" : "unskipDomain", domain });
  toast(skipped ? `Skipping ${domain}` : `No longer skipping ${domain}`);
  await load();
}

document.addEventListener("DOMContentLoaded", () => {
  load();

  $("gearBtn").addEventListener("click", async () => {
    await send({ action: "openDashboard", hash: "settings" });
    window.close();
  });

  $("dashBtn").addEventListener("click", async () => {
    await send({ action: "openDashboard" });
    window.close();
  });

  $("liveBtn").addEventListener("click", async () => {
    const next = !(model?.autoScan);
    const res = await send({ action: "saveSettings", settings: { autoScan: next } });
    if (!res || res.ok === false) return toast("Couldn't change that");
    if (model) model.autoScan = next;
    renderLive(next);
    toast(next ? "Auto-scan resumed" : "Auto-scan paused");
  });

  $("skipBtn").addEventListener("click", () => setSkipped(model?.state !== "skipped"));
  $("refreshBtn").addEventListener("click", rescan);

  $("copyBtn").addEventListener("click", async () => {
    const rows = model?.result?.rows || [];
    const news = rows.filter(r => r.isNew);
    const pick = news.length ? news : rows;
    if (!pick.length) return;
    try {
      await navigator.clipboard.writeText(pick.map(r => r.value).join("\n"));
      toast(`Copied ${pick.length} ${news.length ? "new " : ""}contact${pick.length === 1 ? "" : "s"}`);
    } catch {
      toast("Clipboard blocked by the browser");
    }
  });

  $("exportBtn").addEventListener("click", async () => {
    const res = await send({ action: "exportPage", tabId: model?.page?.tabId });
    if (!res?.csv) return toast("Export failed");
    const blob = new Blob(["﻿" + res.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `prospekt-${(model?.page?.domain || "page").replace(/[^a-z0-9.-]/gi, "_")}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 20000);
    toast("Page contacts exported");
  });
});

// The background pushes this when a scan lands, so the popup never polls.
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.action === "pageStateChanged" && msg.tabId === model?.page?.tabId) load();
});
