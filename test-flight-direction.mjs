// Regression tests for flight-direction derivation: direction/hours must be
// computed from real airport UTC offsets (never asked of the crew member,
// never trusted from a client-supplied field), and eastbound/westbound must
// produce genuinely different circadian meal-timing guidance.
//
// Covers the production bug where YVR->FLL was labeled "Westbound" when it
// is actually eastbound (losing hours) — see computeLegDirection.
//
// Usage: node test-flight-direction.mjs

process.env.VERCEL = "1";

const { computeLegDirection, computeLegForDay, getCognitivePerfRules, AIRPORT_TIMEZONE } =
  await import("./server.js");

let passed = 0;
let failed = 0;
function check(label, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\n=== computeLegDirection: required test routes ===");
{
  const cases = [
    ["YVR", "FLL", "east", 3, "production bug: this was previously labeled Westbound"],
    ["YUL", "YVR", "west", 3, ""],
    ["YUL", "CDG", "east", 6, ""],
    ["CDG", "YUL", "west", 6, ""],
  ];
  for (const [from, to, expDir, expHours, note] of cases) {
    const leg = computeLegDirection(from, to);
    check(
      `${from} -> ${to} is ${expDir}, ${expHours}h`,
      !!leg && leg.direction === expDir && leg.hours === expHours,
      `got ${JSON.stringify(leg)}${note ? ` (${note})` : ""}`
    );
  }
}

console.log("\n=== computeLegDirection: date-line/offset normalization (YVR -> NRT) ===");
{
  // Raw offset gap NRT(+9) - YVR(-7/-8) is ~16-17h "ahead", which must be
  // normalized the short way around the clock (>12h wraps to negative), the
  // same convention the frontend's pre-existing computeTimezoneDiff uses.
  const leg = computeLegDirection("YVR", "NRT");
  check("YVR -> NRT resolves west by clock, not a raw 16-17h east figure", !!leg && leg.direction === "west");
  check("YVR -> NRT hours is the normalized short way (<= 12h)", !!leg && leg.hours <= 12, `got ${JSON.stringify(leg)}`);
  console.log(`  (reported) YVR -> NRT: ${JSON.stringify(leg)}`);
}

console.log("\n=== computeLegDirection: unknown airports ===");
{
  check("unknown departure code returns null", computeLegDirection("ZZZ", "FLL") === null);
  check("unknown destination code returns null", computeLegDirection("YVR", "ZZZ") === null);
}

console.log("\n=== computeLegForDay: per-leg, not per-pairing ===");
{
  // A 3-day pairing: day1 departure->destinations[0], day2 destinations[0]->
  // destinations[1], day3 destinations[1]->destinations[2]. Each day's leg
  // must be computed independently from that day's actual airports, not
  // copied from day 1.
  const data = { departure: "YVR", destinations: ["FLL", "CDG", "YUL"] };
  const leg1 = computeLegForDay(data, 1); // YVR -> FLL
  const leg2 = computeLegForDay(data, 2); // FLL -> CDG
  const leg3 = computeLegForDay(data, 3); // CDG -> YUL
  check("day 1 leg is YVR -> FLL (east, 3h)", leg1?.direction === "east" && leg1?.hours === 3, JSON.stringify(leg1));
  check("day 2 leg is FLL -> CDG (east, 6h)", leg2?.direction === "east" && leg2?.hours === 6, JSON.stringify(leg2));
  check("day 3 leg is CDG -> YUL (west, 6h)", leg3?.direction === "west" && leg3?.hours === 6, JSON.stringify(leg3));
  check("day 2 leg differs from day 1 leg (per-leg, not per-pairing)", leg2?.fromCode !== leg1?.fromCode || leg2?.toCode !== leg1?.toCode);
  check("day 3 leg differs from day 2 leg in direction (per-leg, not first-leg-only)", leg3?.direction !== leg2?.direction);
}

console.log("\n=== getCognitivePerfRules: east vs west produce genuinely different text ===");
{
  const legFLL = computeLegDirection("YVR", "FLL"); // east, losing hours
  const legYVR = computeLegDirection("FLL", "YVR"); // west, gaining hours
  const rulesEast = getCognitivePerfRules({}, legFLL);
  const rulesWest = getCognitivePerfRules({}, legYVR);
  check("east-leg rules are non-null", !!rulesEast);
  check("west-leg rules are non-null", !!rulesWest);
  check("east vs west rule text differs", rulesEast !== rulesWest);
  check("east rules mention losing hours", /LOSING 3 HOURS/.test(rulesEast || ""));
  check("west rules mention gaining hours", /GAINING 3 HOURS/.test(rulesWest || ""));
  check("east rules never say eastward/eastbound", !/eastward|eastbound/i.test(rulesEast || ""));
  check("west rules never say westward/westbound", !/westward|westbound/i.test(rulesWest || ""));
  check("null leg with no other signal returns null", getCognitivePerfRules({}, null) === null);
}

console.log("\n=== AIRPORT_TIMEZONE coverage for required routes ===");
{
  for (const code of ["YVR", "FLL", "YUL", "CDG", "NRT"]) {
    check(`AIRPORT_TIMEZONE has ${code}`, typeof AIRPORT_TIMEZONE[code] === "string", `got ${AIRPORT_TIMEZONE[code]}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
