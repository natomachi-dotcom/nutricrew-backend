// Regression tests for the TRIAL_ENABLED feature flag (launch monetization
// model: 1 free pairing, then subscribe immediately — no trial — with all
// trial mechanics preserved and re-enablable via TRIAL_ENABLED=true).
//
// TRIAL_ENABLED is read from process.env once at module load, so each
// variant below is checked in its own subprocess (can't just re-import in
// this process — the module cache would return the same value twice).
//
// Usage: node test-trial-flag.mjs

import { spawnSync } from "child_process";

let passed = 0;
let failed = 0;
function check(label, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

function readFlagsInSubprocess(env) {
  const script = `
    process.env.VERCEL = "1";
    import("./server.js").then(m => {
      console.log(JSON.stringify({
        TRIAL_ENABLED: m.TRIAL_ENABLED,
        PREMIUM_REQUIRED_MESSAGE: m.PREMIUM_REQUIRED_MESSAGE,
        TRIAL_DAYS: m.TRIAL_DAYS,
      }));
    });
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
  const lastLine = result.stdout.trim().split("\n").pop();
  return JSON.parse(lastLine);
}

console.log("\n=== TRIAL_ENABLED default (no env var set) ===");
{
  const { TRIAL_ENABLED, ...envWithoutFlag } = process.env;
  const flags = readFlagsInSubprocess(envWithoutFlag);
  check("defaults to false", flags.TRIAL_ENABLED === false, JSON.stringify(flags));
  check("premium-required message has no trial language", !/free month|free trial/i.test(flags.PREMIUM_REQUIRED_MESSAGE), flags.PREMIUM_REQUIRED_MESSAGE);
  check("premium-required message mentions the real launch price", flags.PREMIUM_REQUIRED_MESSAGE.includes("$7.99"), flags.PREMIUM_REQUIRED_MESSAGE);
}

console.log("\n=== TRIAL_ENABLED=false explicit ===");
{
  const flags = readFlagsInSubprocess({ ...process.env, TRIAL_ENABLED: "false" });
  check("stays false", flags.TRIAL_ENABLED === false, JSON.stringify(flags));
}

console.log("\n=== TRIAL_ENABLED=true restores the trial flow ===");
{
  const flags = readFlagsInSubprocess({ ...process.env, TRIAL_ENABLED: "true" });
  check("flips to true", flags.TRIAL_ENABLED === true, JSON.stringify(flags));
  check("premium-required message reverts to the original trial copy", /free month/i.test(flags.PREMIUM_REQUIRED_MESSAGE), flags.PREMIUM_REQUIRED_MESSAGE);
  check("TRIAL_DAYS is untouched (still 30)", flags.TRIAL_DAYS === 30, JSON.stringify(flags));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
