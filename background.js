// Prospekt — Background Service Worker (MV3)
// Storage owner, scan orchestration, badge, exports.

importScripts("defaults.js");

const { SCANS, CONTACTS, SETTINGS, PATTERNS } = PROSPEKT.STORAGE_KEYS;
const DEFAULT_SETTINGS = PROSPEKT.DEFAULT_SETTINGS;

// ── Storage helpers (surface errors instead of failing silently) ────────
const get = keys => new Promise((resolve, reject) => {
  chrome.storage.local.get(keys, d => {
    const err = chrome.runtime.lastError;
    err ? reject(new Error(err.message)) : resolve(d);
  });
});

const set = obj => new Promise((resolve, reject) => {
  chrome.storage.local.set(obj, () => {
    const err = chrome.runtime.lastError;
    err ? reject(new Error(err.message)) : resolve();
  });
});

// ── Per-tab page state (session storage) ────────────────────────────────
// Ephemeral by design: page-derived content never reaches disk. Survives a
// service-worker restart, which an in-memory Map would not.
const PAGE_PREFIX = "page_";
const PAGE_STALE_MS = 30000;
const PAGE_MAX_ROWS = 200;

const sessionGet = key => new Promise(resolve => {
  chrome.storage.session.get(key, d => { void chrome.runtime.lastError; resolve(d || {}); });
});
const sessionSet = obj => new Promise(resolve => {
  chrome.storage.session.set(obj, () => { void chrome.runtime.lastError; resolve(); });
});
const sessionRemove = key => new Promise(resolve => {
  chrome.storage.session.remove(key, () => { void chrome.runtime.lastError; resolve(); });
});

const pageKey = tabId => PAGE_PREFIX + tabId;

async function readPageState(tabId) {
  if (tabId === undefined || tabId === null) return null;
  const d = await sessionGet(pageKey(tabId));
  return d[pageKey(tabId)] || null;
}

/**
 * `silent` suppresses the popup nudge. Marking a tab as scanning MUST be
 * silent: the popup reloads on the broadcast, would read scanning:true as
 * stale, and fire another rescan — a feedback loop whose rescan messages also
 * cancel the pending scan timer, so the scan never actually runs.
 * Only a finished scan is worth waking the popup for.
 */
async function writePageState(tabId, state, { silent = false } = {}) {
  if (tabId === undefined || tabId === null) return;
  await sessionSet({ [pageKey(tabId)]: state });
  if (silent) return;
  try {
    chrome.runtime.sendMessage({ action: "pageStateChanged", tabId }, () => void chrome.runtime.lastError);
  } catch { /* no receiver */ }
}

chrome.tabs.onRemoved.addListener(tabId => { sessionRemove(pageKey(tabId)); });

function buildPageState(data, counts, rows, newCount) {
  return {
    url: data.meta.url,
    domain: data.meta.domain,
    path: data.meta.path || "",
    pageTitle: data.meta.pageTitle || null,
    siteName: data.meta.siteName || null,
    scannedAt: Date.now(),
    total: counts.total,
    counts,
    newCount,
    savedCount: Math.max(0, counts.total - newCount),
    rows: rows.slice(0, PAGE_MAX_ROWS),
    truncated: rows.length > PAGE_MAX_ROWS,
    scanning: false,
  };
}

// Marks a tab as mid-scan so the popup can render the scanning state without
// guessing. Preserves the previous rows so a refresh doesn't blank the list.
async function markScanning(tabId) {
  const prev = await readPageState(tabId);
  await writePageState(tabId, { ...(prev || {}), scanning: true, scanStartedAt: Date.now() }, { silent: true });
}

// Every read-modify-write on storage runs through this queue. Without it two
// tabs finishing a scan at the same time both read the old array and the second
// write silently discards the first one's contacts.
let writeQueue = Promise.resolve();
function serialize(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

async function getSettings() {
  const d = await get(SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(d[SETTINGS] || {}) };
}

// ── Install / upgrade ───────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(details => {
  serialize(async () => {
    const d = await get([SCANS, CONTACTS, SETTINGS, PATTERNS]);
    const patch = {};
    if (!Array.isArray(d[SCANS])) patch[SCANS] = [];
    if (!Array.isArray(d[CONTACTS])) patch[CONTACTS] = [];
    patch[SETTINGS] = { ...DEFAULT_SETTINGS, ...(d[SETTINGS] || {}) };

    const migrated = migratePatterns(d[PATTERNS], details.reason);
    if (migrated) patch[PATTERNS] = migrated;

    await set(patch);
  }).catch(err => console.error("[Prospekt] init failed:", err));
});

/**
 * Hand existing users improved defaults without clobbering their edits: a field
 * is only replaced if it still holds a value shipped by an older version.
 */
function migratePatterns(stored, reason) {
  if (!stored || typeof stored !== "object") return null;
  if ((stored._v || 1) >= PROSPEKT.PATTERNS_VERSION) return null;
  if (reason !== "update" && reason !== "install") return null;

  const next = { ...stored };
  for (const [field, legacyValues] of Object.entries(PROSPEKT.LEGACY_DEFAULTS)) {
    if (legacyValues.includes(next[field])) next[field] = PROSPEKT.DEFAULTS[field];
  }
  // v1 had no per-pattern flags; keep old behaviour explicit rather than
  // silently changing how a user's saved patterns match.
  // Only touch keys that are actually present: resolvePatterns treats "absent"
  // as "use defaults" but "[]" as "the user emptied this on purpose", so
  // defaulting a missing key to [] here would permanently disable extraction.
  for (const key of ["socialPatterns", "customPatterns"]) {
    if (!Array.isArray(next[key])) continue;
    next[key] = next[key].map(p => ({ flags: "gi", ...p }));
  }
  next._v = PROSPEKT.PATTERNS_VERSION;
  return next;
}

// ── Message router ──────────────────────────────────────────────────────
const HANDLERS = {
  storeScan: (msg, sender) => serialize(() => storeScan(msg.data, sender?.tab)),
  getScans: msg => getScans(msg.filters),
  getContacts: msg => getContacts(msg.filters),
  getStats: () => getStats(),
  deleteScan: msg => serialize(() => deleteScan(msg.scanId)),
  deleteContact: msg => serialize(() => deleteContact(msg.contactId)),
  clearAll: () => serialize(() => set({ [SCANS]: [], [CONTACTS]: [] })),
  exportCSV: msg => exportCSV(msg.type).then(csv => ({ csv })),
  getSettings: () => getSettings(),
  saveSettings: msg => serialize(async () => {
    // Merge, don't replace — a stale copy in one dashboard tab used to wipe
    // settings changed elsewhere.
    const current = await getSettings();
    const next = { ...current, ...(msg.settings || {}) };
    await set({ [SETTINGS]: next });
    return next;
  }),
  openDashboard: msg => openDashboard(msg.hash),
  getPatterns: () => get(PATTERNS).then(d => d[PATTERNS] || null),
  savePatterns: msg => serialize(async () => {
    const patterns = { ...(msg.patterns || {}), _v: PROSPEKT.PATTERNS_VERSION };
    await set({ [PATTERNS]: patterns });
    return { ok: true, patterns };
  }),
  resetPatterns: () => serialize(async () => {
    await new Promise((resolve, reject) => chrome.storage.local.remove(PATTERNS, () => {
      const err = chrome.runtime.lastError;
      err ? reject(new Error(err.message)) : resolve();
    }));
    return { ok: true };
  }),
  rescanTabs: () => rescanTabs(),
  getPageState: () => getPageState(),
  rescanTab: msg => rescanTab(msg.tabId, { force: true, bypass: !!msg.bypass }),
  scanOnce: msg => rescanTab(msg.tabId, { force: true, bypass: true, bypassSkip: true }),
  skipDomain: msg => serialize(() => setDomainSkipped(msg.domain, true)),
  unskipDomain: msg => serialize(() => setDomainSkipped(msg.domain, false)),
  exportPage: msg => exportPage(msg.tabId).then(csv => ({ csv })),
};

// ── Popup model ─────────────────────────────────────────────────────────
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function rescanTab(tabId, opts = {}) {
  if (tabId === undefined || tabId === null) return { ok: false, reason: "no_tab" };
  await markScanning(tabId);
  return new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(tabId, { action: "rescan", ...opts }, res => {
        const err = chrome.runtime.lastError;
        resolve({ ok: !err && res?.ok !== false, reason: err?.message });
      });
    } catch (e) {
      resolve({ ok: false, reason: String(e?.message || e) });
    }
  });
}

async function setDomainSkipped(domain, skipped) {
  const clean = String(domain || "").toLowerCase().replace(/^www\./, "").trim();
  if (!clean) return { ok: false, reason: "no_domain" };
  const d = await get(PATTERNS);
  const patterns = PROSPEKT.resolvePatterns(d[PATTERNS]);
  const list = (patterns.skipDomains || []).filter(x => String(x).toLowerCase() !== clean);
  if (skipped) list.push(clean);
  patterns.skipDomains = list;
  patterns._v = PROSPEKT.PATTERNS_VERSION;
  await set({ [PATTERNS]: patterns });
  return { ok: true, skipped, domain: clean };
}

/**
 * The entire popup model, resolved to exactly one state so the popup itself
 * holds no branching logic. Order matters: skipped beats everything, scanning
 * beats cached content.
 */
async function getPageState() {
  const tab = await activeTab();
  const settings = await getSettings();
  const version = chrome.runtime.getManifest().version;
  const base = { autoScan: settings.autoScan !== false, version };

  if (!tab || !/^https?:/i.test(tab.url || "")) {
    return { ...base, state: "unsupported", page: { url: tab?.url || "", domain: "", pageTitle: tab?.title || null } };
  }

  const domain = (() => {
    try { return new URL(tab.url).hostname.replace(/^www\./, ""); } catch { return ""; }
  })();
  const path = (() => {
    try { return new URL(tab.url).pathname; } catch { return ""; }
  })();

  const page = { url: tab.url, domain, path, pageTitle: tab.title || null, tabId: tab.id };

  const pd = await get(PATTERNS);
  const patterns = PROSPEKT.resolvePatterns(pd[PATTERNS]);
  if (PROSPEKT.isSkipped(tab.url, patterns.skipDomains)) {
    return { ...base, state: "skipped", page, domainStats: await domainStats(domain) };
  }

  const cached = await readPageState(tab.id);
  const stale = !cached
    || cached.scanning
    || cached.url !== tab.url
    || (Date.now() - (cached.scannedAt || 0)) > PAGE_STALE_MS;

  if (stale) {
    // Await delivery (an ack, not the scan itself). If the content script isn't
    // reachable — orphaned by an extension reload, or never injected — the popup
    // would otherwise sit on "scanning" forever with no way out.
    const delivery = await rescanTab(tab.id, { force: true });
    const stats = await domainStats(domain);
    if (!delivery.ok) {
      return { ...base, state: "unreachable", page, domainStats: stats, reason: delivery.reason || null };
    }
    return {
      ...base,
      state: "scanning",
      page,
      cached: cached && cached.url === tab.url ? cached : null,
      domainStats: stats,
    };
  }

  return {
    ...base,
    state: cached.total > 0 ? "results" : "empty",
    page: { ...page, pageTitle: cached.pageTitle || page.pageTitle },
    result: cached,
    domainStats: await domainStats(domain),
  };
}

async function domainStats(domain) {
  if (!domain) return { contacts: 0, scans: 0 };
  const d = await get([SCANS, CONTACTS]);
  const contacts = (d[CONTACTS] || []).filter(c => c.found_at?.domain === domain).length;
  const record = (d[SCANS] || []).find(s => s.found_at?.domain === domain);
  return { contacts, scans: record?.scan_count || 0 };
}

async function exportPage(tabId) {
  const cached = await readPageState(tabId);
  const rows = cached?.rows || [];
  let csv = csvRow(["Type", "Value", "Label", "Platform", "Source", "Status", "Domain", "Page URL"]);
  for (const r of rows) {
    csv += csvRow([r.type, r.value, r.label, r.platform, r.source,
      r.isNew ? "new" : "already saved", cached?.domain, cached?.url]);
  }
  return csv;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = HANDLERS[msg?.action];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(result => sendResponse(result === undefined ? { ok: true } : result))
    .catch(err => {
      console.error("[Prospekt]", msg.action, err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    });
  return true;   // async response
});

// Focus an already-open dashboard instead of stacking duplicate tabs. An
// optional hash routes it to a page (or triggers an export) on arrival.
async function openDashboard(hash = "") {
  const base = chrome.runtime.getURL("dashboard.html");
  const url = hash ? `${base}#${hash}` : base;
  const existing = await chrome.tabs.query({ url: base });
  if (existing.length) {
    // Re-navigating an already-open tab won't fire a load for a hash-only
    // change, so nudge it explicitly.
    await chrome.tabs.update(existing[0].id, { active: true, url });
    await chrome.windows.update(existing[0].windowId, { focused: true }).catch(() => {});
    if (hash) {
      chrome.tabs.sendMessage(existing[0].id, { action: "dashboardRoute", hash }, () => void chrome.runtime.lastError);
    }
  } else {
    await chrome.tabs.create({ url });
  }
  return { ok: true };
}

// ── Action context menu (right-click the toolbar icon) ──────────────────
const MENU = {
  open: "prospekt_open",
  scan: "prospekt_scan",
  pause: "prospekt_pause",
  settings: "prospekt_settings",
  export: "prospekt_export",
};

async function buildMenus() {
  const settings = await getSettings();
  await new Promise(resolve => chrome.contextMenus.removeAll(resolve));

  const add = props => chrome.contextMenus.create({ contexts: ["action"], ...props },
    () => void chrome.runtime.lastError);

  add({ id: MENU.open, title: "Open dashboard" });
  add({ id: MENU.scan, title: "Scan this page now" });
  add({ id: "sep1", type: "separator" });
  add({ id: MENU.pause, title: "Auto-scan", type: "checkbox", checked: settings.autoScan !== false });
  add({ id: "sep2", type: "separator" });
  add({ id: MENU.settings, title: "Settings…" });
  add({ id: MENU.export, title: "Export contacts (CSV)" });
}

chrome.runtime.onInstalled.addListener(() => { buildMenus().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { buildMenus().catch(() => {}); });

chrome.contextMenus.onClicked.addListener((info, tab) => {
  switch (info.menuItemId) {
    case MENU.open:
      openDashboard();
      break;
    case MENU.settings:
      openDashboard("settings");
      break;
    case MENU.export:
      openDashboard("export-contacts");
      break;
    case MENU.scan:
      if (tab?.id) {
        // Forced: the user asked explicitly, so re-scan even if the URL is unchanged.
        chrome.tabs.sendMessage(tab.id, { action: "rescan", force: true }, () => void chrome.runtime.lastError);
      }
      break;
    case MENU.pause:
      serialize(async () => {
        const current = await getSettings();
        await set({ [SETTINGS]: { ...current, autoScan: info.checked } });
      }).catch(() => {});
      break;
  }
});

// Keep the checkbox honest when auto-scan is toggled from the dashboard or popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[SETTINGS]) return;
  const next = changes[SETTINGS].newValue || {};
  const prev = changes[SETTINGS].oldValue || {};
  if (next.autoScan === prev.autoScan) return;
  chrome.contextMenus.update(MENU.pause, { checked: next.autoScan !== false },
    () => void chrome.runtime.lastError);
});

// Ask every content script to re-run with the current patterns.
async function rescanTabs() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  let notified = 0;
  await Promise.all(tabs.map(t => new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(t.id, { action: "rescan" }, () => {
        if (!chrome.runtime.lastError) notified++;
        resolve();
      });
    } catch { resolve(); }
  })));
  return { ok: true, notified };
}

// ── Same-document navigation ────────────────────────────────────────────
// The content script runs once at document_idle. On single-page apps —
// LinkedIn, X, GitHub, exactly what this targets — every later route change is
// a same-document navigation that never re-triggers it, so only the first page
// a user landed on was ever scanned. A content script can't hook the page's own
// history.pushState (isolated world), so the tab event is the reliable signal.
const navTimers = new Map();

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url || !/^https?:/i.test(changeInfo.url)) return;
  clearTimeout(navTimers.get(tabId));
  navTimers.set(tabId, setTimeout(() => {
    navTimers.delete(tabId);
    try {
      chrome.tabs.sendMessage(tabId, { action: "rescan" }, () => void chrome.runtime.lastError);
    } catch { /* tab closed or no content script */ }
  }, 1500));
});

chrome.tabs.onRemoved.addListener(tabId => {
  clearTimeout(navTimers.get(tabId));
  navTimers.delete(tabId);
});

// ── Badge ───────────────────────────────────────────────────────────────
function setBadge(tab, count) {
  if (!tab?.id) return Promise.resolve();
  return Promise.all([
    chrome.action.setBadgeText({ text: count ? String(count) : "", tabId: tab.id }),
    chrome.action.setBadgeBackgroundColor({ color: "#10b981", tabId: tab.id }),
  ]).catch(() => {});
}

function clearBadge(tab) {
  return setBadge(tab, 0).then(() => ({ ok: true }));
}

// ── Store scan (one record per domain — upsert) ─────────────────────────
async function storeScan(data, tab) {
  if (!data?.meta?.domain) return { ok: false, reason: "bad_payload" };

  const settings = await getSettings();
  // `bypass` marks a scan the user asked for explicitly (Scan this page once /
  // Scan again), which must work even with auto-scan paused.
  if (settings.autoScan === false && !data.bypass) return { ok: false, reason: "disabled" };

  const d = await get([SCANS, CONTACTS]);
  const scans = Array.isArray(d[SCANS]) ? d[SCANS] : [];
  const contacts = Array.isArray(d[CONTACTS]) ? d[CONTACTS] : [];

  const now = new Date().toISOString();
  const domain = data.meta.domain;
  const customs = data.customs || [];

  const counts = {
    emails: data.emails.length,
    phones: data.phones.length,
    socials: data.socials.length,
    customs: customs.length,
    total: data.totalContacts,
  };

  // A page that yielded nothing still updates the popup's view of this tab — it
  // just never enters the library. Without this the background cannot tell
  // "scanned, found nothing" from "never scanned", and the empty state would be
  // a guess rather than a fact.
  if (data.totalContacts === 0) {
    await writePageState(tab?.id, buildPageState(data, counts, [], 0));
    await setBadge(tab, 0);
    return { ok: true, empty: true, newContacts: 0 };
  }

  const existingIdx = scans.findIndex(s => s?.found_at?.domain === domain);
  let scanId;
  let isNew = false;

  if (existingIdx !== -1) {
    const existing = scans[existingIdx];
    scanId = existing.id;
    existing.last_scanned_at = now;
    existing.scan_count = (existing.scan_count || 1) + 1;
    existing.found_at.url = data.meta.url;
    existing.found_at.path = data.meta.path;
    existing.found_at.pageTitle = data.meta.pageTitle;
    existing.found_at.siteName = data.meta.siteName || existing.found_at.siteName;
    existing.found_at.favicon = data.meta.favicon || existing.found_at.favicon;
    existing.emailPattern = data.emailPattern || existing.emailPattern;
    existing.counts = counts;
    scans.splice(existingIdx, 1);
    scans.unshift(existing);
  } else {
    scanId = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    isNew = true;
    scans.unshift({
      id: scanId,
      added_at: now,
      last_scanned_at: now,
      scan_count: 1,
      found_at: {
        url: data.meta.url,
        domain,
        path: data.meta.path,
        pageTitle: data.meta.pageTitle,
        siteName: data.meta.siteName,
        favicon: data.meta.favicon,
      },
      emailPattern: data.emailPattern,
      counts,
    });
  }

  const maxScans = clampInt(settings.maxScans, 100, 50000, DEFAULT_SETTINGS.maxScans);
  let dropped = [];
  if (scans.length > maxScans) dropped = scans.splice(maxScans);

  // Deduplicate globally. Emails/socials by lowercased value, phones by digits,
  // custom values scoped to their label so two patterns can both keep a match.
  const keyFor = (type, value, label) => {
    if (type === "phone") return "phone:" + String(value).replace(/\D/g, "");
    if (type === "custom") return `custom:${label || ""}:` + String(value).toLowerCase();
    return `${type}:` + String(value).toLowerCase();
  };

  // Map rather than Set: already-saved rows show when they were first seen.
  const byKey = new Map();
  for (const c of contacts) {
    const k = keyFor(c.type, c.value, c.label);
    if (!byKey.has(k)) byKey.set(k, c);
  }
  const known = new Set(byKey.keys());
  const pageRows = [];
  const newContacts = [];
  let seq = 0;
  const mkContact = (type, value, extra) => ({
    id: `c_${Date.now()}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    type,
    value,
    ...extra,
    added_at: now,
    found_at: {
      url: data.meta.url,
      domain,
      pageTitle: data.meta.pageTitle,
      siteName: data.meta.siteName,
      favicon: data.meta.favicon,
    },
    scanId,
  });

  // Every hit becomes a row for the popup; only novel ones enter the library.
  // The new/saved split is a byproduct of this pass, not a second one.
  const add = (type, item, extra) => {
    const key = keyFor(type, item.value, item.label);
    const isNew = !known.has(key);
    if (isNew) {
      known.add(key);
      newContacts.push(mkContact(type, item.value, extra));
    }
    pageRows.push({
      type,
      value: item.value,
      label: item.label || extra.label || null,
      platform: item.platform || extra.platform || null,
      source: item.source || extra.source || null,
      isNew,
      savedAt: isNew ? null : (byKey.get(key)?.added_at || null),
    });
  };

  data.emails.forEach(e => add("email", e, { source: e.source, context: e.context }));
  data.phones.forEach(p => add("phone", p, { source: p.source, context: p.context }));
  data.socials.forEach(s => add("social", s, { platform: s.platform, label: s.label, source: "link" }));
  customs.forEach(c => add("custom", c, { label: c.label, source: c.source || "custom_regex" }));

  contacts.unshift(...newContacts);

  // Cap contacts too. v1 capped scans but let contacts grow without limit until
  // chrome.storage.local hit its quota and every write started failing.
  const maxContacts = clampInt(settings.maxContacts, 1000, 200000, DEFAULT_SETTINGS.maxContacts);
  if (contacts.length > maxContacts) contacts.length = maxContacts;

  // Drop contacts belonging to scans evicted by the cap.
  let pruned = contacts;
  if (dropped.length) {
    const goneIds = new Set(dropped.map(s => s.id));
    pruned = contacts.filter(c => !goneIds.has(c.scanId));
  }

  try {
    await set({ [SCANS]: scans, [CONTACTS]: pruned });
  } catch (err) {
    // Almost always QUOTA_BYTES. Shed the oldest half of BOTH tables and retry
    // so the extension degrades instead of silently going read-only. Trimming
    // only contacts left an oversized scans array able to fail the retry too.
    console.warn("[Prospekt] storage write failed, trimming:", err.message);
    const keptContacts = pruned.slice(0, Math.floor(pruned.length / 2));
    const keptScans = scans.slice(0, Math.max(1, Math.floor(scans.length / 2)));
    await set({ [SCANS]: keptScans, [CONTACTS]: keptContacts });
    // Surface it: silently halving someone's library with only a console.warn
    // looks like data loss with no cause.
    await recordStorageWarning({
      at: now,
      reason: err.message,
      droppedContacts: pruned.length - keptContacts.length,
      droppedScans: scans.length - keptScans.length,
    });
  }

  await writePageState(tab?.id, buildPageState(data, counts, pageRows, newContacts.length));
  await setBadge(tab, data.totalContacts);
  return { ok: true, isNew, newContacts: newContacts.length, scanId };
}

// Stored on settings so the dashboard can show a banner. Best-effort: if even
// this write fails there is nothing further to do.
async function recordStorageWarning(warning) {
  try {
    const current = await getSettings();
    await set({ [SETTINGS]: { ...current, storageWarning: warning } });
  } catch (err) {
    console.warn("[Prospekt] could not record storage warning:", err.message);
  }
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ── Queries ─────────────────────────────────────────────────────────────
async function getScans(filters = {}) {
  const d = await get(SCANS);
  let scans = Array.isArray(d[SCANS]) ? d[SCANS] : [];
  if (filters.domain) scans = scans.filter(s => s.found_at?.domain === filters.domain);
  if (filters.search) {
    const q = String(filters.search).toLowerCase();
    scans = scans.filter(s =>
      (s.found_at?.domain || "").toLowerCase().includes(q) ||
      (s.found_at?.pageTitle || "").toLowerCase().includes(q) ||
      (s.found_at?.siteName || "").toLowerCase().includes(q) ||
      (s.found_at?.url || "").toLowerCase().includes(q));
  }
  // Page here for the same reason getContacts does: shipping up to maxScans
  // records with full metadata across the message channel to render 30 rows
  // is pure waste.
  const total = scans.length;
  if (filters.limit) {
    const offset = Math.max(0, filters.offset || 0);
    scans = scans.slice(offset, offset + filters.limit);
  }
  return { items: scans, total };
}

async function getContacts(filters = {}) {
  const d = await get(CONTACTS);
  let contacts = Array.isArray(d[CONTACTS]) ? d[CONTACTS] : [];
  if (filters.type) contacts = contacts.filter(c => c.type === filters.type);
  if (filters.domain) contacts = contacts.filter(c => c.found_at?.domain === filters.domain);
  if (filters.search) {
    const q = String(filters.search).toLowerCase();
    contacts = contacts.filter(c =>
      (c.value || "").toLowerCase().includes(q) ||
      (c.found_at?.domain || "").toLowerCase().includes(q) ||
      (c.found_at?.siteName || "").toLowerCase().includes(q) ||
      (c.found_at?.pageTitle || "").toLowerCase().includes(q) ||
      (c.platform || "").toLowerCase().includes(q) ||
      (c.label || "").toLowerCase().includes(q));
  }
  const total = contacts.length;
  if (filters.limit) {
    const offset = Math.max(0, filters.offset || 0);
    contacts = contacts.slice(offset, offset + filters.limit);
  }
  // Always the same shape. Paging happens here so the dashboard never has to
  // ship the whole contact list across the message channel to render 30 rows.
  return { items: contacts, total };
}

async function getStats() {
  const d = await get([SCANS, CONTACTS]);
  const scans = Array.isArray(d[SCANS]) ? d[SCANS] : [];
  const contacts = Array.isArray(d[CONTACTS]) ? d[CONTACTS] : [];

  const byType = { email: 0, phone: 0, social: 0, custom: 0 };
  const domainCounts = {};
  const platformCounts = {};
  const customLabelCounts = {};

  for (const c of contacts) {
    if (byType[c.type] === undefined) byType[c.type] = 0;
    byType[c.type]++;

    const dom = c.found_at?.domain || "unknown";
    domainCounts[dom] = (domainCounts[dom] || 0) + 1;

    if (c.type === "social") {
      const p = c.platform || "other";
      platformCounts[p] = (platformCounts[p] || 0) + 1;
    } else if (c.type === "custom") {
      const l = c.label || "Unlabelled";
      customLabelCounts[l] = (customLabelCounts[l] || 0) + 1;
    }
  }

  const topDomains = Object.entries(domainCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([domain, count]) => ({ domain, count }));

  // Local-day buckets. Keying off toISOString() shifted every scan into the
  // wrong bucket for anyone west of UTC.
  const daily = {};
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    daily[localDayKey(day)] = 0;
  }
  for (const s of scans) {
    const stamp = s.last_scanned_at || s.added_at;
    if (!stamp) continue;
    const key = localDayKey(new Date(stamp));
    if (key in daily) daily[key]++;
  }

  return {
    totalScans: scans.reduce((sum, s) => sum + (s.scan_count || 1), 0),
    totalDomains: new Set(scans.map(s => s.found_at?.domain)).size,
    totalContacts: contacts.length,
    emails: byType.email,
    phones: byType.phone,
    socials: byType.social,
    customs: byType.custom,
    topDomains,
    platformCounts,
    customLabelCounts,
    dailyScans: Object.entries(daily).map(([date, count]) => ({ date, count })),
  };
}

function localDayKey(date) {
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ── Delete ──────────────────────────────────────────────────────────────
async function deleteScan(scanId) {
  const d = await get([SCANS, CONTACTS]);
  const scans = (d[SCANS] || []).filter(s => s.id !== scanId);
  const contacts = (d[CONTACTS] || []).filter(c => c.scanId !== scanId);
  await set({ [SCANS]: scans, [CONTACTS]: contacts });
  return { ok: true };
}

async function deleteContact(contactId) {
  const d = await get(CONTACTS);
  const contacts = (d[CONTACTS] || []).filter(c => c.id !== contactId);
  await set({ [CONTACTS]: contacts });
  return { ok: true };
}

// ── Export ──────────────────────────────────────────────────────────────
/**
 * RFC 4180 quoting plus a spreadsheet formula-injection guard. v1 wrapped
 * values in quotes without doubling embedded quotes, so a single " anywhere in
 * a page title or URL corrupted every following column.
 */
function csvCell(value) {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

const csvRow = cells => cells.map(csvCell).join(",") + "\r\n";

async function exportCSV(type = "contacts") {
  const key = type === "scans" ? SCANS : CONTACTS;
  const d = await get(key);
  const rows = Array.isArray(d[key]) ? d[key] : [];

  if (type === "scans") {
    let csv = csvRow(["Domain", "Site Name", "Emails", "Phones", "Socials", "Custom", "Total", "Scan Count", "First Seen", "Last Scanned", "URL"]);
    for (const s of rows) {
      csv += csvRow([
        s.found_at?.domain, s.found_at?.siteName,
        s.counts?.emails ?? 0, s.counts?.phones ?? 0, s.counts?.socials ?? 0,
        s.counts?.customs ?? 0, s.counts?.total ?? 0,
        s.scan_count || 1, s.added_at, s.last_scanned_at || s.added_at, s.found_at?.url,
      ]);
    }
    return csv;
  }

  let csv = csvRow(["Type", "Value", "Label", "Platform", "Source", "Context", "Domain", "Site Name", "Page Title", "Page URL", "Added At"]);
  for (const c of rows) {
    csv += csvRow([
      c.type, c.value, c.label, c.platform, c.source, c.context,
      c.found_at?.domain, c.found_at?.siteName, c.found_at?.pageTitle, c.found_at?.url, c.added_at,
    ]);
  }
  return csv;
}
