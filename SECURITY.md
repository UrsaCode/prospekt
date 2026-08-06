# Security

## Reporting a vulnerability

Please report privately rather than opening a public issue.

- GitHub → **Security** → **Report a vulnerability** (preferred), or
- security contact at [ursacode.com](https://ursacode.com)

Please include what you found, how to reproduce it, and what an attacker gets.
You'll get an acknowledgement within a few days. This is a small project run by
a small team — there is no bounty, but credit is given unless you'd rather not
have it.

## Threat model

Prospekt reads and stores content from every page you visit. That shapes what
counts as a vulnerability here.

**In scope**

- Anything that lets a visited web page influence the extension beyond being
  scanned: escaping the isolated world, code execution in the dashboard or
  popup, or reaching a privileged `chrome.*` API.
- Anything that causes data to leave the device. The extension makes no network
  requests by design; a change or bug that introduces one is a vulnerability,
  not a feature.
- Stored-XSS style issues, since scraped values (page titles, favicon URLs,
  contact values) are rendered in the dashboard. Everything interpolated into
  HTML goes through `esc()`, which escapes quotes precisely because those values
  land in attributes.
- Anything letting one site's page script read or destroy the contact library.

**Known and accepted**

- **`chrome.storage.local` is readable by content scripts.** That is how the
  content script receives its patterns, and Chrome offers no per-key access
  control. A compromised content script could therefore read or overwrite the
  library directly, without going through the extension's message router. The
  router itself is restricted — content scripts may only call `storeScan`, and
  actions that open tabs or import settings require an extension page — but that
  gate does not contain storage access, and this document would rather say so
  than imply otherwise. Moving contacts to extension-origin IndexedDB would
  close it; the trade-off has not been judged worth it, since page JavaScript
  cannot reach the isolated world without a Chrome bug and nothing here
  evaluates page-supplied code.
- **The extension reads every page you visit.** That is the product. Use the
  skip list for anything sensitive; `mail.google.com`, banking-adjacent Google
  domains and similar ship skipped by default.
- **User-supplied regexes run against page text.** A pathological pattern can
  hang the tab that is scanning. The settings tester caps at 2000 matches and
  advances past zero-length matches, but catastrophic backtracking in a
  hand-written pattern is the author's to avoid.

**Out of scope**

- Findings that require a compromised browser or a malicious extension already
  running with equal or greater permissions.
- Missing hardening headers on the dashboard page, which is a local
  `chrome-extension://` document with no remote origins involved.

## Supported versions

The latest release on `main` is supported. There are no long-term branches.
