// Deterministic (no network) regression test for automatic country/customs
// derivation — the replacement for the removed "Flying to the USA?" question.
// Every destination/departure airport must resolve to a country purely from
// its code, with zero reliance on any going_usa-style flag from the client.

process.env.VERCEL = "1";
const {
  BORDER_COUNTRY_RULES, getCountryForAirport, detectRestrictedBorders,
  getDestinationFoodRules, unionCarriedBans, WALL_RULES, runWallOnPlanScope,
} = await import("./server.js");

// Shared meal factory for the Wall-rule tests below.
function meal(overrides = {}) {
  return {
    type: "Breakfast", name: "Oatmeal with Berries", description: "x", prep: "5 min",
    prep_method: "microwave", calories: 450, protein: 15, carbs: 60, fat: 12,
    tags: [], tip: "", ingredients: [{ name: "oats", quantity: 1, unit: "cup" }],
    estimated_cost: 5, hero_ingredient: "oats", ...overrides,
  };
}

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

console.log("═".repeat(60));
console.log("Structural: no more flag-based fallback");
console.log("─".repeat(60));
check("BORDER_COUNTRY_RULES has no usaFlagTrigger left on any rule",
  BORDER_COUNTRY_RULES.every(r => !("usaFlagTrigger" in r)));
check("BORDER_COUNTRY_RULES includes a mexico rule",
  BORDER_COUNTRY_RULES.some(r => r.id === "mexico"));
check("detectRestrictedBorders takes (destinations, departure) — 2 params",
  detectRestrictedBorders.length === 2);

console.log("\n" + "═".repeat(60));
console.log("Single-country derivation, zero flags passed");
console.log("─".repeat(60));
check("FLL -> usa", getCountryForAirport("FLL") === "usa");
check("JFK -> usa", getCountryForAirport("JFK") === "usa");
check("LAX -> usa", getCountryForAirport("LAX") === "usa");
check("NRT -> japan", getCountryForAirport("NRT") === "japan");
check("HND -> japan", getCountryForAirport("HND") === "japan");
check("CDG -> eu", getCountryForAirport("CDG") === "eu");
check("LHR -> uk", getCountryForAirport("LHR") === "uk");
check("SYD -> australia", getCountryForAirport("SYD") === "australia");
check("DXB -> uae", getCountryForAirport("DXB") === "uae");
check("MEX -> mexico", getCountryForAirport("MEX") === "mexico");
check("YYZ -> canada", getCountryForAirport("YYZ") === "canada");

console.log("\n" + "═".repeat(60));
console.log("Timezone-based fallback for airports not in a curated codes list");
console.log("─".repeat(60));
// PIT (Pittsburgh) is in AIRPORT_TIMEZONE (America/New_York) but NOT in
// BORDER_COUNTRY_RULES.usa.codes — must still resolve via the fallback.
check("PIT (not in usa.codes, but in AIRPORT_TIMEZONE) -> usa via fallback",
  getCountryForAirport("PIT") === "usa");
check("Totally unknown code -> null, not a crash or a guess",
  getCountryForAirport("ZZZ") === null);
check("Empty/missing code -> null", getCountryForAirport("") === null && getCountryForAirport(null) === null);

console.log("\n" + "═".repeat(60));
console.log("detectRestrictedBorders: no going_usa argument needed at all");
console.log("─".repeat(60));
{
  const borders = detectRestrictedBorders(["Fort Lauderdale (FLL)"], "Montreal (YUL)");
  check("FLL destination alone triggers the usa border with zero flags", borders.some(b => b.id === "usa"));
  check("usa border records the correct day", borders.find(b => b.id === "usa")?.days?.includes(1));
}
{
  const borders = detectRestrictedBorders(["Ottawa (YOW)"], "Toronto (YYZ)");
  check("An all-Canada itinerary does not trigger the usa border", !borders.some(b => b.id === "usa"));
  check("...but does trigger the canada border (home country, on return)", borders.some(b => b.id === "canada" && b.onReturn));
}

console.log("\n" + "═".repeat(60));
console.log("Acceptance scenario: YUL -> FLL -> NRT (multi-country union)");
console.log("─".repeat(60));
{
  const departure = "Montreal (YUL)";
  const destinations = ["Fort Lauderdale (FLL)", "Tokyo (NRT)"];
  const borders = detectRestrictedBorders(destinations, departure);
  const ids = borders.map(b => b.id).sort();
  console.log(`  Derived countries: ${ids.join(", ") || "(none)"}`);
  check("Derives BOTH usa (day 1) and japan (day 2), zero user input", ids.includes("usa") && ids.includes("japan"));
  check("usa border is scoped to day 1 only", borders.find(b => b.id === "usa")?.days?.join(",") === "1");
  check("japan border is scoped to day 2 only", borders.find(b => b.id === "japan")?.days?.join(",") === "2");

  const bans = unionCarriedBans(borders, "en");
  console.log(`  Union of carried-food bans (${bans.length} items):`);
  bans.forEach(b => console.log(`    ❌ ${b}`));
  check("Union includes a USA-specific ban (fresh fruit)", bans.some(b => /fresh fruit/i.test(b)));
  check("Union includes a Japan-specific ban (plant quarantine)", bans.some(b => /quarantine/i.test(b)));

  const destRules = getDestinationFoodRules(destinations);
  console.log(`\n  DESTINATION CUSTOMS & FOOD RULES text (Japan block, since USA has its own dedicated field):`);
  console.log(destRules.split("\n").map(l => `    ${l}`).join("\n"));
  check("getDestinationFoodRules includes the Japan narrative block", destRules.includes("JAPAN CUSTOMS"));
}

console.log("\n" + "═".repeat(60));
console.log("Graceful fallback for an unresolvable destination (no blocking)");
console.log("─".repeat(60));
{
  const rules = getDestinationFoodRules(["Nowhereville (ZZZ)"]);
  check("Unresolvable destination gets the generic fallback text, not a crash", rules.includes("DESTINATION CUSTOMS (general guidance"));
  const borders = detectRestrictedBorders(["Nowhereville (ZZZ)"], "Montreal (YUL)");
  check("Unresolvable destination triggers no destination-side border rule",
    !borders.some(b => b.days.includes(1)));
}

console.log("\n" + "═".repeat(60));
console.log("Wall rule: customs_matches_destination (plan scope, REPAIR)");
console.log("─".repeat(60));
{
  const rule = WALL_RULES.find(r => r.id === "customs_matches_destination");
  check("rule is registered", !!rule);
  check("severity is REPAIR", rule?.severity === "REPAIR");
  check("scope is plan", rule?.scope === "plan");
}

{
  // Correctly derived AND correctly applied — must not fire.
  const days = [{ day: 1, meals: [meal()] }];
  const borders = detectRestrictedBorders(["Fort Lauderdale (FLL)"], "Montreal (YUL)");
  const violations = runWallOnPlanScope(days, {
    destinations: ["Fort Lauderdale (FLL)"], departure: "Montreal (YUL)",
    restrictedBorders: borders, kitchen: ["hotel"],
  });
  check("no violation when applied rules already match the derived destination",
    !violations.some(v => v.ruleId === "customs_matches_destination"), JSON.stringify(violations));
}

{
  // The exact failure mode from the spec: a US destination, but the rules
  // actually applied during generation (simulated stale/broken lookup) are
  // empty — must FAIL, and must be attributable to the right day, with no
  // mealIndex (nothing to meal-repair; the whole day needs regenerating).
  const days = [{ day: 1, meals: [meal()] }];
  const violations = runWallOnPlanScope(days, {
    destinations: ["Fort Lauderdale (FLL)"], departure: "Montreal (YUL)",
    restrictedBorders: [], // simulates the lookup silently breaking
    kitchen: ["hotel"],
  });
  const v = violations.find(x => x.ruleId === "customs_matches_destination" && x.code === "CUSTOMS_MISMATCH");
  check("FLL destination with no applied rules -> CUSTOMS_MISMATCH violation", !!v, JSON.stringify(violations));
  check("violation is attributed to day 1", v?.day === 1);
  check("violation has no mealIndex (whole day must be regenerated, not one meal)", v?.mealIndex === undefined);
  check("wallMessage mentions regenerating the day", /[Rr]egenerate/.test(v?.wallMessage || ""));
}

{
  // A destination resolved to the WRONG country (Japan applied instead of
  // USA for an FLL day) — set mismatch even though something was applied.
  const days = [{ day: 1, meals: [meal()] }];
  const wrongBorders = detectRestrictedBorders(["Tokyo (NRT)"], "Montreal (YUL)"); // japan, not usa
  const violations = runWallOnPlanScope(days, {
    destinations: ["Fort Lauderdale (FLL)"], departure: "Montreal (YUL)",
    restrictedBorders: wrongBorders, kitchen: ["hotel"],
  });
  const v = violations.find(x => x.ruleId === "customs_matches_destination" && x.code === "CUSTOMS_MISMATCH");
  check("wrong country applied (japan instead of usa) -> CUSTOMS_MISMATCH", !!v, JSON.stringify(violations));
}

{
  // Rules correctly derived AND applied, but a carried meal still contains
  // a banned fresh item — the independent per-meal recheck must catch it,
  // attributing it to the specific meal (mealIndex present, repairable).
  const days = [{
    day: 1,
    meals: [meal({ ingredients: [{ name: "fresh apple", quantity: 1, unit: "" }] })],
  }];
  const borders = detectRestrictedBorders(["Fort Lauderdale (FLL)"], "Montreal (YUL)");
  const violations = runWallOnPlanScope(days, {
    destinations: ["Fort Lauderdale (FLL)"], departure: "Montreal (YUL)",
    restrictedBorders: borders, kitchen: ["hotel"],
  });
  const v = violations.find(x => x.ruleId === "customs_matches_destination" && x.code === "CUSTOMS_UNION");
  check("a carried fresh-fruit meal fails the independent union recheck", !!v, JSON.stringify(violations));
  check("violation carries day AND mealIndex (single-meal repairable)", v?.day === 1 && v?.mealIndex === 0);
}

{
  // Multi-country pairing (the acceptance scenario): applied rules already
  // cover BOTH usa and japan correctly — must not fire.
  const destinations = ["Fort Lauderdale (FLL)", "Tokyo (NRT)"];
  const departure = "Montreal (YUL)";
  const borders = detectRestrictedBorders(destinations, departure);
  const days = [
    { day: 1, meals: [meal()] },
    { day: 2, meals: [meal({ type: "Snack", name: "Green Tea Mochi", hero_ingredient: "mochi" })] },
  ];
  const violations = runWallOnPlanScope(days, {
    destinations, departure, restrictedBorders: borders, kitchen: ["hotel"],
  });
  check("YUL -> FLL -> NRT with correctly-applied usa+japan rules does not fire",
    !violations.some(v => v.ruleId === "customs_matches_destination"), JSON.stringify(violations));
}

{
  // Defensive: a caller that doesn't supply a ruleCtx at all (e.g. an
  // isolated test of a different plan-scope rule) must not crash and must
  // not spuriously fire — this rule degrades to a no-op without context.
  const days = [{ day: 1, meals: [meal()] }];
  let threw = false;
  let violations = [];
  try { violations = runWallOnPlanScope(days); } catch { threw = true; }
  check("runWallOnPlanScope(days) with no ruleCtx doesn't throw", !threw);
  check("...and doesn't spuriously fire customs_matches_destination",
    !violations.some(v => v.ruleId === "customs_matches_destination"));
}

console.log("\n" + "═".repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
