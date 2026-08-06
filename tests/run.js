#!/usr/bin/env node
// Runs every suite and reports a combined result.
//
//   npm test        (or: node tests/run.js)
//
// The suites load the real extension sources into a VM with stubbed browser
// APIs, so they exercise the shipped code rather than a copy of it. They are
// not a substitute for loading the unpacked extension in Chrome — see
// CONTRIBUTING.md for what they can and cannot tell you.
//
// Each suite runs in its own process. They are asynchronous, so requiring them
// in-process would return before their assertions had run, and one suite's
// leftover timers would leak into the next.

const path = require("path");
const { spawnSync } = require("child_process");

const SUITES = ["extension.test.js", "content.test.js"];

let failed = 0;
let totals = { pass: 0, fail: 0 };

for (const suite of SUITES) {
  const res = spawnSync(process.execPath, [path.join(__dirname, suite)], {
    encoding: "utf8",
    timeout: 60000,
  });
  const out = (res.stdout || "") + (res.stderr || "");
  process.stdout.write(out);

  const m = out.match(/(\d+) passed, (\d+) failed/);
  if (m) {
    totals.pass += Number(m[1]);
    totals.fail += Number(m[2]);
  }
  // A suite that crashed before reporting still counts as a failure.
  if (res.status !== 0 || !m) failed++;
}

console.log(`\n${"─".repeat(46)}`);
console.log(`${totals.pass} passed, ${totals.fail} failed across ${SUITES.length} suites`);
if (failed) console.log(`${failed} suite(s) did not complete cleanly`);
process.exit(failed || totals.fail ? 1 : 0);
