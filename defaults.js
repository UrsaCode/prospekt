// Prospekt — Shared defaults
//
// Single source of truth for extraction patterns. Loaded by the content script,
// the service worker (via importScripts) and the dashboard (via <script>), so the
// three can never drift out of sync.

globalThis.PROSPEKT = globalThis.PROSPEKT || {};

// Bump when DEFAULTS change in a way existing users should inherit.
PROSPEKT.PATTERNS_VERSION = 3;

PROSPEKT.STORAGE_KEYS = {
  SCANS: "prospekt_scans",
  CONTACTS: "prospekt_contacts",
  SETTINGS: "prospekt_settings",
  PATTERNS: "prospekt_patterns",
};

PROSPEKT.DEFAULT_SETTINGS = {
  autoScan: true,
  maxScans: 5000,
  maxContacts: 20000,
  remoteFavicons: false,
};

PROSPEKT.DEFAULTS = {
  _v: PROSPEKT.PATTERNS_VERSION,

  emailRegex: String.raw`\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b`,
  emailFlags: "gi",

  // Requires at least one separator between digit groups, so it does not match
  // bare runs of digits (prices, order numbers, ISBNs, timestamps).
  // The separator class is HORIZONTAL whitespace only. Using \s here let the
  // pattern span the newlines innerText inserts between blocks, so unrelated
  // numbers in adjacent table cells fused into one bogus "phone".
  phoneRegex: String.raw`(?<!\d)(?:\+\d{1,3}[ \t\u00a0.\-]?)?(?:\(\d{2,5}\)|\d{2,5})(?:[ \t\u00a0.\-]\d{2,5}){1,4}(?!\d)`,
  phoneFlags: "g",

  socialPatterns: [
    { platform: "linkedin",  label: "LinkedIn",    flags: "gi", regex: String.raw`https?://(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com/(?:in|company)/[A-Za-z0-9_\-%.]+/?` },
    { platform: "twitter",   label: "X / Twitter", flags: "gi", regex: String.raw`https?://(?:www\.)?(?:twitter\.com|x\.com)/[A-Za-z0-9_]{1,15}/?` },
    { platform: "github",    label: "GitHub",      flags: "gi", regex: String.raw`https?://(?:www\.)?github\.com/[A-Za-z0-9](?:[A-Za-z0-9\-]{0,37}[A-Za-z0-9])?/?` },
    { platform: "facebook",  label: "Facebook",    flags: "gi", regex: String.raw`https?://(?:www\.|web\.|m\.)?facebook\.com/[A-Za-z0-9._\-]+/?` },
    { platform: "instagram", label: "Instagram",   flags: "gi", regex: String.raw`https?://(?:www\.)?instagram\.com/[A-Za-z0-9._]+/?` },
    { platform: "youtube",   label: "YouTube",     flags: "gi", regex: String.raw`https?://(?:www\.)?youtube\.com/(?:@|c/|channel/|user/)[A-Za-z0-9_\-]+/?` },
    { platform: "tiktok",    label: "TikTok",      flags: "gi", regex: String.raw`https?://(?:www\.)?tiktok\.com/@[A-Za-z0-9._]+/?` },
  ],

  customPatterns: [],

  skipDomains: [
    "chrome.google.com", "chromewebstore.google.com",
    "chrome://", "about:", "chrome-extension://",
    "localhost", "127.0.0.1",
    "mail.google.com", "docs.google.com", "drive.google.com",
    "accounts.google.com", "myaccount.google.com",
    "web.whatsapp.com", "discord.com",
  ],

  junkEmailDomains: [
    "example.com", "example.org", "test.com", "localhost", "sentry.io", "wixpress.com",
    "w3.org", "schema.org", "googleapis.com", "gravatar.com", "wordpress.org",
    "jquery.com", "placeholder.com", "yoursite.com", "yourdomain.com",
    "email.com", "domain.com", "company.com",
  ],

  junkEmailPrefixes: [
    "noreply", "no-reply", "donotreply", "do-not-reply",
    "mailer-daemon", "postmaster", "webmaster", "hostmaster", "abuse",
  ],

  // Matched against the URL path as whole segments, so "/help" no longer
  // rejects "github.com/helpdesk-org".
  junkSocialPaths: [
    "/share", "/sharer", "/intent", "/widgets", "/login", "/signup", "/settings",
    "/policies", "/help", "/about", "/legal", "/privacy", "/terms", "/search",
    "/explore", "/hashtag", "/home", "/i", "/notifications", "/messages",
    "/features", "/pricing", "/marketplace", "/topics", "/trending", "/sponsors",
    "/collections", "/events", "/jobs", "/watch", "/reel", "/stories", "/p", "/tv",
    "/groups", "/pages", "/feed", "/dashboard",
  ],
};

// Values shipped by earlier versions. Used to detect fields the user never
// customised so an upgrade can hand them the improved default without
// clobbering real edits. Newest-first within each list.
PROSPEKT.LEGACY_DEFAULTS = {
  emailRegex: [String.raw`\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b`],
  phoneRegex: [
    // v1.1.0 — separator class used \s, which spanned the newlines innerText
    // inserts between blocks and fused unrelated numbers into fake phones.
    String.raw`(?<!\d)(?:\+\d{1,3}[\s.\-]?)?(?:\(\d{2,5}\)|\d{2,5})(?:[\s.\-]\d{2,5}){1,4}(?!\d)`,
    // v1.0.0 — matched any run of 7+ digits.
    String.raw`(?:\+?\d{1,4}[\s\-.]?)?\(?\d{1,4}\)?[\s\-.]?\d{1,4}[\s\-.]?\d{1,9}`,
  ],
};

PROSPEKT.clone = value => JSON.parse(JSON.stringify(value));

/**
 * Whether a URL is on the skip list. Shared by the content script (which must
 * not scan) and the background (which must tell the popup why it didn't), so
 * the two can never disagree about what "skipped" means.
 */
PROSPEKT.isSkipped = (url, skipDomains) => {
  let host = "";
  let full = String(url || "").toLowerCase();
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* non-URL */ }
  return (skipDomains || []).some(raw => {
    const s = String(raw || "").toLowerCase().trim();
    if (!s) return false;
    if (s.includes("://") || s.endsWith(":")) return full.startsWith(s);
    return host === s || host.endsWith("." + s);
  });
};

/**
 * Merge stored patterns over the defaults. Missing keys fall back to defaults;
 * an explicitly emptied list stays empty (an empty array is a valid choice).
 */
PROSPEKT.resolvePatterns = stored => {
  const out = PROSPEKT.clone(PROSPEKT.DEFAULTS);
  if (!stored || typeof stored !== "object") return out;
  for (const key of Object.keys(out)) {
    if (stored[key] !== undefined && stored[key] !== null) out[key] = stored[key];
  }
  out._v = stored._v || 1;
  return out;
};
