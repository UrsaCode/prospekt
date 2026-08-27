# Prospekt — Chrome Web Store listing copy

## Status

**Version 1.3.0 submitted, awaiting review.**

| | |
|---|---|
| Item ID |  |
| Listing | https://chromewebstore.google.com/detail/prospekt/mgfppglljkglalgkociodfgmmodhhphi |
| Dashboard | https://chrome.google.com/webstore/devconsole |

The listing URL returns nothing until the item is approved. The item ID is
permanent: every future version uploads to *this* item, from the same developer
account. When it is approved, add the store link to the site and the README.

---

Everything below is ready to paste into the Developer Dashboard. Character-limited
fields show their count.

---

## 1. Extension name

**Recommended (35 / 45 characters)**

```
Prospekt: Email & Contact Extractor
```

The bare word "Prospekt" is cleaner but wins you nothing in store search, and the
category is crowded — GetProspect, Prospeo, ProspectPro and Prospector Pro all
exist. Carrying the two words people actually type is worth the loss of elegance.

**Alternatives**

| Option | Chars |
|---|---|
| `Prospekt — Contact Extractor` | 28 |
| `Prospekt: Email, Phone & Social Extractor` | 41 |
| `Prospekt` | 8 |

---

## 2. Short description

Hard limit 132 characters. This is the line under your name in search results, so
it has to carry the differentiator, not just the function.

**Recommended (117 / 132)**

```
Pulls emails, phones and social profiles off every page you visit. Saved on your device, exported as CSV. No account.
```

**Alternatives**

```
Finds emails, phones and social links on any page as you browse. Everything stays on your device. Free and open source.
```
(119 / 132)

```
Contact extraction for any website. Your own regex patterns, local storage, CSV export. No signup, no credits, no cloud.
```
(120 / 132)

---

## 3. Detailed description

```
Prospekt reads the pages you already visit and keeps the contact details it finds
— emails, phone numbers, social profiles, and anything your own patterns match.

No search box to fill in. No credits to spend. No account to create. You browse,
it collects, and everything stays on your machine.


WHAT IT DOES

• Reads every page you open and extracts contacts as you go
• Finds email addresses, phone numbers, and profiles on LinkedIn, X, GitHub,
  Instagram, YouTube, Facebook and TikTok
• Shows you what the current page gave up, before you navigate away
• Marks what's new versus what you've already saved, so nothing is counted twice
• Records where each contact came from — the page, the section, the date
• Exports everything, or any filtered slice, as CSV


WORKS ON ANY SITE

Most contact finders only work on LinkedIn, or only on pages already in a vendor's
database. Prospekt reads the text in front of you, so it works on a company's team
page, a conference speaker list, a directory, a forum thread, a PDF viewer, or an
internal tool your company built. If the text is on the page, Prospekt can catch it.


YOUR PATTERNS, YOUR RULES

Every pattern is a regular expression you can read and change:

• Edit the email and phone patterns directly
• Add or remove social platforms
• Write custom patterns for anything you like — crypto wallets, SKUs, ticket IDs,
  case numbers, VAT numbers, order references
• Test any pattern live against sample text and watch it highlight matches as you
  type, before you save it
• Filter lists for domains to skip, junk email domains, role prefixes like
  noreply@, and social URL paths that aren't real profiles


SEE WHETHER IT'S ACTUALLY WORKING

Most extraction tools give you a pile of results and no way to judge them.
Prospekt shows you:

• Hit rate — what share of the pages you browse produce a contact
• Yield per domain — which sites are worth revisiting and which are wasting scans
• Pattern health — how many matches each regex has made and when it last fired,
  so you notice a pattern that's drifted before it fills your list with junk
• Email quality — company domains versus free providers versus role addresses
• Duplicates — the same value appearing across multiple domains


PRIVACY

Prospekt has no server. There is nothing to sign up for, and no analytics.

• Every contact and scan record is stored in your browser's local storage
• Nothing is sent anywhere — not to us, not to anyone
• Remote favicons are off by default, because fetching them would tell each site
  that you're looking at your saved contacts
• A skip list keeps Prospekt out of your mail, your documents and your messages
• Clear everything at any time, from Settings

Because the data never leaves your device, you are the only one who has it — and
you're responsible for using it lawfully. Check the rules that apply to you before
contacting anyone, including GDPR, CAN-SPAM, PECR and your local equivalents.


WHO IT'S FOR

• Sales and business development, building lists from real sites rather than a
  vendor's stale database
• Recruiters sourcing from company pages, portfolios and community sites
• Researchers and journalists collecting public contact points
• Developers and analysts who want a configurable regex extractor in the browser
• Anyone who has ever copied an email address by hand, twice


FREE AND OPEN SOURCE

Prospekt is free, with no paid tier, no credit system and no upsell. The source is
public, so you can read exactly what it does with the pages you visit.


ABOUT THE DEVELOPERS

Prospekt is built and maintained by UrsaCode — a distributed software collective
working on web scraping, browser automation and full-stack product development for
clients worldwide.

We build tools like this because we need them ourselves. If you want something
similar built, or want to talk about automation and data extraction work, find us
at ursacode.com.

Website: https://ursacode.com
Questions, bugs and feature requests are welcome.
```

---

## 4. Category and language

- **Category:** Workflow & Planning
  (Productivity is more crowded; Workflow & Planning fits a collection-and-export
  tool and competes against fewer listings.)
- **Language:** English

---

## 5. Single purpose statement

Required. Keep it to one sentence — reviewers reject vague or multi-purpose answers.

```
Prospekt extracts contact information — email addresses, phone numbers, social
profile links and user-defined pattern matches — from the text of web pages the
user visits, and stores it locally so the user can review and export it.
```

---

## 6. Permission justifications

Fill one box per permission. Be concrete; generic answers cause review delays.

**storage**
```
Stores extracted contacts, scan records and user settings in local browser
storage. This is the extension's only persistence layer. No data is transmitted.
```

**contextMenus**
```
Adds a small menu on the extension's own toolbar icon — open the dashboard, scan
the current page, toggle auto-scan, open settings, export to CSV. It is attached
only to the extension's action, not to page content.
```

**host_permissions (<all_urls>)**
```
Contacts appear on arbitrary websites — company team pages, directories,
conference listings, forums — so the extension cannot know in advance which hosts
the user needs. It only reads pages the user actively opens, and the user can
exclude any domain via the skip list in Settings.
```

**tabs**
```
Reads the current tab's URL and title so each extracted contact can be attributed
to the page it came from, and so the skip list can be applied before scanning.
```

**Content scripts (host match http/https)**
```
The extension reads the visible text of pages the user opens in order to run the
extraction patterns against it. No page content is modified, and none is sent off
the device. The skip list excludes any domain the user names.
```

**Remote code**
```
No. All code is bundled in the extension package. Nothing is fetched or evaluated
at runtime.
```

---

## 7. Data usage disclosures

Answer the dashboard questionnaire honestly. Prospekt *handles* personal
information but the developer never *collects* it — that distinction matters and
is worth stating plainly in the certification notes:

- Personally identifiable information — **handled locally, not collected**
- Health, financial, authentication, personal communications, location — **no**
- Web history / user activity — **no** (scan records are local and never sent)

Certification checkboxes: you do not sell data, do not use it for purposes
unrelated to the single purpose, and do not use it for creditworthiness or lending.

**Privacy policy: required.** Even with zero transmission, Chrome requires a
policy URL for any extension handling personal information. It is live at
`https://ursacode.com/prospekt/privacy/` (mirrored at
`https://ursacode.github.io/prospekt/privacy/`) and states that no data is
transmitted, where data is stored, and how a user deletes it.

---

## 8. Search terms

Chrome indexes name, short description and detailed description. Terms already
covered above: email extractor, contact extractor, email finder, phone number
extractor, lead generation, scraper, regex, CSV export, LinkedIn, prospecting,
web scraping, contact scraper, email scraper.

Not covered — add if you want them: B2B, outreach, sourcing, recruiting,
OSINT, data extraction.

---

## 9. Support links

| Field | Value |
|---|---|
| Homepage URL | `https://ursacode.com/prospekt/` |
| Support URL | `https://ursacode.com/prospekt/support/` |
| Privacy policy | `https://ursacode.com/prospekt/privacy/` |

---

## 10. A note on positioning

The claims doing the real work here are *free*, *local-only* and *works on any
site*. Hunter, Apollo, Lusha and Snov.io are all paid, database-backed, and mostly
LinkedIn-shaped. Prospekt is none of those things, and that difference is the whole
reason someone installs it instead. Every screenshot repeats it, and so should the
listing.

Resist adding a "Pro" tier to the copy later without changing this framing — the
free-and-open-source claim is the asset.