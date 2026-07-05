// Live test for the carried-food customs fix.
// Three scenarios:
//   1. USA only (going_usa=yes, JFK on day 1)       — carried note mentions USA
//   2. USA day 1 + Japan day 2 (NRT)                — carried note mentions BOTH, union bans
//   3. No restricted country (YOW — Ottawa, Canada) — NO carried note (regression check)

const BACKEND = "https://nutricrew-backend.vercel.app";
const EMAIL   = "renatogadeabi@gmail.com";

const BASE = {
  email: EMAIL, name: "Test User", gender: "female",
  weight: "70kg", dob: "1996-01-01", position: "flight_attendant",
  diets: ["none"], goals: [], kitchen: ["full_kitchen"],
  departure: "YYZ", timezone: "0",
};

const SCENARIOS = [
  {
    label: "Scenario 1 — USA only (JFK day 1, going_usa=yes)",
    data: { ...BASE, pairing_days: "1", destinations: ["JFK"], going_usa: "yes" },
    expectCountries: ["USA"],
    expectNoCarried: false,
  },
  {
    label: "Scenario 2 — USA day 1 + Japan day 2 (union)",
    data: { ...BASE, pairing_days: "2", destinations: ["JFK", "NRT"], going_usa: "yes" },
    expectCountries: ["USA", "Japan"],
    expectNoCarried: false,
  },
  {
    label: "Scenario 3 — No restricted country (Ottawa, no going_usa)",
    data: { ...BASE, pairing_days: "1", destinations: ["YOW"], going_usa: "no" },
    expectCountries: [],
    expectNoCarried: true,
  },
];

let passed = 0;
let failed = 0;

for (const s of SCENARIOS) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`${s.label}`);
  console.log(`${"─".repeat(60)}`);

  const resp = await fetch(`${BACKEND}/api/generate-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: s.data, lang: "en" }),
  });
  const result = await resp.json();

  if (result.error) {
    console.error(`  ✗ API error: ${result.error} ${result.message || ""}`);
    failed++;
    continue;
  }

  const fr = result.foodRestrictions || {};
  const carried = fr.carried || null;

  // ── Print carried note ──────────────────────────────────────────
  if (carried) {
    console.log(`\n  [carried field present]\n`);
    console.log(carried.split("\n").map(l => `  ${l}`).join("\n"));
  } else {
    console.log(`\n  [no carried field]`);
  }

  // ── Print meal tips for day 1 (check model mentions customs) ───
  const day1 = result.days?.[0];
  if (day1?.meals) {
    console.log(`\n  Day 1 meals + tips:`);
    for (const m of day1.meals) {
      console.log(`    [${m.type}] ${m.name} (${m.calories} kcal)`);
      if (m.tip) console.log(`      tip: ${m.tip}`);
    }
  }

  // ── Assertions ─────────────────────────────────────────────────
  console.log(`\n  Assertions:`);
  let scenarioPassed = true;

  if (s.expectNoCarried) {
    const ok = !carried;
    console.log(`  ${ok ? "✓" : "✗"} No carried field (no restricted borders)`);
    if (!ok) scenarioPassed = false;
  } else {
    const ok = !!carried;
    console.log(`  ${ok ? "✓" : "✗"} carried field present`);
    if (!ok) scenarioPassed = false;

    for (const country of s.expectCountries) {
      const found = carried && carried.includes(country);
      console.log(`  ${found ? "✓" : "✗"} carried mentions "${country}"`);
      if (!found) scenarioPassed = false;
    }

    // If multi-country, verify both are combined (not separate)
    if (s.expectCountries.length > 1 && carried) {
      const hasBoth = s.expectCountries.every(c => carried.includes(c));
      console.log(`  ${hasBoth ? "✓" : "✗"} All countries combined in single carried note`);
      if (!hasBoth) scenarioPassed = false;
    }
  }

  if (scenarioPassed) { passed++; console.log(`\n  PASS`); }
  else { failed++; console.log(`\n  FAIL`); }
}

console.log(`\n${"═".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
