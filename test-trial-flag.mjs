// Regression tests for the final monetization model (2026-07-26): 1 free
// pairing, then subscribing (monthly or annual) always starts a 30-day
// Stripe-native trial before the first charge. TRIAL_ENABLED is no longer a
// campaign toggle — it's now a hardcoded `true` — so these tests assert it
// stays true (and the trial copy stays present) regardless of what's in the
// environment, guarding against the old env-toggle behavior creeping back.
//
// Each variant below is checked in its own subprocess so a stray
// TRIAL_ENABLED env var can't leak between checks via the module cache.
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

console.log("\n=== TRIAL_ENABLED with no env var set ===");
{
  const { TRIAL_ENABLED, ...envWithoutFlag } = process.env;
  const flags = readFlagsInSubprocess(envWithoutFlag);
  check("is true", flags.TRIAL_ENABLED === true, JSON.stringify(flags));
  check("premium-required message carries trial language", /free month/i.test(flags.PREMIUM_REQUIRED_MESSAGE), flags.PREMIUM_REQUIRED_MESSAGE);
}

console.log("\n=== TRIAL_ENABLED=false in env can no longer disable it ===");
{
  const flags = readFlagsInSubprocess({ ...process.env, TRIAL_ENABLED: "false" });
  check("still true — not a toggle anymore", flags.TRIAL_ENABLED === true, JSON.stringify(flags));
  check("premium-required message still carries trial language", /free month/i.test(flags.PREMIUM_REQUIRED_MESSAGE), flags.PREMIUM_REQUIRED_MESSAGE);
}

console.log("\n=== TRIAL_ENABLED=true explicit (redundant, but must still work) ===");
{
  const flags = readFlagsInSubprocess({ ...process.env, TRIAL_ENABLED: "true" });
  check("is true", flags.TRIAL_ENABLED === true, JSON.stringify(flags));
  check("TRIAL_DAYS is untouched (still 30)", flags.TRIAL_DAYS === 30, JSON.stringify(flags));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
