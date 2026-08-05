#!/usr/bin/env node
// Prospekt build — validates the extension, then stages a clean copy in
// dist/prospekt/ and zips it to dist/prospekt-<version>.zip.
//
//   node build.js
//
// Chrome cannot install a plain .zip; the zip is for sharing/backup. To run it,
// load dist/prospekt/ (or an unzipped copy) via chrome://extensions →
// Developer mode → Load unpacked.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = __dirname;
const DIST = path.join(ROOT, "dist");
const STAGE = path.join(DIST, "prospekt");

// Everything that ships. Anything not listed here stays out of the build.
const FILES = [
  "manifest.json",
  "defaults.js",
  "background.js",
  "content.js",
  "popup.html",
  "popup.js",
  "dashboard.html",
  "dashboard.css",
  "dashboard.js",
  "README.md",
];
const DIRS = ["icons"];

let errors = 0;
const fail = msg => { errors++; console.error("  ✗ " + msg); };
const pass = msg => console.log("  ✓ " + msg);

console.log("\nPreflight\n─────────");

// 1. Manifest parses and is MV3.
const manifestPath = path.join(ROOT, "manifest.json");
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  pass(`manifest.json parses (v${manifest.version}, manifest_version ${manifest.manifest_version})`);
} catch (e) {
  fail("manifest.json does not parse: " + e.message);
  process.exit(1);
}
if (manifest.manifest_version !== 3) fail("manifest_version must be 3");

// 2. Every path the manifest references actually exists.
const referenced = new Set();
const addRef = p => p && referenced.add(p);
addRef(manifest.background?.service_worker);
addRef(manifest.action?.default_popup);
(manifest.content_scripts || []).forEach(cs => (cs.js || []).forEach(addRef));
Object.values(manifest.action?.default_icon || {}).forEach(addRef);
Object.values(manifest.icons || {}).forEach(addRef);

for (const ref of referenced) {
  if (fs.existsSync(path.join(ROOT, ref))) pass(`manifest reference exists: ${ref}`);
  else fail(`manifest references a missing file: ${ref}`);
}

// 3. Every shipped file exists.
for (const f of [...FILES, ...DIRS]) {
  if (!fs.existsSync(path.join(ROOT, f))) fail(`missing from source tree: ${f}`);
}

// 4. Every JS file parses.
for (const f of FILES.filter(f => f.endsWith(".js"))) {
  try {
    execFileSync(process.execPath, ["--check", path.join(ROOT, f)], { stdio: "pipe" });
    pass(`syntax OK: ${f}`);
  } catch (e) {
    fail(`syntax error in ${f}: ${String(e.stderr || e).split("\n")[0]}`);
  }
}

// 5. importScripts targets must resolve relative to the extension root.
const bg = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
for (const m of bg.matchAll(/importScripts\((["'])(.+?)\1\)/g)) {
  if (fs.existsSync(path.join(ROOT, m[2]))) pass(`importScripts resolves: ${m[2]}`);
  else fail(`importScripts target missing: ${m[2]}`);
}
if (manifest.background?.type === "module" && /importScripts\(/.test(bg)) {
  fail("background is type:module but uses importScripts (not available in module workers)");
}

// 6. No remote subresources — the extension claims zero network calls, and a
//    strict CSP would block scripts anyway.
for (const f of FILES.filter(f => f.endsWith(".html") || f.endsWith(".css"))) {
  const src = fs.readFileSync(path.join(ROOT, f), "utf8");
  const remote = [...src.matchAll(/(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+/gi)].map(m => m[0]);
  if (remote.length) fail(`${f} loads remote resources: ${remote.join(", ")}`);
  else pass(`no remote subresources: ${f}`);
}

// 7. Local script/style references in HTML must exist.
for (const f of FILES.filter(f => f.endsWith(".html"))) {
  const src = fs.readFileSync(path.join(ROOT, f), "utf8");
  for (const m of src.matchAll(/(?:src|href)\s*=\s*["']([^"':#][^"']*)["']/g)) {
    const target = path.join(ROOT, m[1]);
    if (fs.existsSync(target)) pass(`${f} → ${m[1]}`);
    else fail(`${f} references a missing local file: ${m[1]}`);
  }
}

if (errors) {
  console.error(`\n${errors} problem(s) found — build aborted.\n`);
  process.exit(1);
}

// ── Stage ───────────────────────────────────────────────────────────────
console.log("\nBuild\n─────");
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

let bytes = 0;
const copy = (rel) => {
  const from = path.join(ROOT, rel);
  const to = path.join(STAGE, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  bytes += fs.statSync(from).size;
};
FILES.forEach(copy);
for (const dir of DIRS) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir))) copy(path.join(dir, entry));
}
const fileCount = FILES.length + DIRS.reduce((n, d) => n + fs.readdirSync(path.join(ROOT, d)).length, 0);
console.log(`  staged ${fileCount} files (${(bytes / 1024).toFixed(1)} KB) → dist/prospekt/`);

// ── Zip ─────────────────────────────────────────────────────────────────
// Written by hand rather than via Compress-Archive: Windows PowerShell writes
// entry names with backslashes, which is out of spec (APPNOTE 4.4.17 requires
// forward slashes) and can flatten icons/ when the archive is consumed by the
// Chrome Web Store or unzipped on Linux/macOS.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function writeZip(entries, outPath) {
  const zlib = require("zlib");
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // Only use deflate if it actually helps; otherwise store.
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);           // mod time
    local.writeUInt16LE(0x21, 12);        // mod date (fixed, for reproducible output)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra length
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);      // central directory signature
    cd.writeUInt16LE(20, 4);              // version made by
    cd.writeUInt16LE(20, 6);              // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);         // relative offset of local header
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  fs.writeFileSync(outPath, Buffer.concat([...chunks, cdBuf, end]));
}

const zipName = `prospekt-${manifest.version}.zip`;
const zipPath = path.join(DIST, zipName);
const zipEntries = [];
const collect = (dir, prefix = "") => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    const rel = prefix + entry.name;
    if (entry.isDirectory()) collect(abs, rel + "/");
    else zipEntries.push({ name: rel, data: fs.readFileSync(abs) });   // always "/"
  }
};
collect(STAGE);
writeZip(zipEntries, zipPath);
console.log(`  zipped → dist/${zipName} (${(fs.statSync(zipPath).size / 1024).toFixed(1)} KB, ${zipEntries.length} entries)`);

console.log(`
Load it in Chrome
─────────────────
  1. Open  chrome://extensions
  2. Enable "Developer mode" (top right)
  3. Click "Load unpacked"
  4. Select:  ${STAGE}

Chrome will not install the .zip directly — that file is for sharing.
`);
