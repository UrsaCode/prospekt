# Contributing

Thanks for taking a look. This is a small, dependency-free codebase and the aim
is to keep it that way.

## Getting set up

```bash
git clone https://github.com/UrsaCode/prospekt.git
cd prospekt
npm test
```

There is nothing to install. Node 18+ for the tests and build script, Chrome
111+ to run the extension.

```bash
npm run preview   # dashboard in a browser tab with sample data — fast UI loop
npm run build     # then load dist/prospekt via chrome://extensions
```

## How the tests work, and what they can't tell you

`npm test` loads the real source files into a Node VM with stubbed `chrome.*`
APIs and calls the shipped functions. It is not a mock of the code — it is the
code — so it catches logic regressions well.

**It cannot catch anything that needs a browser or a real Chrome API.** Things
that have actually shipped broken past a green suite in this repo:

- A transparent full-viewport overlay that swallowed every click. The suite
  drove the UI with `element.click()`, which dispatches straight at the node and
  bypasses hit testing entirely.
- Helper functions deleted along with a refactor, because no test rendered a
  page.
- A `safeUrl()` check that passed only because the test stubbed a
  `chrome-extension://` base, hiding a bug that a real `http://` page exposed.

So: **if you change UI, open it.** `npm run preview` is the quick loop; load the
unpacked extension before you call it done. If you change extraction, the
service worker, or storage, `npm test` is the fast signal — add a case.

### Writing a test

Both suites use the same shape:

```js
ok("what should be true", actual === expected, JSON.stringify(actual));
```

Name the behaviour, not the function. `"a legacy record reports an unknown yield,
not zero"` tells the next person what broke; `"getScans works"` does not. When
fixing a bug, add the case that reproduces it first and watch it fail — several
tests here exist because a fix looked right and wasn't.

## House style

- No dependencies, no build step, no transpilation. Plain files Chrome loads.
- Comments explain **why**, especially where the obvious thing is wrong. There
  are several places where the straightforward approach fails subtly and the
  comment is the only thing standing between you and reintroducing it.
- `defaults.js` is the single source of truth for patterns, filter lists and
  shared validation. It is loaded by the content script, the worker and the
  dashboard specifically so the three cannot disagree. Don't fork a copy.
- Everything interpolated into HTML goes through `esc()`. It escapes quotes,
  because values come from scraped pages and land in attributes.
- Prefer failing closed. A guard like `if (domain && check())` skips the check
  when `domain` is empty — that shape has already caused one security fix here.

## The privacy line

Prospekt makes **no network requests**, and the build script enforces it by
refusing to package if any HTML or CSS references a remote resource. A change
that adds a webfont, an icon CDN, an analytics ping or a favicon service will
not be merged. If a feature seems to need one, open an issue first — there is
usually a local answer (see `tools/make-icons.js`, which rasterises PNGs in pure
Node rather than pulling in a dependency).

## Pull requests

- One concern per PR.
- Run `npm test` and `npm run build` before pushing.
- Say what you verified and how — including in a browser, if it touches UI.
- If you found a limitation you didn't fix, say so in the PR rather than
  leaving it for someone to discover.

## Security

Please don't open a public issue for a vulnerability — see
[SECURITY.md](SECURITY.md).
