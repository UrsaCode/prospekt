# Prospekt

**Free contact intelligence — auto-extracts emails, phones, and social profiles from every page you visit.**

A full-featured, privacy-first alternative to Hunter.io ($49+/mo), Snov.io ($39+/mo), and similar paid prospecting tools. No account, no server, no limits.

---

## How It Works

1. **Install the extension** — that's it
2. **Browse normally** — Prospekt auto-scans every page in the background, including
   in-app route changes on single-page apps like LinkedIn, X and GitHub
3. **Contacts are saved automatically** with full metadata: when they were found, which URL, which domain, page title
4. **Open the Dashboard** — a full-page SPA with 5 sections, tables, charts, search, filters, and CSV export

Only domains where at least one contact was found are recorded — visiting a page with
nothing to extract leaves no trace in your library.

## Dashboard Pages

| Page | What it does |
|------|-------------|
| **Overview** | Stat cards, recent contacts table, 7-day scan activity chart |
| **Contacts** | Paginated table with type filters (All/Emails/Phones/Socials/Customs), global search, copy, open, delete per contact |
| **Scan History** | Every domain where contacts were found, with timestamps, per-type counts, delete per domain |
| **Insights** | Analytics — top domains, contact type breakdown, social platform split, custom pattern matches |
| **Settings** | Auto-scan toggle, storage limits, the full pattern editor, exports, reset & clear |

## Pattern Editor

Everything the extraction engine uses is editable in **Settings**, and saving re-scans
every open tab immediately:

- **Email / phone regex** — with a Test button that validates before you save
- **Social platform patterns** — platform ID, label, regex and regex flags per row
- **Custom patterns** — your own regexes for crypto wallets, SKUs, ticket IDs, anything.
  Flags default to `g` (case-sensitive); add `i` to ignore case. Matches are stored as
  `custom` contacts and carry their label through search, insights and CSV export.
- **Filter lists** — skip domains, junk email domains, junk email prefixes, junk social
  path segments

Invalid or half-filled rows block the save and point you at the offending field rather
than being dropped silently.

## Data Model

Every contact is stored with:
- `type` — email, phone, social, or custom
- `value` — the actual contact
- `platform` — for socials: linkedin, twitter, github, …
- `label` — for customs: the pattern that matched it
- `source` — how it was found (mailto link, tel link, body text, schema data, custom regex)
- `added_at` — ISO datetime when it was extracted
- `found_at` — `url`, `domain`, `pageTitle`, `siteName`, `favicon`
- `scanId` — links back to the scan record

Every scan is stored with:
- `id`, `added_at`, `last_scanned_at`, `scan_count`
- `found_at` — full URL, domain, path, page title, site name, favicon
- `counts` — emails, phones, socials, customs, total

## Installation

1. Download and unzip
2. `chrome://extensions/` → Enable Developer mode
3. Click "Load unpacked" → select the `prospekt` folder
4. Click the Prospekt icon → "Open Dashboard"

Requires Chrome 111+.

## File Structure

```
prospekt/
├── manifest.json      # Manifest V3
├── defaults.js        # Shared default patterns (content script + worker + dashboard)
├── background.js      # Storage, scan orchestration, export
├── content.js         # Extraction engine (auto-runs, reloads config live)
├── popup.html/.js     # Mini popup (stats + Open Dashboard)
├── dashboard.html     # Full-page dashboard SPA
├── dashboard.css      # Dashboard styles (auto light/dark)
├── dashboard.js       # Dashboard logic (5 pages, tables, charts, pattern editor)
├── icons/             # Extension icons
└── README.md
```

## Privacy

- **Zero network calls** — no webfonts, no favicon services, no analytics, no telemetry
- **No account needed** — no signup, no API keys
- Data stored only in `chrome.storage.local`
- Remote favicons are **off by default**; domains render as generated monograms so
  opening your library doesn't announce it to every site in it. You can opt in under
  Settings → Scanning.
- Minimal permissions: `storage`, `tabs`, and host access to read page content

## Storage Limits

`chrome.storage.local` is finite, so both tables are capped (Settings → Scanning):
**max stored domains** (default 5,000) and **max stored contacts** (default 20,000).
Oldest records are dropped first.

## License

MIT
