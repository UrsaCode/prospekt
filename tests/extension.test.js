// Loads the real extension sources into a VM with stubbed browser APIs and
// exercises the shipped functions. Not a substitute for loading the unpacked
// extension, but it proves the logic rather than assuming it.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");

let pass = 0, fail = 0;
const NAME = "extension";
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
};
const section = t => console.log("\n== " + t + " ==");

// ─────────────────────────────────────────────────────────────
// 1. defaults.js — regex behaviour
// ─────────────────────────────────────────────────────────────
section("defaults.js — extraction patterns");

const dctx = vm.createContext({ console, URL });
vm.runInContext(read("defaults.js"), dctx);
const D = vm.runInContext("PROSPEKT.DEFAULTS", dctx);

const phoneRe = new RegExp(D.phoneRegex, D.phoneFlags);
const matchPhones = s => s.match(new RegExp(D.phoneRegex, "g")) || [];

// v1's regex matched any 7+ digit run. These are the false positives it produced.
ok("plain 7-digit run is not a phone", matchPhones("Order 1234567 shipped").length === 0,
   JSON.stringify(matchPhones("Order 1234567 shipped")));
ok("price 1,234,567 is not a phone", matchPhones("Revenue $1,234,567 total").length === 0,
   JSON.stringify(matchPhones("Revenue $1,234,567 total")));
ok("real phone still matches", matchPhones("Call +1 (415) 555-2671 now").length === 1,
   JSON.stringify(matchPhones("Call +1 (415) 555-2671 now")));
ok("UK format still matches", matchPhones("Ring 020 7946 0958").length === 1,
   JSON.stringify(matchPhones("Ring 020 7946 0958")));
ok("dotted US format still matches", matchPhones("555.123.4567").length === 1,
   JSON.stringify(matchPhones("555.123.4567")));

const legacyList = vm.runInContext("PROSPEKT.LEGACY_DEFAULTS.phoneRegex", dctx);
const v100 = new RegExp(legacyList[1], "g");
ok("v1.0.0 regex DID match the bare digit run (regression is real)",
   ("Order 1234567 shipped".match(v100) || []).length > 0);

// Review finding 1: \s in the separator class spanned innerText's newlines.
const v110 = new RegExp(legacyList[0], "g");
const acrossLines = "Order 12345\n67890\nSKU 4021\n9983";
ok("v1.1.0 regex DID fuse numbers across newlines (regression is real)",
   (acrossLines.match(v110) || []).length > 0, JSON.stringify(acrossLines.match(v110)));
ok("current regex does not fuse across newlines",
   (acrossLines.match(new RegExp(D.phoneRegex, "g")) || []).length === 0,
   JSON.stringify(acrossLines.match(new RegExp(D.phoneRegex, "g"))));
const NB = String.fromCharCode(0xa0);
ok("current regex still accepts a non-breaking space separator",
   (("Call 020" + NB + "7946" + NB + "0958").match(new RegExp(D.phoneRegex, "g")) || []).length === 1);
ok("current regex still accepts a tab separator",
   ("Call 555\t123\t4567".match(new RegExp(D.phoneRegex, "g")) || []).length === 1);
ok("no literal NBSP smuggled into defaults.js source", !read("defaults.js").includes(NB));

const emailRe = new RegExp(D.emailRegex, "gi");
ok("email regex matches", "hi ali@example.co.uk there".match(emailRe)?.[0] === "ali@example.co.uk");

// resolvePatterns must keep an intentionally emptied list empty.
const resolved = vm.runInContext(
  "PROSPEKT.resolvePatterns({ customPatterns: [], skipDomains: ['a.com'] })", dctx);
ok("resolvePatterns keeps emptied list empty", Array.isArray(resolved.customPatterns) && resolved.customPatterns.length === 0);
ok("resolvePatterns honours stored override", resolved.skipDomains.length === 1);
ok("resolvePatterns fills missing keys from defaults", resolved.socialPatterns.length === D.socialPatterns.length);

// ─────────────────────────────────────────────────────────────
// 2. background.js — storage, dedup, stats, CSV
// ─────────────────────────────────────────────────────────────
section("background.js — storage + export");

function makeBackground({ tabs: openTabs = [] } = {}) {
  const store = {};
  const session = {};
  const listeners = {};
  const chromeStub = {
    runtime: {
      onInstalled: { addListener: fn => (listeners.installed = fn) },
      onStartup: { addListener: fn => (listeners.startup = fn) },
      onMessage: { addListener: fn => (listeners.message = fn) },
      id: "x",
      getURL: p => "chrome-extension://x/" + p,
      getManifest: () => ({ version: "1.2.0" }),
      sendMessage: (msg, cb) => { (listeners.broadcast ||= []).push(msg); cb && cb(); },
      lastError: null,
    },
    storage: {
      local: {
        get(keys, cb) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in store) out[k] = JSON.parse(JSON.stringify(store[k]));
          setTimeout(() => cb(out), 0);
        },
        set(obj, cb) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: store[k] && JSON.parse(JSON.stringify(store[k])), newValue: JSON.parse(JSON.stringify(v)) };
          }
          Object.assign(store, JSON.parse(JSON.stringify(obj)));
          setTimeout(() => {
            cb && cb();
            (listeners.changed || []).forEach(fn => fn(changes, "local"));
          }, 0);
        },
        remove(key, cb) { delete store[key]; setTimeout(() => cb && cb(), 0); },
      },
      onChanged: { addListener: fn => ((listeners.changed ||= []).push(fn)) },
      session: {
        get(key, cb) {
          const list = Array.isArray(key) ? key : [key];
          const out = {};
          for (const k of list) if (k in session) out[k] = JSON.parse(JSON.stringify(session[k]));
          setTimeout(() => cb(out), 0);
        },
        set(obj, cb) { Object.assign(session, JSON.parse(JSON.stringify(obj))); setTimeout(() => cb && cb(), 0); },
        remove(key, cb) { delete session[key]; setTimeout(() => cb && cb(), 0); },
      },
    },
    action: { setBadgeText: () => Promise.resolve(), setBadgeBackgroundColor: () => Promise.resolve() },
    tabs: {
      query: q => Promise.resolve(q && q.active ? openTabs.filter(t => t.active) : openTabs),
      create: () => Promise.resolve({}),
      update: () => Promise.resolve({}),
      sendMessage: (id, msg, cb) => { (listeners.sentToTabs ||= []).push({ id, msg }); cb && cb({ ok: true }); },
      onUpdated: {
        addListener: fn => ((listeners.tabUpdated ||= []).push(fn)),
        removeListener: fn => { listeners.tabUpdated = (listeners.tabUpdated || []).filter(f => f !== fn); },
      },
      // background.js registers more than one onRemoved handler (nav timers and
      // the session cache); keeping only the last would silently skip one.
      onRemoved: { addListener: fn => ((listeners.tabRemoved ||= []).push(fn)) },
    },
    windows: { update: () => Promise.resolve({}) },
    contextMenus: {
      items: [],
      removeAll(cb) { chromeStub.contextMenus.items = []; cb && cb(); },
      create(props, cb) { chromeStub.contextMenus.items.push({ ...props }); cb && cb(); return props.id; },
      update(id, props, cb) {
        const it = chromeStub.contextMenus.items.find(i => i.id === id);
        if (it) Object.assign(it, props);
        cb && cb();
      },
      onClicked: { addListener: fn => (listeners.menuClick = fn) },
    },
  };

  const ctx = vm.createContext({
    console, URL, setTimeout, clearTimeout, Promise, chrome: chromeStub,
    importScripts: f => vm.runInContext(read(f), ctx),
  });
  vm.runInContext(read("background.js"), ctx);
  return { ctx, store, session, listeners };
}

const TAB = { id: 7, active: true, url: "https://acme.com/team", title: "Acme — Team" };

const scanPayload = (domain, extra = {}) => ({
  meta: { domain, url: `https://${domain}/team`, path: "/team", pageTitle: `He said "hello"`, siteName: "Acme", favicon: null },
  emails: [{ value: "ali@" + domain, source: "mailto", context: null }],
  phones: [{ value: "+1 415 555 2671", source: "tel", context: null }],
  socials: [{ value: "https://github.com/ali", platform: "github", label: "GitHub" }],
  customs: [{ value: "SKU-9931", label: "SKUs", source: "custom_regex" }],
  emailPattern: "first",
  totalContacts: 4,
  ...extra,
});

(async () => {
  const { ctx } = makeBackground();
  const storeScan = ctx.storeScan, getStats = ctx.getStats, exportCSV = ctx.exportCSV;

  const r1 = await storeScan(scanPayload("acme.com"), { id: 1 });
  ok("first scan stores all 4 contacts", r1.newContacts === 4, JSON.stringify(r1));

  const r2 = await storeScan(scanPayload("acme.com"), { id: 1 });
  ok("re-scanning same page adds no duplicates", r2.newContacts === 0, JSON.stringify(r2));

  const stats = await getStats();
  ok("stats counts custom contacts", stats.customs === 1, JSON.stringify(stats));
  ok("type counts sum to totalContacts",
     stats.emails + stats.phones + stats.socials + stats.customs === stats.totalContacts,
     `${stats.emails}+${stats.phones}+${stats.socials}+${stats.customs} vs ${stats.totalContacts}`);
  ok("customLabelCounts populated", stats.customLabelCounts.SKUs === 1, JSON.stringify(stats.customLabelCounts));

  const scanRes = await ctx.getScans({});
  ok("getScans returns a paged {items,total} envelope", Array.isArray(scanRes.items) && typeof scanRes.total === "number",
     JSON.stringify(Object.keys(scanRes)));
  const scans = scanRes.items;
  ok("scan record carries a customs count", scans[0].counts.customs === 1, JSON.stringify(scans[0].counts));
  const c = scans[0].counts;
  ok("per-type counts sum to the scan total", c.emails + c.phones + c.socials + c.customs === c.total,
     JSON.stringify(c));

  // CSV: v1 wrapped in quotes without doubling them, so a page title containing
  // a " shifted every later column.
  const csv = await exportCSV("contacts");
  const header = csv.split("\r\n")[0];
  ok("contacts CSV has a Label column for custom matches", header.includes("Label"), header);
  ok("embedded quote is doubled", csv.includes('"He said ""hello"""'), csv.split("\r\n")[1]);
  const cols = csv.split("\r\n")[1].match(/(?:^|,)"(?:[^"]|"")*"/g) || [];
  ok("row column count matches header", cols.length === header.split(",").length,
     `${cols.length} vs ${header.split(",").length}`);

  // Formula injection guard
  const { ctx: ctx2 } = makeBackground();
  await ctx2.storeScan(scanPayload("evil.com", {
    customs: [{ value: "=HYPERLINK(\"http://x\")", label: "Bad", source: "custom_regex" }],
    totalContacts: 4,
  }), { id: 2 });
  const csv2 = await ctx2.exportCSV("contacts");
  ok("leading = is neutralised for spreadsheets", csv2.includes(`"'=HYPERLINK`), "no guard found");

  // Concurrency: two scans landing at once must not lose contacts.
  const { ctx: ctx3 } = makeBackground();
  await Promise.all([
    ctx3.serialize(() => ctx3.storeScan(scanPayload("a.com"), { id: 1 })),
    ctx3.serialize(() => ctx3.storeScan(scanPayload("b.com"), { id: 2 })),
    ctx3.serialize(() => ctx3.storeScan(scanPayload("c.com"), { id: 3 })),
  ]);
  const s3 = await ctx3.getStats();
  ok("3 concurrent scans keep all 3 domains", s3.totalDomains === 3, JSON.stringify(s3.totalDomains));
  // email/phone/social values differ per domain except the social + phone, which dedupe globally.
  ok("no contacts lost to the write race", s3.totalContacts >= 5, String(s3.totalContacts));

  // getScans must actually page rather than shipping the whole table.
  const { ctx: ctxPage } = makeBackground();
  for (let i = 0; i < 5; i++) await ctxPage.storeScan(scanPayload(`d${i}.com`), { id: i });
  const page1 = await ctxPage.getScans({ limit: 2, offset: 0 });
  const page2 = await ctxPage.getScans({ limit: 2, offset: 2 });
  ok("getScans honours limit", page1.items.length === 2, String(page1.items.length));
  ok("getScans reports the unpaged total", page1.total === 5, String(page1.total));
  ok("getScans honours offset", page1.items[0].id !== page2.items[0].id);

  // Review finding 3: a stored patterns object missing socialPatterns must NOT
  // come back as an empty list, which would disable social extraction forever.
  const { ctx: ctxMig } = makeBackground();
  const migrated = ctxMig.migratePatterns({ emailRegex: "x", _v: 1 }, "update");
  ok("migration leaves an absent socialPatterns absent", migrated.socialPatterns === undefined,
     JSON.stringify(migrated.socialPatterns));
  const reMig = vm.runInContext("PROSPEKT.resolvePatterns", ctxMig)(migrated);
  ok("so defaults are still applied after migration", reMig.socialPatterns.length > 0,
     String(reMig.socialPatterns.length));
  const migrated2 = ctxMig.migratePatterns({ socialPatterns: [{ platform: "x", regex: "y" }], _v: 1 }, "update");
  ok("migration still adds flags when the key exists", migrated2.socialPatterns[0].flags === "gi",
     JSON.stringify(migrated2.socialPatterns[0]));

  // Review finding 1: the v1.1.0 phone regex is now a known-legacy value, so
  // users who installed it inherit the fix.
  const legacy = vm.runInContext("PROSPEKT.LEGACY_DEFAULTS.phoneRegex", ctxMig);
  ok("v1.1.0 phone regex registered as legacy", legacy.length === 2, JSON.stringify(legacy.length));
  const upgraded = ctxMig.migratePatterns({ phoneRegex: legacy[0], _v: 2 }, "update");
  ok("an untouched v1.1.0 phone regex is upgraded",
     upgraded.phoneRegex === vm.runInContext("PROSPEKT.DEFAULTS.phoneRegex", ctxMig), upgraded.phoneRegex);
  const customised = ctxMig.migratePatterns({ phoneRegex: "MY-OWN-\\d+", _v: 2 }, "update");
  ok("a customised phone regex is left alone", customised.phoneRegex === "MY-OWN-\\d+", customised.phoneRegex);

  // ── Popup page state ─────────────────────────────────────────
  section("background.js — popup page state");

  {
    const { ctx: c, session: sess, listeners: L } = makeBackground({ tabs: [TAB] });

    // No cache yet -> scanning, and it must kick off a scan.
    const first = await c.getPageState();
    ok("first visit reports scanning", first.state === "scanning", first.state);
    await new Promise(r => setTimeout(r, 30));   // the rescan is fire-and-forget
    ok("scanning triggers a rescan of that tab",
       (L.sentToTabs || []).some(m => m.id === TAB.id && m.msg.action === "rescan"),
       JSON.stringify(L.sentToTabs));
    ok("state carries the version and autoScan for the header",
       !!first.version && first.autoScan === true, JSON.stringify({ v: first.version, a: first.autoScan }));

    // Scan lands with results.
    await c.storeScan(scanPayload("acme.com"), TAB);
    const second = await c.getPageState();
    ok("cached scan reports results", second.state === "results", second.state);
    ok("result totals reach the popup", second.result.total === 4, JSON.stringify(second.result.total));
    ok("all four hits are rows", second.result.rows.length === 4, String(second.result.rows.length));
    ok("first scan marks every row new", second.result.rows.every(r => r.isNew), JSON.stringify(second.result.rows.map(r => r.isNew)));
    ok("newCount matches", second.result.newCount === 4, String(second.result.newCount));
    ok("rows carry their source for the meta line",
       second.result.rows.every(r => !!r.source), JSON.stringify(second.result.rows.map(r => r.source)));
    ok("domain stats populate the footer",
       second.domainStats.contacts === 4 && second.domainStats.scans === 1, JSON.stringify(second.domainStats));

    // Re-scanning the same page: everything is already saved.
    await c.storeScan(scanPayload("acme.com"), TAB);
    const third = await c.getPageState();
    ok("re-scan marks every row already-saved",
       third.result.rows.every(r => !r.isNew), JSON.stringify(third.result.rows.map(r => r.isNew)));
    ok("newCount drops to zero", third.result.newCount === 0, String(third.result.newCount));
    ok("savedCount reflects the split", third.result.savedCount === 4, String(third.result.savedCount));
    ok("already-saved rows carry when they were first seen",
       third.result.rows.every(r => !!r.savedAt), JSON.stringify(third.result.rows.map(r => r.savedAt)));

    // A page with nothing on it must still register.
    const empty = { ...scanPayload("acme.com"), emails: [], phones: [], socials: [], customs: [], totalContacts: 0 };
    await c.storeScan(empty, TAB);
    const fourth = await c.getPageState();
    ok("an empty page reports empty, not scanning", fourth.state === "empty", fourth.state);
    ok("empty scan does not pollute the library",
       (JSON.parse(JSON.stringify(await c.getContacts({})))).total === 4,
       String((await c.getContacts({})).total));

    // Tab close evicts the cache.
    ok("page state is cached under the tab id", !!sess["page_" + TAB.id]);
    L.tabRemoved.forEach(fn => fn(TAB.id));
    await new Promise(r => setTimeout(r, 20));
    ok("closing the tab evicts its cached page", !sess["page_" + TAB.id], JSON.stringify(Object.keys(sess)));
  }

  // Regression: marking a tab as scanning must NOT wake the popup. It used to,
  // and the popup treats scanning as stale — so it re-triggered a rescan, which
  // re-marked scanning, which broadcast again. The loop's rescan messages also
  // cancelled the pending scan timer, so the scan never ran: stuck on scanning.
  {
    const { ctx: c, listeners: L } = makeBackground({ tabs: [TAB] });
    await c.getPageState();
    await new Promise(r => setTimeout(r, 40));
    const broadcasts = (L.broadcast || []).filter(m => m.action === "pageStateChanged");
    ok("entering the scanning state broadcasts nothing", broadcasts.length === 0,
       `${broadcasts.length} broadcast(s)`);

    const rescans = (L.sentToTabs || []).filter(m => m.msg.action === "rescan");
    ok("one getPageState triggers exactly one rescan", rescans.length === 1, String(rescans.length));

    // A finished scan is the only thing worth waking the popup for.
    await c.storeScan(scanPayload("acme.com"), TAB);
    await new Promise(r => setTimeout(r, 40));
    ok("a completed scan does broadcast",
       (L.broadcast || []).filter(m => m.action === "pageStateChanged").length === 1,
       JSON.stringify((L.broadcast || []).map(m => m.action)));
  }

  // Regression: an unreachable content script must be a state, not a hang.
  {
    const { ctx: c, ctx } = makeBackground({ tabs: [TAB] });
    // Simulate "Receiving end does not exist".
    ctx.chrome.tabs.sendMessage = (id, msg, cb) => {
      ctx.chrome.runtime.lastError = { message: "Could not establish connection." };
      cb && cb(undefined);
      ctx.chrome.runtime.lastError = null;
    };
    const s = await c.getPageState();
    ok("an undeliverable rescan reports unreachable, not scanning",
       s.state === "unreachable", s.state);
    ok("unreachable carries the reason", !!s.reason, JSON.stringify(s.reason));
  }

  // Skip list drives the skipped state.
  {
    const { ctx: c, store: st } = makeBackground({ tabs: [TAB] });
    await c.setDomainSkipped("acme.com", true);
    const s = await c.getPageState();
    ok("a skip-listed domain reports skipped", s.state === "skipped", s.state);
    const stored = st.prospekt_patterns;
    ok("skipDomain appends to the list", stored.skipDomains.includes("acme.com"));
    ok("skipping keeps the rest of the defaults intact", stored.junkSocialPaths.length > 0);

    await c.setDomainSkipped("acme.com", false);
    ok("unskipDomain removes it",
       !st.prospekt_patterns.skipDomains.includes("acme.com"));
    ok("state returns to scanning once unskipped", (await c.getPageState()).state === "scanning");

    // www. prefix must not create a duplicate entry.
    await c.setDomainSkipped("www.acme.com", true);
    const list = st.prospekt_patterns.skipDomains;
    ok("www. is normalised away", list.filter(d => d === "acme.com").length === 1, JSON.stringify(list.slice(-3)));
  }

  // Non-http tabs have nothing to say.
  {
    const { ctx: c } = makeBackground({ tabs: [{ id: 9, active: true, url: "chrome://extensions", title: "Extensions" }] });
    ok("chrome:// pages report unsupported", (await c.getPageState()).state === "unsupported");
  }

  // Per-page export.
  {
    const { ctx: c } = makeBackground({ tabs: [TAB] });
    await c.storeScan(scanPayload("acme.com"), TAB);
    const csv = await c.exportPage(TAB.id);
    const lines = csv.trim().split("\r\n");
    ok("page export has a Status column", lines[0].includes("Status"), lines[0]);
    ok("page export has one row per hit", lines.length === 5, String(lines.length));
    ok("page export marks new rows", csv.includes('"new"'), lines[1]);
  }

  // ── Per-domain dedup, provenance, barren, meters ─────────────
  section("background.js — collection model");

  {
    const { ctx: c, store: st } = makeBackground({ tabs: [TAB] });

    // The same address on two domains is now two findings, not one.
    const shared = v => ({ value: v, source: "mailto", context: null });
    const payload = (dom, url) => ({
      ...scanPayload(dom),
      meta: { domain: dom, url, path: "/p", pageTitle: "P", siteName: dom, favicon: null },
      emails: [shared("ada@shared.com")], phones: [], socials: [], customs: [], totalContacts: 1,
    });

    await c.storeScan(payload("acme.com", "https://acme.com/a"), TAB);
    await c.storeScan(payload("other.com", "https://other.com/a"), TAB);
    const all = await c.getContacts({});
    ok("the same value on two domains is kept twice", all.total === 2, String(all.total));
    ok("both are flagged as spanning domains", all.items.every(i => i.isDuplicate), JSON.stringify(all.items.map(i => i.isDuplicate)));
    ok("domain spread is reported", all.items[0].domainSpread === 2, String(all.items[0].domainSpread));

    // ...but a repeat on the SAME domain is still one row.
    await c.storeScan(payload("acme.com", "https://acme.com/a"), TAB);
    ok("a repeat on the same page adds no row", (await c.getContacts({})).total === 2);

    // A repeat on a different page of the same domain updates provenance.
    await c.storeScan(payload("acme.com", "https://acme.com/b"), TAB);
    const acme = (await c.getContacts({ domain: "acme.com" })).items[0];
    ok("still one row for that domain", (await c.getContacts({ domain: "acme.com" })).total === 1);
    ok("pageCount tracks distinct pages", acme.pageCount === 2, String(acme.pageCount));
    ok("last_seen_at is refreshed", !!acme.last_seen_at && acme.last_seen_at >= acme.added_at,
       JSON.stringify({ a: acme.added_at, l: acme.last_seen_at }));

    ok("duplicatesOnly filter works", (await c.getContacts({ duplicatesOnly: true })).total === 2);
  }

  // Role addresses.
  {
    const { ctx: c } = makeBackground({ tabs: [TAB] });
    const p = { ...scanPayload("acme.com"),
      emails: [{ value: "info@acme.com", source: "text" }, { value: "dana@acme.com", source: "text" }],
      phones: [], socials: [], customs: [], totalContacts: 2 };
    await c.storeScan(p, TAB);
    const rows = (await c.getContacts({})).items;
    ok("generic mailbox flagged as a role address",
       rows.find(r => r.value === "info@acme.com").isRole === true);
    ok("a named address is not a role address",
       rows.find(r => r.value === "dana@acme.com").isRole === false);
    ok("hideRole filter removes only role addresses",
       (await c.getContacts({ hideRole: true })).total === 1);
  }

  // Dry domains, page tracking and hit rate — all now on the scan records.
  {
    const { ctx: c } = makeBackground({ tabs: [TAB] });
    const dryPayload = (dom, page = "x") => ({
      meta: { domain: dom, url: `https://${dom}/${page}`, path: `/${page}`, pageTitle: page, siteName: dom, favicon: null },
      emails: [], phones: [], socials: [], customs: [], totalContacts: 0,
    });

    await c.storeScan(dryPayload("empty1.com"), TAB);
    await c.storeScan(dryPayload("empty2.com"), TAB);
    await c.storeScan(scanPayload("acme.com"), TAB);

    const list = await c.getScans({});
    ok("a domain that yields nothing still gets a record", list.total === 3, String(list.total));
    ok("dry domains are flagged", list.items.filter(s => s.dry).length === 2,
       JSON.stringify(list.items.map(s => [s.found_at.domain, s.dry])));
    ok("state counts drive the chips",
       list.stateCounts.all === 3 && list.stateCounts.yielding === 1 && list.stateCounts.dry === 2,
       JSON.stringify(list.stateCounts));

    // Distinct pages, not scans.
    await c.storeScan(dryPayload("empty1.com"), TAB);          // same page again
    await c.storeScan(dryPayload("empty1.com", "second"), TAB); // a new page
    const e1 = (await c.getScans({ domain: "empty1.com" })).items[0];
    ok("pagesScanned counts distinct pages", e1.pagesScanned === 2, String(e1.pagesScanned));
    ok("scan_count counts every visit", e1.scan_count === 3, String(e1.scan_count));
    ok("a dry domain has a zero yield rate", e1.yieldRate === 0, String(e1.yieldRate));

    const acme = (await c.getScans({ domain: "acme.com" })).items[0];
    ok("a producing page is counted as productive", acme.pagesProductive === 1, String(acme.pagesProductive));
    ok("yield rate is pages-based", acme.yieldRate === 100, String(acme.yieldRate));
    ok("producing pages are listed for the drawer", (acme.topPages || []).length === 1,
       JSON.stringify(acme.topPages));
    ok("page hashes are not shipped to the UI", acme.pageHashes === undefined);

    const ov = await c.getOverview();
    ok("hit rate is page-based", ov.pagesScanned === 5 && ov.pagesProductive === 1,
       JSON.stringify({ s: ov.pagesScanned, p: ov.pagesProductive }));
    ok("dry count reaches Needs a look", ov.needsALook.barrenDomains === 2,
       String(ov.needsALook.barrenDomains));

    // A domain that finally produces stops being dry.
    await c.storeScan({ ...scanPayload("empty1.com"),
      meta: { domain: "empty1.com", url: "https://empty1.com/x", path: "/x", pageTitle: "X", siteName: "e", favicon: null } }, TAB);
    const after = (await c.getScans({ domain: "empty1.com" })).items[0];
    ok("a producing domain is no longer dry", after.dry === false, JSON.stringify(after.counts));
    ok("its yield rate reflects only the producing page", after.yieldRate === 50, String(after.yieldRate));
  }

  // Records written before per-page tracking existed.
  {
    const { ctx: c, store: st } = makeBackground({ tabs: [TAB] });
    st.prospekt_scans = [{
      id: "scan_legacy",
      added_at: "2026-05-01T10:00:00.000Z",
      last_scanned_at: "2026-08-05T10:00:00.000Z",
      scan_count: 4,
      found_at: { url: "https://ursacode.com/team", domain: "ursacode.com", path: "/team",
                  pageTitle: "Our team", siteName: "Ursa Code", favicon: null },
      counts: { emails: 11, phones: 0, socials: 0, customs: 0, total: 11 },
    }];
    st.prospekt_contacts = [];

    const item = (await c.getScans({})).items[0];
    // Reported "undefined%" in the drawer and a misleading 0% in the table.
    ok("a legacy record reports an unknown yield, not zero",
       item.yieldRate === null, JSON.stringify(item.yieldRate));
    ok("and says so explicitly", item.yieldKnown === false, JSON.stringify(item.yieldKnown));
    ok("page count is backfilled from scan_count", item.pagesScanned === 4, String(item.pagesScanned));
    ok("a legacy record with contacts is not marked dry", item.dry === false, JSON.stringify(item.dry));

    // Unknown must sort last rather than as if it were the worst score.
    st.prospekt_scans.push({
      id: "scan_new", added_at: "2026-08-01T10:00:00.000Z", last_scanned_at: "2026-08-05T11:00:00.000Z",
      scan_count: 2, pagesScanned: 4, pagesProductive: 1, pageHashes: ["a", "b", "c", "d"], topPages: [],
      found_at: { url: "https://regexhunter.com/x", domain: "regexhunter.com", path: "/x",
                  pageTitle: "X", siteName: "RH", favicon: null },
      counts: { emails: 1, phones: 0, socials: 0, customs: 0, total: 1 },
    });
    const sorted = (await c.getScans({ sort: "yield" })).items.map(s => s.found_at.domain);
    ok("a measured yield outranks an unknown one",
       sorted[0] === "regexhunter.com", JSON.stringify(sorted));

    // ...and must not be counted as a zero-yield domain in the distribution.
    const ins = await c.getInsights("all");
    const zero = ins.distribution.find(b => b.key === "zero");
    ok("legacy records stay out of the zero bucket", zero.count === 0, String(zero.count));
    ok("they are reported separately instead", ins.unratedDomains === 1, String(ins.unratedDomains));
    ok("the distribution only totals rateable domains",
       ins.distribution.reduce((s, b) => s + b.count, 0) === ins.domainsTotal,
       JSON.stringify({ d: ins.distribution.map(b => b.count), t: ins.domainsTotal }));
  }

  // Reported from a real install: a tracked record still claiming "unknown".
  {
    const { ctx: c, store: st } = makeBackground({ tabs: [TAB] });
    // A record that HAS been through per-page tracking but never produced, so
    // pagesProductive was never assigned.
    st.prospekt_scans = [{
      id: "scan_tracked", added_at: "2026-08-06T03:07:00.000Z", last_scanned_at: "2026-08-06T03:07:00.000Z",
      scan_count: 1, pagesScanned: 1, pageHashes: ["abc"], topPages: [],
      found_at: { url: "https://ursacode.com/x", domain: "ursacode.com", path: "/x",
                  pageTitle: "X", siteName: "Ursa", favicon: null },
      counts: { emails: 0, phones: 0, socials: 5, customs: 0, total: 5 },
    }];
    st.prospekt_contacts = [];

    const item = (await c.getScans({})).items[0];
    ok("a tracked-but-unproductive record reports a real 0%, not unknown",
       item.yieldRate === 0 && item.yieldKnown === true,
       JSON.stringify({ rate: item.yieldRate, known: item.yieldKnown }));

    // And folding any record normalises both counters, so this can't recur.
    const { ctx: c2, store: st2 } = makeBackground({ tabs: [TAB] });
    st2.prospekt_scans = [{
      id: "legacy", added_at: "2026-05-01T10:00:00.000Z", last_scanned_at: "2026-05-01T10:00:00.000Z",
      scan_count: 3,
      found_at: { url: "https://ursacode.com/team", domain: "ursacode.com", path: "/team",
                  pageTitle: "Team", siteName: "Ursa", favicon: null },
      counts: { emails: 2, phones: 0, socials: 0, customs: 0, total: 2 },
    }];
    st2.prospekt_contacts = [];
    // A barren re-scan of that legacy domain.
    await c2.storeScan({
      meta: { domain: "ursacode.com", url: "https://ursacode.com/team", path: "/team",
              pageTitle: "Team", siteName: "Ursa", favicon: null },
      emails: [], phones: [], socials: [], customs: [], totalContacts: 0,
    }, TAB);
    const folded = st2.prospekt_scans.find(s => s.found_at.domain === "ursacode.com");
    ok("folding normalises pagesProductive to a number",
       typeof folded.pagesProductive === "number", JSON.stringify(folded.pagesProductive));
    ok("folding normalises pagesScanned to a number",
       typeof folded.pagesScanned === "number", JSON.stringify(folded.pagesScanned));
    ok("and the rate is then a real measurement",
       (await c2.getScans({})).items[0].yieldRate === 0,
       JSON.stringify((await c2.getScans({})).items[0].yieldRate));
  }

  // Rescan flow: reopening a domain.
  {
    const openTabs = [
      { id: 1, url: "https://ursacode.com/team", title: "Team" },
      { id: 2, url: "https://www.ursacode.com/pricing", title: "Pricing" },
      { id: 3, url: "https://regexhunter.com/", title: "RH" },
    ];
    const { ctx: c } = makeBackground({ tabs: openTabs });
    const created = [];
    c.chrome.tabs.create = t => { created.push(t); return Promise.resolve({ id: 99 }); };

    const info = await c.domainTabs("ursacode.com");
    ok("open tabs on the domain are counted", info.count === 2, JSON.stringify(info.count));
    ok("www. does not split the count", info.tabs.some(t => t.url.includes("www.")), JSON.stringify(info.tabs.map(t => t.url)));
    ok("other domains are excluded", !info.tabs.some(t => t.url.includes("regexhunter")));
    ok("an unknown domain reports zero", (await c.domainTabs("nowhere.example")).count === 0);

    // Opening is constrained to the domain being rescanned.
    ok("opening the domain's own page is allowed",
       (await c.openAndScan("https://ursacode.com/team", "ursacode.com")).ok === true);
    ok("a tab was actually created", created.length === 1, JSON.stringify(created));

    const other = await c.openAndScan("https://evil.example/steal", "ursacode.com");
    ok("a URL on another domain is refused", other.ok === false, JSON.stringify(other));
    ok("and says why", /isn't on this domain/.test(other.error || ""), JSON.stringify(other.error));

    const js = await c.openAndScan("javascript:alert(1)", "ursacode.com");
    ok("javascript: is refused", js.ok === false, JSON.stringify(js));

    const file = await c.openAndScan("file:///etc/passwd", "ursacode.com");
    ok("file: is refused", file.ok === false, JSON.stringify(file));

    const junk = await c.openAndScan("not a url", "ursacode.com");
    ok("a malformed URL is refused", junk.ok === false, JSON.stringify(junk));
    ok("no extra tabs were opened by the refusals", created.length === 1, String(created.length));
  }

  // ── Message-router permissions ───────────────────────────────
  section("background.js — who may call what");

  {
    const { ctx: c, listeners: L, store: st } = makeBackground({ tabs: [] });
    const created = [];
    c.chrome.tabs.create = t => { created.push(t); return Promise.resolve({ id: 5 }); };

    const call = (msg, sender) => new Promise(resolve => {
      const kept = L.message(msg, sender, resolve);
      if (!kept) resolve(undefined);
    });

    const PAGE = { id: "x", url: "chrome-extension://x/dashboard.html", tab: { id: 1 } };
    // A content script: same extension id, but its URL is the web page.
    const CONTENT = { id: "x", url: "https://evil.example/post", tab: { id: 2 } };

    // The dashboard keeps working.
    const fromPage = await call({ action: "getSettings" }, PAGE);
    ok("an extension page may call a privileged action",
       fromPage && fromPage.ok !== false, JSON.stringify(fromPage)?.slice(0, 60));

    // A content script may only report scans.
    const scanFromContent = await call({
      action: "storeScan",
      data: { meta: { domain: "ursacode.com", url: "https://ursacode.com/a", path: "/a", pageTitle: "A", siteName: "U", favicon: null },
              emails: [], phones: [], socials: [], customs: [], totalContacts: 0 },
    }, CONTENT);
    ok("a content script may still report a scan", scanFromContent?.ok === true, JSON.stringify(scanFromContent));

    for (const action of ["openAndScan", "clearAll", "importSettings", "exportCSV", "deleteContacts", "resetPatterns"]) {
      const res = await call({ action, url: "https://evil.example/x", domain: "", ids: ["c_1"], payload: {} }, CONTENT);
      ok(`a content script cannot call ${action}`, res?.ok === false && /Not permitted/.test(res.error || ""),
         JSON.stringify(res));
    }
    ok("no tab was opened by the refused calls", created.length === 0, JSON.stringify(created));
    ok("storage was not cleared by the refused calls", Array.isArray(st.prospekt_scans));

    // Prototype-chain keys must not look like handlers.
    for (const action of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const res = await call({ action }, PAGE);
      ok(`"${action}" is not treated as a handler`, res === undefined, JSON.stringify(res));
    }

    // An unrelated extension must not be able to drive us either.
    const other = await call({ action: "clearAll" }, { id: "someone-else", url: "chrome-extension://someone-else/x.html" });
    ok("another extension is refused", other?.ok === false, JSON.stringify(other));
  }

  // The domain gate must not fail open.
  {
    const { ctx: c } = makeBackground({ tabs: [] });
    const created = [];
    c.chrome.tabs.create = t => { created.push(t); return Promise.resolve({ id: 6 }); };

    for (const domain of ["", null, undefined]) {
      const res = await c.openAndScan("https://evil.example/steal", domain);
      ok(`an empty domain (${JSON.stringify(domain)}) is refused, not waved through`,
         res.ok === false, JSON.stringify(res));
    }
    ok("no tab opened for any empty-domain call", created.length === 0, JSON.stringify(created));
    ok("a matching domain still works",
       (await c.openAndScan("https://ursacode.com/x", "ursacode.com")).ok === true);
  }

  // Skip list shows up as its own state.
  {
    const { ctx: c } = makeBackground({ tabs: [TAB] });
    await c.storeScan(scanPayload("acme.com"), TAB);
    await c.setDomainSkipped("acme.com", true);
    const list = await c.getScans({});
    ok("a skip-listed domain is flagged in scan history", list.items[0].skipped === true);
    ok("skipped has its own chip count", list.stateCounts.skipped === 1, JSON.stringify(list.stateCounts));
    ok("skipped filter narrows to it", (await c.getScans({ state: "skipped" })).total === 1);
  }

  // Summary strip + sorting + bulk delete.
  {
    const { ctx: c } = makeBackground({ tabs: [TAB] });
    await c.storeScan(scanPayload("acme.com"), TAB);
    await c.storeScan({ ...scanPayload("beta.com"),
      meta: { domain: "beta.com", url: "https://beta.com/p", path: "/p", pageTitle: "P", siteName: "b", favicon: null },
      emails: [{ value: "one@beta.com", source: "text" }], phones: [], socials: [], customs: [], totalContacts: 1 }, TAB);

    const list = await c.getScans({});
    ok("summary reports storage headroom",
       list.summary.recordsUsed === 2 && list.summary.recordsMax === 5000, JSON.stringify(list.summary));
    ok("summary reports pages scanned", list.summary.pagesScanned === 2, String(list.summary.pagesScanned));
    ok("summary reports when collecting started", !!list.summary.since);

    ok("default sort is most contacts",
       (await c.getScans({})).items[0].found_at.domain === "acme.com");
    ok("domain sort is alphabetical",
       (await c.getScans({ sort: "domain" })).items[0].found_at.domain === "acme.com");

    const ids = (await c.getScans({})).items.map(s => s.id);
    const del = await c.deleteScans([ids[0]]);
    ok("deleting a scan removes it", del.removed === 1, JSON.stringify(del));
    ok("and takes its contacts with it", (await c.getContacts({})).total === 1,
       String((await c.getContacts({})).total));
  }

  // Export stamping.
  {
    const { ctx: c, store: st } = makeBackground({ tabs: [TAB] });
    await c.storeScan(scanPayload("acme.com"), TAB);
    let ov = await c.getOverview();
    ok("everything counts as never-exported before an export",
       ov.needsALook.neverExported === 4, String(ov.needsALook.neverExported));

    await c.exportCSV("contacts");
    await new Promise(r => setTimeout(r, 40));
    ok("export stamps a timestamp", !!st.prospekt_settings.lastExportAt?.contacts,
       JSON.stringify(st.prospekt_settings.lastExportAt));

    ov = await c.getOverview();
    ok("nothing is outstanding right after an export",
       ov.needsALook.neverExported === 0, String(ov.needsALook.neverExported));
    ok("contacts report as exported", (await c.getContacts({})).items.every(i => i.exported));
    ok("notExported filter is empty right after an export",
       (await c.getContacts({ notExported: true })).total === 0);
  }

  // Overview shape.
  {
    const { ctx: c } = makeBackground({ tabs: [TAB] });
    await c.storeScan(scanPayload("acme.com"), TAB);
    await c.storeScan(scanPayload("beta.com"), TAB);
    const ov = await c.getOverview();
    ok("collectingSince is populated", !!ov.collectingSince, String(ov.collectingSince));
    ok("addedThisWeek counts recent contacts", ov.addedThisWeek === ov.totalContacts, String(ov.addedThisWeek));
    ok("richest domains are ranked with a type split",
       ov.richestDomains.length === 2 && ov.richestDomains[0].email >= 1,
       JSON.stringify(ov.richestDomains));
    ok("daily series covers 14 days", ov.dailyContacts.length === 14, String(ov.dailyContacts.length));
    ok("latest finds are returned", ov.latest.length > 0 && !!ov.latest[0].domain);
    ok("type split totals the library",
       ov.byType.email + ov.byType.phone + ov.byType.social + ov.byType.custom === ov.totalContacts,
       JSON.stringify(ov.byType));
  }

  // ── Contacts toolbar filters ─────────────────────────────────
  section("background.js — contacts filters");

  {
    const { ctx: c } = makeBackground({ tabs: [TAB] });
    const mk = (dom, emails, socials = []) => ({
      meta: { domain: dom, url: `https://${dom}/p`, path: "/p", pageTitle: "P", siteName: dom, favicon: null },
      emails: emails.map(v => ({ value: v, source: "text" })),
      phones: [], socials: socials.map(v => ({ value: v, platform: "github", label: "GitHub" })), customs: [],
      totalContacts: emails.length + socials.length,
    });

    await c.storeScan(mk("acme.com", ["info@acme.com", "dana@acme.com"], ["https://github.com/acme"]), TAB);
    await c.storeScan(mk("beta.com", ["dana@acme.com"]), TAB);   // same value, other domain

    const all = await c.getContacts({});
    ok("typeCounts accompany the list", !!all.typeCounts, JSON.stringify(all.typeCounts));
    ok("typeCounts.all matches the total", all.typeCounts.all === all.total, `${all.typeCounts.all} vs ${all.total}`);
    ok("typeCounts split by type", all.typeCounts.email === 3 && all.typeCounts.social === 1,
       JSON.stringify(all.typeCounts));

    // Counts are computed before the type filter, so chips stay switchable.
    const emailsOnly = await c.getContacts({ type: "email" });
    ok("type filter narrows the list", emailsOnly.total === 3, String(emailsOnly.total));
    ok("but chip counts still show every type", emailsOnly.typeCounts.social === 1,
       JSON.stringify(emailsOnly.typeCounts));

    ok("rolesOnly keeps just generic mailboxes", (await c.getContacts({ rolesOnly: true })).total === 1);
    ok("hideRole is the complement", (await c.getContacts({ hideRole: true })).total === 3);
    ok("duplicatesOnly finds the cross-domain value",
       (await c.getContacts({ duplicatesOnly: true })).total === 2,
       String((await c.getContacts({ duplicatesOnly: true })).total));

    // Sorting
    const newest = (await c.getContacts({})).items.map(i => i.added_at);
    const oldest = (await c.getContacts({ sort: "oldest" })).items.map(i => i.added_at);
    ok("oldest sort reverses newest", oldest[0] <= newest[0], `${oldest[0]} vs ${newest[0]}`);
    const byDomain = (await c.getContacts({ sort: "domain" })).items.map(i => i.found_at.domain);
    ok("domain sort groups by domain", byDomain[0] === "acme.com" && byDomain.at(-1) === "beta.com",
       JSON.stringify(byDomain));

    // Filters compose with paging without losing the unfiltered total.
    const paged = await c.getContacts({ type: "email", limit: 2, offset: 0 });
    ok("paging reports the filtered total", paged.total === 3 && paged.items.length === 2,
       JSON.stringify({ t: paged.total, n: paged.items.length }));
  }

  // Bulk operations.
  {
    const { ctx: c } = makeBackground({ tabs: [TAB] });
    await c.storeScan(scanPayload("acme.com"), TAB);
    const ids = (await c.getContacts({})).items.slice(0, 2).map(i => i.id);

    const csv = await c.exportSelection(ids);
    ok("selection export has one row per id", csv.trim().split("\r\n").length === 3, csv.trim().split("\r\n").length);
    ok("selection export carries provenance columns", csv.split("\r\n")[0].includes("Pages"));

    const del = await c.deleteContacts(ids);
    ok("bulk delete removes exactly the selection", del.removed === 2, JSON.stringify(del));
    ok("the rest of the library survives", (await c.getContacts({})).total === 2,
       String((await c.getContacts({})).total));
    ok("bulk delete with no ids is rejected", (await c.deleteContacts([])).ok === false);
  }

  // ── Insights ─────────────────────────────────────────────────
  section("background.js — insights");

  {
    const { ctx: c } = makeBackground({ tabs: [TAB] });
    const payload = (dom, o) => ({
      meta: { domain: dom, url: `https://${dom}/p`, path: "/p", pageTitle: "P", siteName: dom, favicon: null },
      emails: [], phones: [], socials: [], customs: [], totalContacts: 0, ...o,
    });

    await c.storeScan(payload("acme.com", {
      emails: [
        { value: "dana@acme.com", source: "text" },       // company
        { value: "info@acme.com", source: "text" },       // role
        { value: "ada@gmail.com", source: "text" },       // free provider
      ],
      phones: [
        { value: "+1 415 555 2671", source: "tel" },
        { value: "2024 01 15", source: "text" },          // date-shaped noise
      ],
      socials: [{ value: "https://github.com/acme", platform: "github", label: "GitHub" }],
      customs: [{ value: "SKU-1", label: "SKUs", source: "custom_regex" }],
      totalContacts: 7,
    }), TAB);
    await c.storeScan(payload("dry.example"), TAB);

    const i = await c.getInsights("12w");

    ok("weekly series spans the range", i.series.length === 12, String(i.series.length));
    ok("this week's bucket holds the contacts",
       i.series.at(-1).total === 7, JSON.stringify(i.series.at(-1)));
    ok("series is split by type",
       i.series.at(-1).email === 3 && i.series.at(-1).phone === 2, JSON.stringify(i.series.at(-1)));

    const byName = Object.fromEntries(i.patterns.map(p => [p.name, p]));
    ok("built-in patterns are reported", !!byName.Email && !!byName.Phone);
    ok("email matches are counted", byName.Email.matches === 3, String(byName.Email.matches));
    ok("social patterns are matched by platform", byName.GitHub.matches === 1, String(byName.GitHub.matches));
    ok("custom patterns are matched by label", !!byName.SKUs, JSON.stringify(Object.keys(byName)));
    ok("shares are percentages of all matches",
       i.patterns.reduce((s, p) => s + p.share, 0) >= 95, String(i.patterns.reduce((s, p) => s + p.share, 0)));

    // Health signals
    ok("a producing pattern reads healthy", byName.Email.health.tone === "ok", JSON.stringify(byName.Email.health));
    ok("date-shaped phone noise is surfaced",
       byName.Phone.health.tone === "warn" && /look like dates/.test(byName.Phone.health.text),
       JSON.stringify(byName.Phone.health));
    ok("a pattern that never matched is flagged idle",
       byName.Facebook.health.tone === "idle" && byName.Facebook.matches === 0,
       JSON.stringify(byName.Facebook.health));

    // Email quality
    ok("company addresses are separated", i.emailQuality.company === 1, String(i.emailQuality.company));
    ok("free providers are separated", i.emailQuality.free === 1, String(i.emailQuality.free));
    ok("role addresses are separated", i.emailQuality.role === 1, String(i.emailQuality.role));
    ok("quality buckets total the addresses",
       i.emailQuality.company + i.emailQuality.free + i.emailQuality.role === i.emailQuality.total,
       JSON.stringify(i.emailQuality));

    // Yield distribution covers every domain exactly once.
    const distTotal = i.distribution.reduce((s, b) => s + b.count, 0);
    ok("every domain lands in exactly one yield bucket", distTotal === i.domainsTotal,
       `${distTotal} vs ${i.domainsTotal}`);
    ok("the dry domain lands in the zero bucket", i.distribution[0].count === 1,
       JSON.stringify(i.distribution.map(b => [b.label, b.count])));

    // Range narrows the window.
    const wk = await c.getInsights("7d");
    ok("7d range yields one week of buckets", wk.series.length === 1, String(wk.series.length));
    const all = await c.getInsights("all");
    ok("all-time still reports the contacts", all.patterns.find(p => p.name === "Email").matches === 3);

    ok("a removed custom pattern still appears, flagged",
       byName.SKUs?.health.text === "Pattern removed" && byName.SKUs.matches === 1,
       JSON.stringify(byName.SKUs?.health));

    const report = c.insightsCsv(await c.getInsights("12w"));
    ok("the report includes every section",
       ["Pattern", "Email quality", "Social platform", "Yield distribution", "Weekly"]
         .every(s => report.includes(s)), report.split("\r\n")[1]);
  }

  // ── Action context menu ──────────────────────────────────────
  section("background.js — action context menu");

  const { ctx: ctxMenu, listeners: lMenu, store: storeMenu } = makeBackground();
  await ctxMenu.buildMenus();
  const items = ctxMenu.chrome.contextMenus.items;
  ok("menu is built", items.length > 0, String(items.length));
  ok("every item is scoped to the action icon",
     items.every(i => Array.isArray(i.contexts) && i.contexts.includes("action")),
     JSON.stringify(items.map(i => i.contexts)));
  const titles = items.filter(i => i.type !== "separator").map(i => i.title);
  ok("menu exposes a settings entry", titles.some(t => /settings/i.test(t)), JSON.stringify(titles));
  ok("menu exposes dashboard + scan + export",
     titles.some(t => /dashboard/i.test(t)) && titles.some(t => /scan this page/i.test(t)) && titles.some(t => /export/i.test(t)),
     JSON.stringify(titles));
  const pauseItem = items.find(i => i.id === "prospekt_pause");
  ok("auto-scan item is a checkbox reflecting current state",
     pauseItem?.type === "checkbox" && pauseItem.checked === true, JSON.stringify(pauseItem));

  // Rebuilding must not duplicate (removeAll runs first).
  const firstCount = items.length;
  await ctxMenu.buildMenus();
  ok("rebuilding does not duplicate items", ctxMenu.chrome.contextMenus.items.length === firstCount,
     `${firstCount} -> ${ctxMenu.chrome.contextMenus.items.length}`);

  // Clicking the checkbox must persist the new value.
  lMenu.menuClick({ menuItemId: "prospekt_pause", checked: false }, { id: 1 });
  await new Promise(r => setTimeout(r, 30));
  ok("toggling auto-scan from the menu persists",
     storeMenu.prospekt_settings.autoScan === false, JSON.stringify(storeMenu.prospekt_settings));

  // ...and a change made elsewhere must sync the checkbox back.
  lMenu.menuClick({ menuItemId: "prospekt_pause", checked: true }, { id: 1 });
  await new Promise(r => setTimeout(r, 30));
  ok("re-enabling from the menu persists", storeMenu.prospekt_settings.autoScan === true);

  // Manifest must actually declare what the menu needs.
  const mf = JSON.parse(read("manifest.json"));
  ok("contextMenus permission declared", (mf.permissions || []).includes("contextMenus"),
     JSON.stringify(mf.permissions));
  ok("options_ui declared so Chrome shows a native Options entry",
     !!mf.options_ui?.page, JSON.stringify(mf.options_ui));
  ok("options page opens in a tab, not a cramped embedded panel",
     mf.options_ui?.open_in_tab === true, JSON.stringify(mf.options_ui));
  ok("options page is a file that exists", fs.existsSync(path.join(ROOT, mf.options_ui.page)));

  // ─────────────────────────────────────────────────────────────
  // 3. dashboard.js — escaping + URL safety
  // ─────────────────────────────────────────────────────────────
  section("dashboard.js — escaping + URL safety");

  const dashCtx = vm.createContext({
    console, URL, setTimeout, clearTimeout, Promise, Number, Math, Date,
    // Deliberately an http base: the earlier chrome-extension: base made
    // safeUrl's relative-resolution bug invisible, so the test passed for the
    // wrong reason. A real browser exposed it.
    location: { href: "http://localhost:8731/dashboard.html", hash: "" },
    window: { addEventListener() {} },
    document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [], querySelector: () => null },
    chrome: { runtime: { getManifest: () => ({ version: "1.1.0" }), sendMessage: () => {}, lastError: null } },
  });
  vm.runInContext(read("defaults.js"), dashCtx);
  vm.runInContext(read("dashboard.js"), dashCtx);

  const escOf = s => vm.runInContext("esc(" + JSON.stringify(s) + ")", dashCtx);
  ok("esc escapes double quotes", escOf('x" onerror="alert(1)') === "x&quot; onerror=&quot;alert(1)",
     escOf('x" onerror="alert(1)'));
  ok("esc escapes single quotes", escOf("it's") === "it&#39;s", escOf("it's"));
  ok("esc escapes angle brackets", escOf("<img>") === "&lt;img&gt;", escOf("<img>"));
  ok("esc escapes ampersand first", escOf("&lt;") === "&amp;lt;", escOf("&lt;"));
  ok("regex with a quote survives a round trip",
     escOf('href="([^"]+)"') === 'href=&quot;([^&quot;]+)&quot;', escOf('href="([^"]+)"'));

  const safe = u => vm.runInContext("safeUrl(" + JSON.stringify(u) + ")", dashCtx);
  ok("safeUrl blocks javascript:", safe("javascript:alert(1)") === "", safe("javascript:alert(1)"));
  ok("safeUrl blocks data:", safe("data:text/html,<script>") === "", safe("data:text/html,<script>"));
  ok("safeUrl allows https", safe("https://github.com/ali") === "https://github.com/ali");
  ok("safeUrl rejects a bare email value", safe("ali@acme.com") === "", safe("ali@acme.com"));
  ok("safeUrl rejects a phone number", safe("+1 (415) 555-2671") === "", safe("+1 (415) 555-2671"));
  ok("safeUrl rejects a custom SKU value", safe("SKU-9931") === "", safe("SKU-9931"));
  ok("safeUrl rejects a scheme-less domain", safe("www.example.com") === "", safe("www.example.com"));
  ok("safeUrl rejects a protocol-relative URL", safe("//evil.com/x") === "", safe("//evil.com/x"));
  ok("safeUrl rejects a root-relative path", safe("/etc/passwd") === "", safe("/etc/passwd"));
  ok("safeUrl keeps an absolute http URL", safe("http://example.com/a") === "http://example.com/a");

  // Review finding 4/5: bg() must distinguish transport failure from a null result.
  ok("failed() flags an undefined response", vm.runInContext("failed(undefined)", dashCtx) === true);
  ok("failed() flags an error envelope", vm.runInContext("failed({ok:false,error:'x'})", dashCtx) === true);
  ok("failed() passes a real settings object", vm.runInContext("failed({autoScan:true})", dashCtx) === false);
  ok("failed() passes an explicit null result", vm.runInContext("failed(null)", dashCtx) === false);

  // weekdayLabel must read the key as a LOCAL day, not UTC midnight.
  const wd = vm.runInContext('weekdayLabel("2026-08-05")', dashCtx);
  const expected = new Date(2026, 7, 5).toLocaleDateString(undefined, { weekday: "short" });
  ok("weekday label uses the local calendar day", wd === expected, `${wd} vs ${expected}`);

  // ─────────────────────────────────────────────────────────────
  // 4. Static wiring — every id dashboard.js touches must exist
  // ─────────────────────────────────────────────────────────────
  section("static wiring — DOM ids");

  const dashJs = read("dashboard.js");
  const dashHtml = read("dashboard.html");
  const staticIds = [...dashJs.matchAll(/getElementById\("([^"]+)"\)/g)].map(m => m[1]);
  const renderedIds = new Set([...dashJs.matchAll(/id="([^"${]+)"/g)].map(m => m[1]));
  const htmlIds = new Set([...dashHtml.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const templated = new Set(["pat-email-error", "pat-phone-error"]);   // built as `${id}-error`

  for (const id of new Set(staticIds)) {
    ok(`#${id} exists`, htmlIds.has(id) || renderedIds.has(id) || templated.has(id), "not found in HTML or templates");
  }

  // A hidden overlay that is still laid out swallows every click on the page.
  // .modal-scrim sets display:flex, and any author display beats the UA's
  // [hidden]{display:none} — which made the whole dashboard unresponsive.
  const css = read("dashboard.css");
  ok("[hidden] is enforced over author display rules",
     /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css),
     "no [hidden] override found");

  // Every page render must keep the URL in step, or refreshing drops you on
  // Overview regardless of where you were.
  const dashSrc = read("dashboard.js");
  ok("renderPage syncs the location hash",
     /renderPage[\s\S]{0,600}history\.replaceState/.test(dashSrc), "renderPage does not set the hash");
  ok("an export deep-link clears itself so a refresh can't re-fire it",
     /export-contacts[\s\S]{0,200}replaceState/.test(dashSrc), "export hash is not cleared");

  const cssClasses = read("dashboard.css");
  for (const cls of ["type-custom", "fav-mono", "save-bar", "table-wrap", "tone-pink", "pg-indicator", "btn-ghost"]) {
    ok(`.${cls} styled`, cssClasses.includes("." + cls));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err); process.exit(1); });
