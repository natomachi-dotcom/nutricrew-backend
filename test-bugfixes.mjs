// Regression tests for bugs found/fixed in a July 2026 audit pass.
// Pure logic only — no live Anthropic/CRUD calls, no network. Exercises the
// real exported functions from server.js (not reimplementations), so a
// revert of any fix here fails loudly.
//
// Usage: node test-bugfixes.mjs

import { readFileSync } from "fs";

// Prevent server.js's module-level `app.listen()` from binding a real port
// when we import it (must be set before the dynamic import evaluates it).
process.env.VERCEL = "1";

const { buildContext, getDietRules, getSingleDietBlock, hasGymEquipment, CACHE_SCHEMA_VERSION } =
  await import("./server.js");

let passed = 0;
let failed = 0;
function check(label, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

function baseData(overrides = {}) {
  return {
    email: "test@example.com", name: "Test User", gender: "female",
    weight: "70kg", dob: "1996-01-01", position: "cabin",
    diets: ["none"], goals: [], kitchen: ["full_kitchen"],
    departure: "YYZ", destinations: ["LAX"], going_usa: "no", timezone: "0",
    ...overrides,
  };
}

// ── Bug 1: gym-plan hasEquipment matched "hotel_no_kitchen", a value that ──
// ── never actually gets sent — the real value is "hotel".                ──
console.log("\n=== hasGymEquipment (hotel kitchen-string bug) ===");
check('hasGymEquipment(["hotel"]) === false', hasGymEquipment(["hotel"]) === false);
check('hasGymEquipment(["airplane_food"]) === false', hasGymEquipment(["airplane_food"]) === false);
check('hasGymEquipment(["hotel","airplane_food"]) === false', hasGymEquipment(["hotel", "airplane_food"]) === false);
check('hasGymEquipment(["full_kitchen"]) === true', hasGymEquipment(["full_kitchen"]) === true);
check('hasGymEquipment([]) === false', hasGymEquipment([]) === false);
check('hasGymEquipment(undefined) === false', hasGymEquipment(undefined) === false);

// ── Bug 2: perDayBudget for budget_type="total" must divide by the whole ──
// ── pairing's day count, not by whatever subset of days a given call is  ──
// ── generating right now.                                                ──
console.log("\n=== buildContext perDayBudget division (total-budget bug) ===");
{
  const data = baseData({ budget_type: "total", budget_amount: "300" });
  const ctx5 = buildContext(data, "en", 5);
  check("total $300 / 5 days => $60/day", ctx5.perDayBudget === 60, `got ${ctx5.perDayBudget}`);
  const ctx1 = buildContext(data, "en", 1);
  // This documents the exact bug shape: calling buildContext with pairingDays=1
  // for a single day's prompt out of a longer trip yields the WHOLE trip budget
  // as that day's budget — which is why the two call sites in /api/generate-plan
  // must always pass the pairing's true total day count, never 1 or a subset.
  check("total $300 / 1 day => $300/day (proves why passing 1 here is wrong)", ctx1.perDayBudget === 300, `got ${ctx1.perDayBudget}`);
  const ctxDay = buildContext({ ...data, budget_type: "day" }, "en", 5);
  check('budget_type="day" ignores pairingDays entirely', ctxDay.perDayBudget === 300);
}

// Guard against the actual regression: the two call sites in the day-generation
// path must pass the real total `pairingDays`, not `missing` or a literal `1`.
console.log("\n=== source guard: generate-plan call sites use total pairingDays ===");
{
  const src = readFileSync(new URL("./server.js", import.meta.url), "utf8");
  check(
    'missingCtx uses buildContext(missingData, lang, pairingDays)',
    src.includes("const missingCtx = buildContext(missingData, lang, pairingDays);")
  );
  check(
    'dayCtx uses buildContext(dayData, lang, pairingDays)',
    src.includes("const dayCtx = buildContext(dayData, lang, pairingDays);")
  );
  check(
    "buggy missingCtx pattern (missing as divisor) is gone",
    !src.includes("buildContext(missingData, lang, missing)")
  );
  check(
    "buggy dayCtx pattern (literal 1 as divisor) is gone",
    !src.includes("buildContext(dayData, lang, 1)")
  );
}

// ── Bug 3: "paleo" is a real, selectable frontend diet option but had no ──
// ── case in getSingleDietBlock, silently falling through to "no          ──
// ── restrictions" — i.e. zero diet enforcement for paleo users.          ──
console.log("\n=== paleo diet rules ===");
{
  const block = getSingleDietBlock("paleo", null, {});
  check('getSingleDietBlock("paleo") is not the generic fallback', !block.includes("No restrictions"), block);
  check('getSingleDietBlock("paleo") mentions PALEO', block.includes("PALEO"));
  const rules = getDietRules(["paleo"], null, {});
  check('getDietRules(["paleo"]) mentions PALEO', rules.includes("PALEO"));
}

// ── Bug 4: plans-bank.json / generate-bank.js kitchen-key + version-key ──
// ── mismatches silently made bank entries unreachable.                  ──
console.log("\n=== plan-bank key format ===");
{
  const bank = JSON.parse(readFileSync(new URL("./plans-bank.json", import.meta.url), "utf8"));
  const keys = Object.keys(bank.plans);
  check("plans-bank.json has entries", keys.length > 0);
  check(
    'no key contains the dead "hotel_no_kitchen" segment',
    keys.every(k => !k.includes("hotel_no_kitchen")),
    keys.filter(k => k.includes("hotel_no_kitchen")).join(", ")
  );
  const hotelKeys = keys.filter(k => k.split("|")[4] === "hotel");
  check("hotel-kitchen entries exist under the real \"hotel\" key", hotelKeys.length > 0);
  // The bank is allowed to trail behind server.js's CACHE_SCHEMA_VERSION (it
  // just goes dormant — see the rawBankEntries filter in /api/generate-plan —
  // until someone re-runs generate-bank.js) but must NEVER be ahead, which
  // would mean a hand-edited/corrupted version segment.
  const bankVersions = [...new Set(keys.map(k => k.split("|")[1]))];
  const versionNum = (v) => parseInt(String(v).replace(/^v/, ""), 10) || 0;
  check(
    "bank version segment is never ahead of server.js's CACHE_SCHEMA_VERSION",
    bankVersions.every(v => versionNum(v) <= versionNum(CACHE_SCHEMA_VERSION)),
    `bank has ${bankVersions.join(",")}, server.js has ${CACHE_SCHEMA_VERSION}`
  );
  if (bankVersions.some(v => v !== CACHE_SCHEMA_VERSION)) {
    console.log(`  i bank version(s) [${bankVersions.join(",")}] trail server.js's ${CACHE_SCHEMA_VERSION} — bank is dormant until \`node generate-bank.js\` is re-run (expected after a MEAL_SCHEMA change; not a failure)`);
  }
  check(
    "every key encodes a pairingDays segment matching its entries",
    keys.every(k => {
      const declared = k.split("|").pop();
      return bank.plans[k].every(e => String(e.pairingDays) === declared);
    })
  );
}

console.log("\n=== generate-bank.js stays in sync ===");
{
  const src = readFileSync(new URL("./generate-bank.js", import.meta.url), "utf8");
  check('KITCHENS no longer uses the dead "hotel_no_kitchen" key', !src.includes('key: "hotel_no_kitchen"'));
  check('KITCHENS uses the real "hotel" key', src.includes('key: "hotel"'));
  const m = src.match(/const CACHE_SCHEMA_VERSION = "([^"]+)"/);
  check(
    "generate-bank.js's CACHE_SCHEMA_VERSION matches server.js's",
    !!m && m[1] === CACHE_SCHEMA_VERSION,
    `generate-bank.js has ${m?.[1]}, server.js has ${CACHE_SCHEMA_VERSION}`
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
