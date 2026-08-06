#!/usr/bin/env node
// Serves the dashboard in an ordinary browser tab, backed by a stubbed chrome.*
// and a sample library, so you can work on the UI without reloading the
// extension after every edit.
//
//   npm run preview        →  http://127.0.0.1:8770
//
// It serves the real files straight from the repo — nothing is copied, so what
// you see is what ships. Only dashboard.html is rewritten in flight, to inject
// the stub and the service worker. Assets are cache-busted per request because
// a stale bundle looks exactly like a broken change.

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT || 8770);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

const version = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version; }
  catch { return "dev"; }
})();

function dashboardHtml() {
  let html = fs.readFileSync(path.join(ROOT, "dashboard.html"), "utf8");
  const stamp = Date.now();

  // The stub must run before defaults.js; background.js supplies the real
  // message handlers the dashboard talks to.
  const anchor = /<script\s+src="defaults\.js"\s*><\/script>/;
  if (!anchor.test(html)) {
    // String.replace no-ops silently. Without this check, changing the script
    // tag in dashboard.html would serve a page with no chrome.* shim, and the
    // only symptom would be an opaque "chrome is undefined" in the console.
    throw new Error(
      'preview: could not find <script src="defaults.js"></script> in dashboard.html.\n'
      + "The stub injection anchors on that tag — update tools/preview.js to match."
    );
  }
  html = html.replace(
    anchor,
    `<script>window.__PROSPEKT_VERSION = ${JSON.stringify(version)};</script>\n`
    + '  <script src="tools/preview-stub.js"></script>\n'
    + '  <script src="defaults.js"></script>\n'
    + '  <script src="background.js"></script>'
  );
  html = html.replace(
    /(src|href)="((?:\.\/)?(?:tools\/)?[\w./-]+\.(?:js|css))"/g,
    (_, attr, file) => `${attr}="${file}?v=${stamp}"`
  );
  return html;
}

/**
 * Resolve a request path to a file inside the repo, or null.
 *
 * startsWith(ROOT) is NOT sufficient: it is a string test, not a path test, so
 * a sibling directory whose name merely begins with the repo name — e.g.
 * ".../prospekt-notes" next to ".../prospekt" — satisfies it and escapes the
 * repo entirely.
 */
function resolveInsideRoot(rel) {
  const file = path.resolve(ROOT, "." + path.sep + rel);
  const relative = path.relative(ROOT, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return file;
}

const server = http.createServer((req, res) => {
  let rel;
  try {
    // Throws URIError on a malformed escape such as /%zz. Uncaught, that ends
    // the process — one stray probe would kill the dev session mid-edit.
    rel = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    return res.end("bad request path");
  }

  if (rel === "/") rel = "/dashboard.html";

  if (rel === "/dashboard.html") {
    let html;
    try { html = dashboardHtml(); }
    catch (err) {
      console.error("\n" + err.message + "\n");
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end(err.message);
    }
    res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" });
    return res.end(html);
  }

  const file = resolveInsideRoot(rel);
  if (!file) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("forbidden");
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("not found");
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
});

server.on("error", err => {
  console.error(err.code === "EADDRINUSE"
    ? `\npreview: port ${PORT} is already in use. Set PORT to something else:\n  PORT=8771 npm run preview\n`
    : `\npreview: ${err.message}\n`);
  process.exit(1);
});

// Bind the loopback interface explicitly. listen(PORT) alone binds 0.0.0.0 —
// every interface — which would put a file server for this repo on whatever
// network the machine is attached to, while the banner below claims localhost.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`
Prospekt dashboard preview
  http://127.0.0.1:${PORT}    (loopback only)

Serving the real files from the repo with a stubbed chrome.* and a sample
library. Storage is in-memory: reloading resets it.

This is not a substitute for loading the unpacked extension — it cannot
exercise real Chrome APIs, content-script injection, or the service worker
lifecycle. Use it for UI work, then verify in Chrome.
`);
});
