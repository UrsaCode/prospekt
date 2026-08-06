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
  html = html.replace(
    '<script src="defaults.js"></script>',
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

http.createServer((req, res) => {
  const clean = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
  const rel = clean === "/" ? "/dashboard.html" : clean;

  if (rel === "/dashboard.html") {
    res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" });
    return res.end(dashboardHtml());
  }

  // Confine to the repo — this is a dev server, but path traversal is still
  // not something to leave lying around.
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("forbidden");
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`
Prospekt dashboard preview
  http://127.0.0.1:${PORT}

Serving the real files from the repo with a stubbed chrome.* and a sample
library. Storage is in-memory: reloading resets it.

This is not a substitute for loading the unpacked extension — it cannot
exercise real Chrome APIs, content-script injection, or the service worker
lifecycle. Use it for UI work, then verify in Chrome.
`);
});
