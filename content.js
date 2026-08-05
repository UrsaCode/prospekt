// Prospekt — Content Script
// Auto-scans every page using user-configurable patterns loaded from storage.
// Re-reads its config live, so saving patterns in the dashboard takes effect in
// already-open tabs instead of only on the next navigation.

(() => {
  if (globalThis.__prospektInjected) return;
  globalThis.__prospektInjected = true;

  const { DEFAULTS, STORAGE_KEYS, resolvePatterns } = PROSPEKT;

  const href = () => window.location.href;
  const hostname = () => window.location.hostname;

  let compiled = null;        // active config
  let scanTimer = null;
  let lastScannedUrl = null;  // lets SPA route re-scans skip no-op repeats

  // ── Config ────────────────────────────────────────────────────────────
  function compileRegex(source, flags, fallbackSource, fallbackFlags) {
    try {
      return new RegExp(source, flags);
    } catch { /* fall through */ }
    // No fallback means "drop this pattern". Passing undefined on to RegExp
    // would NOT throw — new RegExp(undefined) is /(?:)/, which matches the
    // empty string at every position and floods the results with blanks.
    if (fallbackSource === undefined || fallbackSource === null) return null;
    try { return new RegExp(fallbackSource, fallbackFlags); } catch { return null; }
  }

  function compile(storedPatterns, storedSettings) {
    const P = resolvePatterns(storedPatterns);
    const S = { ...PROSPEKT.DEFAULT_SETTINGS, ...(storedSettings || {}) };

    const socials = [];
    for (const sp of P.socialPatterns || []) {
      if (!sp || !sp.regex) continue;
      const re = compileRegex(sp.regex, sp.flags || "gi");
      if (re) socials.push({ platform: sp.platform || "other", label: sp.label || sp.platform || "Other", re });
    }

    const customs = [];
    for (const cp of P.customPatterns || []) {
      if (!cp || !cp.regex || !cp.label) continue;
      // Default to case-SENSITIVE. Forcing "i" broke case-sensitive patterns
      // such as base58 wallet addresses and SKUs.
      const re = compileRegex(cp.regex, cp.flags || "g");
      if (re) customs.push({ label: cp.label, re });
    }

    return {
      settings: S,
      skipDomains: P.skipDomains || [],
      junkEmailDomains: P.junkEmailDomains || [],
      junkEmailPrefixes: P.junkEmailPrefixes || [],
      junkSocialPaths: P.junkSocialPaths || [],
      emailRe: compileRegex(P.emailRegex, P.emailFlags || "gi", DEFAULTS.emailRegex, DEFAULTS.emailFlags),
      phoneRe: compileRegex(P.phoneRegex, P.phoneFlags || "g", DEFAULTS.phoneRegex, DEFAULTS.phoneFlags),
      socials,
      customs,
    };
  }

  function isSkipped(cfg) {
    const h = hostname().toLowerCase();
    const u = href().toLowerCase();
    return (cfg.skipDomains || []).some(raw => {
      const s = String(raw || "").toLowerCase().trim();
      if (!s) return false;
      if (s.includes("://") || s.endsWith(":")) return u.startsWith(s);
      return h === s || h.endsWith("." + s);
    });
  }

  // ── Filters ───────────────────────────────────────────────────────────
  function isJunkEmail(cfg, email) {
    const l = email.toLowerCase();
    const at = l.lastIndexOf("@");
    if (at < 1) return true;
    const local = l.slice(0, at);
    const domain = l.slice(at + 1);
    if (l.length > 60) return true;
    if (cfg.junkEmailDomains.some(d => domain === String(d).toLowerCase())) return true;
    if (cfg.junkEmailPrefixes.some(p => local === String(p).toLowerCase())) return true;
    if (/\.(png|jpe?g|gif|svg|webp|css|js|mjs|woff2?|ttf|eot|ico)$/i.test(l)) return true;
    // "2x@1x.png"-style asset descriptors and version strings.
    if (/^\d+(\.\d+)*$/.test(local)) return true;
    return false;
  }

  function isJunkSocial(cfg, url) {
    let path;
    try { path = new URL(url).pathname.toLowerCase(); }
    catch { return false; }
    if (path === "/" || path === "") return true;   // bare platform homepage
    return cfg.junkSocialPaths.some(raw => {
      const seg = "/" + String(raw || "").toLowerCase().replace(/^\/+|\/+$/g, "");
      if (seg === "/") return false;
      return path === seg || path.startsWith(seg + "/");
    });
  }

  function isValidPhone(raw) {
    const text = String(raw).trim();
    const digits = text.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) return false;
    if (/^(\d)\1+$/.test(digits)) return false;                                  // 0000000
    if (/^(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(text)) return false;      // 2024-01-15
    if (/^\d{1,2}[-/.]\d{1,2}[-/.](?:19|20)\d{2}$/.test(text)) return false;      // 15-01-2024
    if (/^\d+(\.\d+){2,}$/.test(text)) return false;                             // 1.2.3.4 versions/IPs
    return true;
  }

  // ── Extractors ────────────────────────────────────────────────────────
  function bodyText() {
    return document.body ? document.body.innerText || "" : "";
  }

  function matchAll(re, text) {
    if (!re || !text) return [];
    // Never mutate the shared regex's lastIndex across calls.
    const scoped = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    return text.match(scoped) || [];
  }

  function extractEmails(cfg) {
    const seen = new Set();
    const results = [];
    const push = (value, source, context) => {
      const key = value.toLowerCase();
      if (seen.has(key) || isJunkEmail(cfg, key)) return;
      seen.add(key);
      results.push({ value: key, source, context: context || null });
    };

    document.querySelectorAll('a[href^="mailto:"]').forEach(a => {
      const raw = (a.getAttribute("href") || "").slice(7).split("?")[0].trim();
      let decoded = raw;
      try { decoded = decodeURIComponent(raw); } catch { /* keep raw */ }
      // A single mailto: may carry a comma-separated list.
      decoded.split(",").forEach(part => {
        const e = part.trim();
        if (e) push(e, "mailto", (a.textContent || "").trim().slice(0, 80));
      });
    });

    matchAll(cfg.emailRe, bodyText()).forEach(e => push(e.trim(), "text", null));

    document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
      let parsed;
      try { parsed = JSON.parse(script.textContent); } catch { return; }
      const seenNodes = new WeakSet();
      const walk = node => {
        if (!node || typeof node !== "object") return;
        if (seenNodes.has(node)) return;   // guard against cyclic structures
        seenNodes.add(node);
        if (typeof node.email === "string") {
          push(node.email.replace(/^mailto:/i, "").trim(), "schema", node.name || null);
        }
        for (const v of Object.values(node)) {
          if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === "object") walk(v);
        }
      };
      walk(parsed);
    });

    return results;
  }

  function extractPhones(cfg) {
    const seen = new Set();
    const results = [];
    const push = (value, source, context) => {
      const digits = value.replace(/\D/g, "");
      if (seen.has(digits) || !isValidPhone(value)) return;
      seen.add(digits);
      results.push({ value: value.trim(), source, context: context || null });
    };

    document.querySelectorAll('a[href^="tel:"]').forEach(a => {
      const p = (a.getAttribute("href") || "").slice(4).trim();
      if (p) push(p, "tel", (a.textContent || "").trim().slice(0, 80));
    });

    matchAll(cfg.phoneRe, bodyText()).forEach(p => push(p, "text", null));
    return results;
  }

  function extractSocials(cfg) {
    const seen = new Set();
    const results = [];
    // Anchor hrefs plus visible text. Scanning document.body.innerHTML (as v1
    // did) serialises the whole DOM on every page and matches URLs buried in
    // inline scripts, analytics payloads and CSS.
    const haystack = [...document.querySelectorAll("a[href]")]
      .map(a => a.href)
      .concat(bodyText().split(/\s+/).filter(w => w.includes("://")));

    const joined = haystack.join("\n");

    cfg.socials.forEach(pat => {
      matchAll(pat.re, joined).forEach(url => {
        const trimmed = url.replace(/\/+$/, "");
        const key = trimmed.toLowerCase();
        if (seen.has(key) || isJunkSocial(cfg, trimmed)) return;
        seen.add(key);
        results.push({ value: trimmed, platform: pat.platform, label: pat.label });
      });
    });

    return results;
  }

  function extractCustom(cfg) {
    if (!cfg.customs.length) return [];
    const seen = new Set();
    const results = [];
    const text = bodyText();
    cfg.customs.forEach(cp => {
      matchAll(cp.re, text).forEach(raw => {
        const value = raw.trim();
        if (!value) return;
        const key = cp.label + " " + value.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        results.push({ value, type: "custom", label: cp.label, source: "custom_regex" });
      });
    });
    return results;
  }

  function extractMeta() {
    const host = hostname();
    const meta = {};
    meta.siteName = document.querySelector('meta[property="og:site_name"]')?.content || null;
    meta.pageTitle = document.title || null;

    const desc = document.querySelector('meta[name="description"]')
      || document.querySelector('meta[property="og:description"]');
    meta.description = desc?.content?.slice(0, 200) || null;

    const icon = document.querySelector('link[rel~="icon"]');
    // Only keep same-scheme http(s) icons; javascript:/data: hrefs are dropped.
    let favicon = null;
    if (icon?.href) {
      try {
        const u = new URL(icon.href, location.href);
        if (u.protocol === "http:" || u.protocol === "https:") favicon = u.href;
      } catch { /* ignore */ }
    }
    meta.favicon = favicon;
    meta.domain = host.replace(/^www\./, "");
    meta.url = location.href;
    meta.path = location.pathname;

    if (!meta.siteName) {
      document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
        if (meta.siteName) return;
        try {
          const d = JSON.parse(s.textContent);
          const name = Array.isArray(d) ? d.find(x => x?.name)?.name : d?.name;
          if (typeof name === "string") meta.siteName = name.slice(0, 120);
        } catch { /* ignore */ }
      });
    }
    if (!meta.siteName) {
      const base = meta.domain.split(".")[0] || meta.domain;
      meta.siteName = base.charAt(0).toUpperCase() + base.slice(1);
    }
    return meta;
  }

  function detectEmailPattern(emails, domain) {
    const locals = emails
      .filter(e => e.value.endsWith("@" + domain))
      .map(e => e.value.split("@")[0]);
    if (!locals.length) return null;
    if (locals.some(e => /^[a-z]+\.[a-z]+$/.test(e))) return "first.last";
    if (locals.some(e => /^[a-z]\.[a-z]+$/.test(e))) return "f.last";
    if (locals.some(e => /^[a-z]+_[a-z]+$/.test(e))) return "first_last";
    if (locals.some(e => /^[a-z]+$/.test(e))) return "first";
    return "custom";
  }

  // ── Run ───────────────────────────────────────────────────────────────
  function collect(cfg) {
    const emails = extractEmails(cfg);
    const phones = extractPhones(cfg);
    const socials = extractSocials(cfg);
    const customs = extractCustom(cfg);
    const meta = extractMeta();
    return {
      emails, phones, socials, customs, meta,
      emailPattern: detectEmailPattern(emails, meta.domain),
      totalContacts: emails.length + phones.length + socials.length + customs.length,
    };
  }

  function send(message) {
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch {
      // Extension was reloaded/updated — this frame's context is dead.
    }
  }

  function scan(force) {
    if (!compiled || compiled.settings.autoScan === false) return;
    if (isSkipped(compiled)) return;
    // A same-document navigation that didn't actually change the URL (or a
    // duplicate rescan nudge) is not worth re-walking the DOM for.
    if (!force && lastScannedUrl === href()) return;
    lastScannedUrl = href();

    let payload;
    try { payload = collect(compiled); }
    catch (err) { console.warn("[Prospekt] scan failed:", err); return; }

    if (payload.totalContacts === 0) {
      send({ action: "clearBadge" });   // don't leave the previous page's count
      return;
    }
    send({ action: "storeScan", data: payload });
  }

  // Always invokes `then`, with an error if the read failed. Returning early on
  // lastError left the initial scan unscheduled for the tab's whole lifetime
  // and hung manualScan's response channel open until it timed out.
  function loadConfig(then, attempt = 0) {
    chrome.storage.local.get([STORAGE_KEYS.PATTERNS, STORAGE_KEYS.SETTINGS], data => {
      const err = chrome.runtime.lastError;
      if (err) {
        if (attempt < 2) {
          setTimeout(() => loadConfig(then, attempt + 1), 400 * (attempt + 1));
          return;
        }
        if (then) then(new Error(err.message));
        return;
      }
      compiled = compile(data[STORAGE_KEYS.PATTERNS], data[STORAGE_KEYS.SETTINGS]);
      if (then) then(null);
    });
  }

  function scheduleScan(delay, force) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scan(force), delay);
  }

  loadConfig(err => { if (!err) scheduleScan(1500, true); });

  // Live config updates: a pattern saved in the dashboard re-scans open tabs.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes[STORAGE_KEYS.PATTERNS] && !changes[STORAGE_KEYS.SETTINGS]) return;
    loadConfig(err => { if (!err) scheduleScan(200, true); });   // patterns changed — force
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.action === "manualScan") {
      loadConfig(err => {
        if (err || !compiled) return sendResponse({ error: err ? err.message : "config unavailable" });
        try { sendResponse(collect(compiled)); }
        catch (e) { sendResponse({ error: String(e?.message || e) }); }
      });
      return true;   // async response
    }
    if (msg?.action === "rescan") {
      // Unforced nudges (the navigation hook) skip a same-URL repeat so a full
      // page load isn't scanned twice. msg.force means the user asked for it
      // explicitly via the context menu, so always re-scan.
      loadConfig(err => {
        if (!err) scheduleScan(msg.force ? 0 : 600, !!msg.force);
        sendResponse({ ok: !err });
      });
      return true;   // async response
    }
    return false;    // let other listeners respond
  });
})();
