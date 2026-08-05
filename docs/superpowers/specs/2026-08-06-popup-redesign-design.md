# Popup Redesign — Per-Page Contact Results

**Date:** 2026-08-06
**Status:** Approved
**Scope:** Popup surface only. Dashboard retheme is a follow-up.

## Problem

The popup shows global library totals (all-time emails / phones / socials) plus an
"Open Dashboard" button. It says nothing about the page you are actually looking
at, which is the moment the user cares about. The redesign makes the popup a view
onto the **active tab's most recent scan**.

## Decisions

| Question | Decision | Rationale |
|---|---|---|
| Third metadata field on each row | Reuse existing `source` (`MAILTO`/`TEL`/`TEXT`/`SCHEMA`/`LINK`) | Region detection would require rewriting extraction to be element-based. Deferred. |
| "Keeps watching while you scroll" | Implement bounded watching | Ship no copy that lies. Bounded so idle tabs stop paying for it. |
| Popup data freshness | Cached, auto-refresh when stale | No spinner on the common path; scanning state is the exception, not the norm. |
| Accent colour | Amber becomes the brand accent | Dashboard retheme follows in a separate change. |
| LIVE pill | Toggles auto-scan | Most useful control, one click, mirrors the right-click checkbox. |

## Architecture

### Per-tab scan cache

Background keeps the last result per tab in `chrome.storage.session`:

- Ephemeral, never written to disk — appropriate for page-derived content.
- Survives service-worker restarts, which an in-memory `Map` would not.
- Covered by the existing `storage` permission; no new permission.
- Key `page_<tabId>`; capped at 200 rows per tab; evicted on `tabs.onRemoved`.

### Empty scans must reach the background

Today the content script returns early when a page yields nothing, so the
background can never distinguish "scanned, found nothing" from "never scanned".

**Change:** the content script always sends `storeScan`. The background writes to
the contact library only when `total > 0` (preserving "only domains with contacts
are recorded"), but always updates the per-tab cache. This is what makes the
`empty` state real rather than inferred.

### New-vs-saved flags

`storeScan` already computes which values are novel in order to decide what to
insert, then discards that. It will now record `isNew` per hit into the cache.
No extra passes — a byproduct of the existing dedup.

### One state message

`getPageState` returns exactly one state so the popup holds no branching logic:

| State | Trigger | Renders |
|---|---|---|
| `skipped` | active domain matches `skipDomains` | Skip-list notice + Scan once / Stop skipping |
| `scanning` | scan in flight, **no cache entry at all**, cache stale (>30s), or cached URL ≠ current URL | Shimmer; see below |
| `results` | cached `total > 0` | Count block, chips, row list, actions |
| `empty` | cached `total === 0` | "No contacts on this page" + Scan again |

States are evaluated in that order — `skipped` wins over everything, `scanning`
over cached content. A first-ever visit therefore lands on `scanning`, which also
triggers the scan; the popup then re-renders when the result arrives.

`scanning` shimmers over the previous rows when a cache entry exists (so a
refresh does not blank the list), and over three placeholder skeleton rows when
it does not.

### Bounded watching

Content script gains a debounced `MutationObserver` (800 ms) that re-scans when
nodes are added, disconnecting after 60 s with no new finds. It reuses the
existing `scheduleScan(delay, force)` path — no second scan mechanism. Never
attached on skipped domains or when `autoScan` is off.

## Message API

| Action | Direction | Purpose |
|---|---|---|
| `getPageState` | popup → bg | The whole popup model for the active tab |
| `rescanTab {tabId, force}` | popup → bg | Refresh button / Scan again |
| `scanOnce {tabId}` | popup → bg | One scan on a skipped domain (`bypassSkip`) |
| `skipDomain {domain}` | popup → bg | Append to `skipDomains` |
| `unskipDomain {domain}` | popup → bg | Remove from `skipDomains` |
| `exportPage {tabId}` | popup → bg | CSV of this page's finds only, same columns as the full contacts export |

"Copy N new" needs no message — the popup already holds the rows, and writes the
new values (one per line) via `navigator.clipboard`.

The popup re-renders on results arriving by listening for the background's
`pageStateChanged` broadcast, rather than polling.

`rescan` gains a `bypassSkip` flag so `scanOnce` can bypass the skip check that
otherwise returns before scanning.

## Layout

400 px wide, 600 px max (Chrome's ceiling). Only the row list scrolls, so the
action bar stays pinned.

```
┌──────────────────────────────────────┐
│ [icon] Prospekt  1.2.0  (● LIVE) [⚙] │  52px  header
├──────────────────────────────────────┤
│ [N] northbeamlabs.com/about/team     │  56px  page context
│     Our team — Northbeam Labs        │
├──────────────────────────────────────┤
│ 7  FOUND              5 new          │  84px  count block
│    ON THIS PAGE       2 saved        │
│ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▭▭▭▭▭▭▭▭▭          │        type bar
├──────────────────────────────────────┤
│ (ALL 7)(● EMAIL 4)(● PHONE 1)…       │  40px  chips, x-scroll
├──────────────────────────────────────┤
│ ● linkedin.com/in/dana-okonkwo       │  flex  list (scrolls)
│   LINKEDIN · NEW · LINK              │
│ ○ hello@northbeamlabs.com            │
│   EMAIL · SAVED 2D AGO               │
├──────────────────────────────────────┤
│ [ Copy 5 new ] [ Export ]      [ ↻ ] │  60px  actions
├──────────────────────────────────────┤
│ 18 kept · 4 scans   Skip · Dashboard→│  40px  footer
└──────────────────────────────────────┘
```

Filled dot = new this scan; hollow = already in the library.

## Tokens

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0b0b0d` | popup background |
| `--surface` | `#17171b` | cards, rows |
| `--border` | `rgba(255,255,255,.07)` | dividers |
| `--accent` | `#e0a94a` | primary actions, domain, counts |
| `--accent-on` | `#1a1206` | text on amber fills |
| `--live` | `#34d399` | LIVE dot |
| `--email` / `--phone` / `--social` / `--custom` | `#e0a94a` / `#f0764b` / `#5b9bf5` / `#a78bfa` | type dots, chips, bar |
| `--text` / `--dim` / `--muted` | `#e9e9f0` / `#9a9aab` / `#6b6b7b` | text ramp |

Values and domains use the mono stack; meta lines are 10px uppercase with `·`
separators. No webfonts — the zero-network-calls guarantee still holds.

## Files

| File | Change |
|---|---|
| `popup.html` | Rebuilt: shell markup + styles |
| `popup.js` | Rebuilt: state fetch, four render functions, actions |
| `background.js` | Per-tab cache, `isNew` capture, new message handlers, session cleanup |
| `content.js` | Always report scans, `bypassSkip`, bounded `MutationObserver` |
| `defaults.js` | No change |

## Testing

Extends the existing harnesses rather than adding a framework.

- **Node (`verify.js`)** — `getPageState` returns the right state for each of the
  four conditions; `isNew` flags correct across first and repeat scans; cache
  evicts on tab close; skip/unskip mutate `skipDomains` correctly; empty scans
  update the cache without polluting the library.
- **Node (`verify-content.js`)** — observer fires a re-scan on DOM insertion,
  debounces bursts, disconnects when idle, never attaches on a skipped domain;
  `bypassSkip` scans a skipped domain exactly once.
- **Browser (Playwright)** — all four states render; list scrolls while actions
  stay pinned; chips filter; Copy writes the new values only; no console errors.

## Out of scope

Dashboard retheme; element-based region detection; per-contact delete from the
popup; any new permission.
