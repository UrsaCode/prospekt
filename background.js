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
  next.socialPatterns = (next.socialPatterns || []).map(p => ({ flags: "gi", ...p }));
  next.customPatterns = (next.customPatterns || []).map(p => ({ flags: "gi", ...p }));
  next._v = PROSPEKT.PATTERNS_VERSION;
  return next;
}

// ── Message router ──────────────────────────────────────────────────────
const HANDLERS = {
  storeScan: (msg, sender) => serialize(() => storeScan(msg.data, sender?.tab)),
  clearBadge: (msg, sender) => clearBadge(sender?.tab),
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
  openDashboard: () => openDashboard(),
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
};

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

// Focus an already-open dashboard instead of stacking duplicate tabs.
async function openDashboard() {
  const url = chrome.runtime.getURL("dashboard.html");
  const existing = await chrome.tabs.query({ url });
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true }).catch(() => {});
  } else {
    await chrome.tabs.create({ url });
  }
  return { ok: true };
}

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
  if (settings.autoScan === false) return { ok: false, reason: "disabled" };

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

  const known = new Set(contacts.map(c => keyFor(c.type, c.value, c.label)));
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

  const add = (type, item, extra) => {
    const key = keyFor(type, item.value, item.label);
    if (known.has(key)) return;
    known.add(key);
    newContacts.push(mkContact(type, item.value, extra));
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
    // Almost always QUOTA_BYTES. Shed the oldest half and retry once so the
    // extension degrades instead of silently going read-only.
    console.warn("[Prospekt] storage write failed, trimming:", err.message);
    const trimmed = pruned.slice(0, Math.floor(pruned.length / 2));
    await set({ [SCANS]: scans, [CONTACTS]: trimmed });
  }

  await setBadge(tab, data.totalContacts);
  return { ok: true, isNew, newContacts: newContacts.length, scanId };
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
  if (filters.limit) scans = scans.slice(0, filters.limit);
  return scans;
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
