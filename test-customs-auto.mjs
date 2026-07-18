// Deterministic (no network) regression test for automatic country/customs
// derivation — the replacement for the removed "Flying to the USA?" question.
// Every destination/departure airport must resolve to a country purely from
// its code, with zero reliance on any going_usa-style flag from the client.

process.env.VERCEL = "1";
const {
  BORDER_COUNTRY_RULES, getCountryForAirport, detectRestrictedBorders,
  getDestinationFoodRules, unionCarriedBans,
} = await import("./server.js");

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
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
