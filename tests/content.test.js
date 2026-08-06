// Drives content.js end-to-end against a stubbed DOM + chrome.storage and
// asserts on the payload it sends to the service worker.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");

let pass = 0, fail = 0;
const NAME = "content script";
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
};
const section = t => console.log("\n== " + t + " ==");

function makePage({ text = "", links = [], url = "https://acme.com/team", patterns = null, settings = {}, failReads = 0 }) {
  const sent = [];
  const storageListeners = [];
  const messageListeners = [];
  let stored = { prospekt_patterns: patterns, prospekt_settings: settings };
  let remainingFailures = failReads;
  let currentUrl = url;
  let newContactsPerScan = 1;

  const el = (props) => ({ textContent: "", ...props });
  const anchors = links.map(href => el({ href, getAttribute: n => (n === "href" ? href : null), textContent: "" }));

  const document = {
    title: "Acme — Team",
    body: { innerText: text, innerHTML: text },
    querySelectorAll(sel) {
      if (sel === 'a[href^="mailto:"]') return anchors.filter(a => a.href.startsWith("mailto:"));
      if (sel === 'a[href^="tel:"]') return anchors.filter(a => a.href.startsWith("tel:"));
      if (sel === "a[href]") return anchors.filter(a => /^https?:/.test(a.href));
      return [];
    },
    querySelector() { return null; },
  };

  const chromeStub = {
    runtime: {
      lastError: null,
      // The content script uses the response to decide whether to keep watching.
      sendMessage: (msg, cb) => {
        sent.push(msg);
        cb && cb({ ok: true, newContacts: newContactsPerScan });
      },
      onMessage: { addListener: fn => messageListeners.push(fn) },
    },
    storage: {
      local: {
        get: (keys, cb) => {
          // Chrome scopes lastError to a single callback invocation; reset it at
          // the start of every call so a synchronous retry sees a clean slate.
          chromeStub.runtime.lastError = null;
          if (remainingFailures > 0) {
            remainingFailures--;
            chromeStub.runtime.lastError = { message: "simulated storage failure" };
            cb(undefined);
            chromeStub.runtime.lastError = null;
            return;
          }
          cb({ ...stored });
        },
      },
      onChanged: { addListener: fn => storageListeners.push(fn) },
    },
  };

  // Records observers so tests can drive mutations and assert on disconnection.
  const observers = [];
  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; this.connected = false; this.opts = null; observers.push(this); }
    observe(target, opts) { this.connected = true; this.target = target; this.opts = opts; }
    disconnect() { this.connected = false; }
  }

  // Short timers (scan scheduling, debounce) fire synchronously so tests stay
  // simple. Long ones (the 60s watch expiry) are held, or the observer would
  // disconnect the instant it attached — an artefact of the stub, not the code.
  const LONG_MS = 2000;
  const longTimers = new Map();
  let timerId = 1;

  const ctx = vm.createContext({
    console, URL, Promise, Date, Math, JSON,
    MutationObserver: FakeMutationObserver,
    setTimeout: (fn, ms = 0) => {
      if (ms < LONG_MS) { fn(); return 0; }
      const id = timerId++;
      longTimers.set(id, fn);
      return id;
    },
    clearTimeout: id => { longTimers.delete(id); },
    document,
    get window() { return { location: new URL(currentUrl) }; },
    get location() { return new URL(currentUrl); },
    chrome: chromeStub,
  });
  ctx.globalThis = ctx;

  vm.runInContext(read("defaults.js"), ctx);
  vm.runInContext(read("content.js"), ctx);

  return {
    sent,
    lastScan: () => sent.filter(m => m.action === "storeScan").pop(),
    updatePatterns(next) {
      stored.prospekt_patterns = next;
      storageListeners.forEach(fn => fn({ prospekt_patterns: { newValue: next } }, "local"));
    },
    // Simulates a same-document navigation: the content script stays loaded,
    // only the URL changes.
    navigate(nextUrl) { currentUrl = nextUrl; },
    // Simulates the worker's tabs.onUpdated nudge.
    rescan(extra = {}) { messageListeners.forEach(fn => fn({ action: "rescan", ...extra }, {}, () => {})); },
    observers,
    watching: () => observers.some(o => o.connected),
    // Runs the pending long timers, i.e. fast-forwards past the idle window.
    advanceIdle() {
      const pending = [...longTimers.values()];
      longTimers.clear();
      pending.forEach(fn => fn());
    },
    // Simulate lazy-loaded content arriving.
    mutate(addedCount = 1) {
      observers.filter(o => o.connected).forEach(o =>
        o.cb([{ addedNodes: new Array(addedCount).fill({}) }], o));
    },
    // Attribute-only churn must not trigger a scan.
    mutateAttributesOnly() {
      observers.filter(o => o.connected).forEach(o => o.cb([{ addedNodes: [] }], o));
    },
    setText(next) { document.body.innerText = next; document.body.innerHTML = next; },
  };
}

// ─────────────────────────────────────────────────────────────
section("content.js — baseline extraction");

const base = makePage({
  text: "Reach us at ali@acme.com or call +1 (415) 555-2671. Order 1234567 shipped 2024-01-15.",
  links: ["mailto:ali@acme.com", "https://github.com/ali", "https://github.com/helpdesk-org", "https://github.com/help"],
});
const scan = base.lastScan();
ok("a scan was sent", !!scan, JSON.stringify(base.sent));
ok("email extracted", scan.data.emails.some(e => e.value === "ali@acme.com"), JSON.stringify(scan.data.emails));
ok("real phone extracted", scan.data.phones.length === 1, JSON.stringify(scan.data.phones));
ok("order number is NOT a phone", !scan.data.phones.some(p => p.value.includes("1234567")), JSON.stringify(scan.data.phones));
ok("date is NOT a phone", !scan.data.phones.some(p => p.value.includes("2024")), JSON.stringify(scan.data.phones));

const socials = scan.data.socials.map(s => s.value);
ok("real profile kept", socials.includes("https://github.com/ali"), JSON.stringify(socials));
ok("junk path /help rejected", !socials.includes("https://github.com/help"), JSON.stringify(socials));
// v1 used a substring test, so "/help" also killed this legitimate org.
ok("substring lookalike /helpdesk-org kept", socials.includes("https://github.com/helpdesk-org"), JSON.stringify(socials));

// ─────────────────────────────────────────────────────────────
section("content.js — custom patterns");

const withCustom = makePage({
  text: "Ref SKU-9931 and sku-0001 in stock.",
  patterns: { customPatterns: [{ label: "SKUs", regex: "SKU-\\d{4}", flags: "g" }] },
});
const cs = withCustom.lastScan();
ok("custom pattern produces a match", cs.data.customs.length === 1, JSON.stringify(cs.data.customs));
ok("custom match carries its label", cs.data.customs[0]?.label === "SKUs", JSON.stringify(cs.data.customs[0]));
// v1 hardcoded the "i" flag, which broke case-sensitive patterns.
ok("flags are respected — lowercase not matched with /g",
   !cs.data.customs.some(c => c.value === "sku-0001"), JSON.stringify(cs.data.customs));

const withCustomI = makePage({
  text: "Ref SKU-9931 and sku-0001 in stock.",
  patterns: { customPatterns: [{ label: "SKUs", regex: "SKU-\\d{4}", flags: "gi" }] },
});
ok("adding the i flag matches both", withCustomI.lastScan().data.customs.length === 2,
   JSON.stringify(withCustomI.lastScan().data.customs));

ok("total includes customs", cs.data.totalContacts ===
   cs.data.emails.length + cs.data.phones.length + cs.data.socials.length + cs.data.customs.length);

// ─────────────────────────────────────────────────────────────
section("content.js — live pattern updates (the headline bug)");

const live = makePage({ text: "Wallet 0xAbC1234567890123456789012345678901234567 here." });
const before = live.lastScan();
ok("no custom matches before the pattern is added",
   !before || before.data.customs.length === 0, JSON.stringify(before?.data.customs));

const scansBefore = live.sent.filter(m => m.action === "storeScan").length;
live.updatePatterns({ customPatterns: [{ label: "Wallets", regex: "0x[a-fA-F0-9]{40}", flags: "g" }] });
const scansAfter = live.sent.filter(m => m.action === "storeScan").length;

// v1 read patterns once at document_idle and never again, so saving in the
// dashboard did nothing to already-open tabs.
ok("saving patterns triggers a re-scan in an open tab", scansAfter > scansBefore,
   `${scansBefore} -> ${scansAfter}`);
ok("the new custom pattern now matches", live.lastScan()?.data.customs.length === 1,
   JSON.stringify(live.lastScan()?.data.customs));

// ─────────────────────────────────────────────────────────────
section("content.js — settings + skip list");

const paused = makePage({ text: "ali@acme.com", settings: { autoScan: false } });
ok("autoScan:false sends nothing", paused.sent.length === 0, JSON.stringify(paused.sent));

const skipped = makePage({ text: "ali@acme.com", url: "https://mail.google.com/inbox" });
ok("skip-listed domain sends nothing", skipped.sent.length === 0, JSON.stringify(skipped.sent));

const subdomain = makePage({ text: "ali@acme.com", url: "https://foo.discord.com/x" });
ok("skip list covers subdomains", subdomain.sent.length === 0, JSON.stringify(subdomain.sent));

// Empty pages used to send clearBadge and nothing else, which left the
// background unable to distinguish "found nothing" from "never scanned". They
// now report a real scan with a zero total; the badge is cleared from that.
const empty = makePage({ text: "nothing interesting here at all" });
const emptyReport = empty.sent.filter(m => m.action === "storeScan");
ok("page with no contacts reports a zero-total scan",
   emptyReport.length === 1 && emptyReport[0].data.totalContacts === 0,
   JSON.stringify(empty.sent.map(m => m.action)));
ok("no stale clearBadge message remains",
   !empty.sent.some(m => m.action === "clearBadge"), JSON.stringify(empty.sent.map(m => m.action)));

// ─────────────────────────────────────────────────────────────
section("content.js — malformed patterns (review finding 2)");

// An uncompilable pattern must be DROPPED. new RegExp(undefined) is /(?:)/,
// which matches the empty string at every position — it does not throw, so a
// naive fallback silently turned a bad pattern into a match-everything one.
const badCustom = makePage({
  text: "some ordinary page text here",
  patterns: { customPatterns: [{ label: "Broken", regex: "(unclosed[", flags: "g" }] },
});
const bc = badCustom.lastScan();
ok("invalid custom regex yields no matches at all", !bc || bc.data.customs.length === 0,
   JSON.stringify(bc?.data.customs?.slice(0, 3)));

const badFlags = makePage({
  text: "some ordinary page text here",
  patterns: { customPatterns: [{ label: "BadFlags", regex: "text", flags: "zzz" }] },
});
const bf = badFlags.lastScan();
ok("invalid flags drop the pattern rather than matching everything",
   !bf || bf.data.customs.length === 0, JSON.stringify(bf?.data.customs?.slice(0, 3)));

const badSocial = makePage({
  text: "hello",
  links: ["https://github.com/ali"],
  patterns: { socialPatterns: [{ platform: "broken", label: "Broken", regex: "(((", flags: "gi" }] },
});
const bs = badSocial.lastScan();
ok("invalid social regex produces no empty-string contacts",
   !bs || !bs.data.socials.some(s => s.value === ""), JSON.stringify(bs?.data.socials?.slice(0, 3)));

// ─────────────────────────────────────────────────────────────
section("content.js — SPA route changes (review finding 7)");

const spa = makePage({ text: "Contact ali@acme.com", url: "https://linkedin.com/in/ali" });
const firstCount = spa.sent.filter(m => m.action === "storeScan").length;
ok("initial route scanned", firstCount === 1, String(firstCount));

// A rescan nudge for the SAME url must be a no-op...
spa.rescan();
ok("same-URL rescan is a no-op", spa.sent.filter(m => m.action === "storeScan").length === firstCount,
   String(spa.sent.filter(m => m.action === "storeScan").length));

// ...but after a same-document navigation it must scan the new route.
spa.navigate("https://linkedin.com/in/someone-else");
spa.rescan();
const afterNav = spa.sent.filter(m => m.action === "storeScan");
ok("new SPA route is scanned", afterNav.length === firstCount + 1, String(afterNav.length));
ok("the new route's URL is what got reported",
   afterNav.at(-1).data.meta.url === "https://linkedin.com/in/someone-else",
   afterNav.at(-1).data.meta.url);

// ─────────────────────────────────────────────────────────────
section("content.js — storage read failure (review finding 6)");

const flaky = makePage({ text: "Contact ali@acme.com", failReads: 1 });
ok("a transient storage error is retried, not swallowed",
   flaky.sent.filter(m => m.action === "storeScan").length === 1,
   JSON.stringify(flaky.sent.map(m => m.action)));

// ─────────────────────────────────────────────────────────────
section("content.js — empty scans are reported");

const nothing = makePage({ text: "nothing of interest whatsoever" });
const emptyScan = nothing.sent.filter(m => m.action === "storeScan");
// The background cannot tell "found nothing" from "never scanned" unless the
// empty result is reported, and the popup's empty state depends on that.
ok("a page with no contacts still reports a scan", emptyScan.length === 1,
   JSON.stringify(nothing.sent.map(m => m.action)));
ok("the empty report carries a zero total", emptyScan[0]?.data.totalContacts === 0,
   String(emptyScan[0]?.data.totalContacts));

// ─────────────────────────────────────────────────────────────
section("content.js — bounded DOM watching");

const watched = makePage({ text: "Contact ali@acme.com" });
ok("observer attaches on a normal page", watched.watching(), "not observing");

const wBefore = watched.sent.filter(m => m.action === "storeScan").length;
watched.setText("Contact ali@acme.com and later sam@acme.com");
watched.mutate(3);
const wAfter = watched.sent.filter(m => m.action === "storeScan").length;
ok("added nodes trigger a re-scan", wAfter > wBefore, `${wBefore} -> ${wAfter}`);
ok("the re-scan picks up newly revealed contacts",
   watched.lastScan().data.emails.some(e => e.value === "sam@acme.com"),
   JSON.stringify(watched.lastScan().data.emails.map(e => e.value)));

const beforeAttr = watched.sent.filter(m => m.action === "storeScan").length;
watched.mutateAttributesOnly();
ok("attribute-only churn does not re-scan",
   watched.sent.filter(m => m.action === "storeScan").length === beforeAttr,
   "scanned on attribute mutation");

// The whole point of "bounded": it must eventually let go.
const idle = makePage({ text: "Contact ali@acme.com" });
ok("observer is attached while the page is active", idle.watching());
idle.advanceIdle();
ok("observer disconnects after the idle window", !idle.watching(), "still observing after idle");
const afterIdle = idle.sent.filter(m => m.action === "storeScan").length;
idle.mutate(2);
ok("mutations after disconnect do not re-scan",
   idle.sent.filter(m => m.action === "storeScan").length === afterIdle,
   "scanned after disconnect");

// Skipped domains and paused scanning must never attach an observer.
const watchedSkip = makePage({ text: "ali@acme.com", url: "https://discord.com/channels/1" });
ok("no observer on a skip-listed domain", !watchedSkip.watching(), "observing a skipped domain");

const watchedPaused = makePage({ text: "ali@acme.com", settings: { autoScan: false } });
ok("no observer while auto-scan is paused", !watchedPaused.watching(), "observing while paused");

// ─────────────────────────────────────────────────────────────
section("content.js — explicit scan overrides");

// "Scan this page once" must work on a skipped domain...
const once = makePage({ text: "Contact ali@acme.com", url: "https://discord.com/x" });
ok("skipped domain scans nothing by default",
   once.sent.filter(m => m.action === "storeScan").length === 0,
   JSON.stringify(once.sent.map(m => m.action)));
once.rescan({ force: true, bypass: true, bypassSkip: true });
ok("bypassSkip scans a skip-listed page on request",
   once.sent.filter(m => m.action === "storeScan").length === 1,
   JSON.stringify(once.sent.map(m => m.action)));
ok("the bypass flag reaches the background",
   once.lastScan()?.data.bypass === true, JSON.stringify(once.lastScan()?.data.bypass));

// ...and with auto-scan paused.
const pausedOnce = makePage({ text: "Contact ali@acme.com", settings: { autoScan: false } });
ok("paused means no automatic scan",
   pausedOnce.sent.filter(m => m.action === "storeScan").length === 0);
pausedOnce.rescan({ force: true, bypass: true });
ok("an explicit scan still runs while paused",
   pausedOnce.sent.filter(m => m.action === "storeScan").length === 1,
   JSON.stringify(pausedOnce.sent.map(m => m.action)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
