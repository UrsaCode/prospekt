// Minimal chrome.* shim so the dashboard can be opened in an ordinary browser
// tab during development. Injected by tools/preview.js — never shipped.
//
// Messages are routed through background.js's real onMessage handler, so this
// exercises the true dashboard <-> worker integration rather than a mock of it.
(() => {
  const store = Object.create(null);
  const session = Object.create(null);
  // In the packaged extension background.js (worker) and dashboard.js (page)
  // are separate contexts. Here they share one page, so keep every listener.
  const messageHandlers = [];
  const storageListeners = [];

  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const EXT = "chrome-extension://preview/";

  globalThis.importScripts = () => {};   // defaults.js is loaded via <script>

  globalThis.chrome = {
    runtime: {
      lastError: null,
      id: "preview",
      getManifest: () => ({ version: globalThis.__PROSPEKT_VERSION || "dev" }),
      getURL: p => EXT + p,
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: fn => messageHandlers.push(fn) },
      sendMessage(msg, cb) {
        setTimeout(() => {
          let replied = false;
          const sendResponse = res => { if (!replied) { replied = true; cb && cb(clone(res)); } };
          // The router identifies extension pages by sender URL.
          const sender = { id: "preview", url: EXT + "dashboard.html", tab: { id: 1 } };
          const kept = messageHandlers.map(fn => fn(clone(msg), sender, sendResponse)).some(Boolean);
          if (!kept) sendResponse(undefined);
        }, 0);
      },
    },
    storage: {
      local: {
        get(keys, cb) {
          const list = keys === null ? Object.keys(store) : (Array.isArray(keys) ? keys : [keys]);
          const out = {};
          for (const k of list) if (k in store) out[k] = clone(store[k]);
          setTimeout(() => cb(out), 0);
        },
        set(obj, cb) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: clone(store[k]), newValue: clone(v) };
            store[k] = clone(v);
          }
          setTimeout(() => { cb && cb(); storageListeners.forEach(f => f(changes, "local")); }, 0);
        },
        remove(key, cb) { delete store[key]; setTimeout(() => cb && cb(), 0); },
      },
      onChanged: { addListener: fn => storageListeners.push(fn) },
      session: {
        get: (k, cb) => setTimeout(() => cb({}), 0),
        set: (o, cb) => setTimeout(() => cb && cb(), 0),
        remove: (k, cb) => setTimeout(() => cb && cb(), 0),
      },
    },
    action: { setBadgeText: () => Promise.resolve(), setBadgeBackgroundColor: () => Promise.resolve() },
    contextMenus: {
      removeAll: cb => cb && cb(),
      create: () => {}, update: () => {},
      onClicked: { addListener: () => {} },
    },
    tabs: {
      query: () => Promise.resolve(globalThis.__previewTabs || []),
      create: t => { (globalThis.__previewOpened ||= []).push(t); return Promise.resolve({ id: 99 }); },
      update: () => Promise.resolve({}),
      reload: () => {},
      sendMessage: () => {},
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    windows: { update: () => Promise.resolve({}) },
  };

  // ── Sample library ────────────────────────────────────────────────────
  const now = Date.now();
  const iso = hoursAgo => new Date(now - hoursAgo * 3600e3).toISOString();
  const DOMAINS = ["ursacode.com", "regexhunter.com", "northbeamlabs.com", "stripe.com"];

  const contacts = [];
  let n = 0;
  const add = (type, value, extra, hours) => contacts.push({
    id: "c_" + (n++), type, value, added_at: iso(hours), last_seen_at: iso(hours),
    pageCount: 1 + (n % 4), pages: [], scanId: "scan_" + (n % DOMAINS.length),
    found_at: {
      url: `https://${DOMAINS[n % DOMAINS.length]}/team`,
      domain: DOMAINS[n % DOMAINS.length],
      pageTitle: "Our team", siteName: "Sample", favicon: null,
    },
    ...extra,
  });

  add("email", "dana.okonkwo@ursacode.com", { source: "mailto" }, 0.2);
  add("social", "https://linkedin.com/in/dana-okonkwo", { platform: "linkedin", source: "link" }, 0.2);
  add("phone", "+1 (415) 555-0184", { source: "tel" }, 0.3);
  add("email", "press@ursacode.com", { source: "text" }, 2);
  add("custom", "SKU-4471-XB", { label: "Product SKUs", source: "custom_regex" }, 2);
  add("email", "hello@regexhunter.com", { source: "mailto" }, 5);
  add("social", "https://github.com/regexhunter", { platform: "github", source: "link" }, 5);
  add("email", "info@northbeamlabs.com", { source: "text" }, 26);
  for (let i = 0; i < 34; i++) add("email", `person${i}@${DOMAINS[i % DOMAINS.length]}`, { source: "text" }, 30 + i * 6);

  store.prospekt_contacts = contacts;
  store.prospekt_scans = DOMAINS.map((domain, i) => ({
    id: "scan_" + i, added_at: iso(600 - i * 40), last_scanned_at: iso(i),
    scan_count: 8 + i * 3, pagesScanned: 12 + i * 9, pagesProductive: 4 + i * 2,
    pageHashes: Array.from({ length: 12 + i * 9 }, (_, k) => "h" + i + "_" + k),
    topPages: [
      { h: "a", t: "Our team", n: 6 - i },
      { h: "b", t: "Contact sales", n: 4 },
      { h: "c", t: "About", n: 2 },
    ],
    found_at: { url: `https://${domain}/team`, domain, path: "/team",
                pageTitle: "Our team", siteName: domain, favicon: null },
    counts: { emails: 9, phones: 1, socials: 1, customs: 1, total: 12 },
  })).concat([0, 1, 2].map(i => ({
    id: "dry_" + i, added_at: iso(300), last_scanned_at: iso(i + 1),
    scan_count: 3, pagesScanned: 40 + i * 300, pagesProductive: 0, pageHashes: [], topPages: [],
    found_at: { url: `https://dry${i}.example/x`, domain: `dry${i}.example`, path: "/x",
                pageTitle: "Nothing here", siteName: "Dry", favicon: null },
    counts: { emails: 0, phones: 0, socials: 0, customs: 0, total: 0 },
  })));

  store.prospekt_meters = { pagesScanned: 9104, pagesProductive: 2822 };
  store.prospekt_settings = { autoScan: true, maxScans: 5000, maxContacts: 20000, remoteFavicons: false };
  store.prospekt_patterns = {
    _v: 3,
    customPatterns: [
      { label: "Ticket IDs", regex: "TCK-\\d{5}", flags: "g" },
      { label: "Product SKUs", regex: "SKU-\\d{4}-[A-Z]{2}", flags: "g" },
    ],
  };
})();
