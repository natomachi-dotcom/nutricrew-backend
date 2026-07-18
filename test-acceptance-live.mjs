// Live acceptance-criteria run against the LOCAL server (with the new
// validator+repair architecture) — real Anthropic calls, real validation.
// 5 requests total, staying under the 5-per-15min generatePlanLimiter for
// one email, each request engineered to cover multiple acceptance-criteria
// items at once (multi-day pairings give multiple independently-validated
// days per call).
//
// Usage: node test-acceptance-live.mjs
//   BACKEND=http://localhost:3099 (default) node test-acceptance-live.mjs

const BACKEND = process.env.BACKEND || "http://localhost:3099";
const EMAIL = "renatogadeabi@gmail.com"; // same trusted test account the existing test-*.mjs scripts use

async function generate(label, data) {
  console.log(`\n${"═".repeat(70)}\n${label}\n${"─".repeat(70)}`);
  const resp = await fetch(`${BACKEND}/api/generate-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { email: EMAIL, ...data }, lang: "en" }),
  });
  const result = await resp.json();
  if (result.error) {
    console.error(`  API ERROR: ${result.error} ${result.message || ""}`);
    return null;
  }
  return result;
}

function reportMeal(m) {
  const ings = (m.ingredients || []).map(i => (typeof i === "string" ? i : `${i.name}(${i.quantity}${i.unit})`)).join(", ");
  console.log(`    [${m.type}] "${m.name}" — ${m.calories}kcal, $${m.estimated_cost}, prep=${m.prep_method}, allergens=${JSON.stringify(m.allergens_present)}`);
  console.log(`      ingredients: ${ings}`);
}

const BASE_PROFILE = {
  name: "Test User", position: "cabin", departure: "YYZ", destinations: ["YOW"],
  timezone: "0", goals: [],
};

// ── Call 1: peanut + dairy allergy, 3-day pairing ────────────────────────
const r1 = await generate("CALL 1 — nut_free + dairy_free allergy (3-day pairing)", {
  ...BASE_PROFILE, gender: "female", weight: "70kg", dob: "1996-01-01",
  diets: ["nut_free", "dairy_free"], kitchen: ["full_kitchen"], pairing_days: "3",
});
if (r1) {
  for (const day of r1.days) {
    console.log(`  ${day.label} (${day.totalCalories} kcal):`);
    for (const m of day.meals || []) reportMeal(m);
  }
}

// ── Call 2: vegan ─────────────────────────────────────────────────────────
const r2 = await generate("CALL 2 — vegan (1 day)", {
  ...BASE_PROFILE, gender: "male", weight: "80kg", dob: "1990-01-01",
  diets: ["vegan"], kitchen: ["full_kitchen"], pairing_days: "1",
});
if (r2) for (const m of r2.days[0].meals || []) reportMeal(m);

// ── Call 3: halal + gluten_free ──────────────────────────────────────────
const r3 = await generate("CALL 3 — halal + gluten_free (1 day)", {
  ...BASE_PROFILE, gender: "male", weight: "75kg", dob: "1992-01-01",
  diets: ["halal", "gluten_free"], kitchen: ["full_kitchen"], pairing_days: "1",
});
if (r3) for (const m of r3.days[0].meals || []) reportMeal(m);

// ── Call 4: low_carb (keto proxy) ────────────────────────────────────────
const r4 = await generate("CALL 4 — low_carb / keto (1 day)", {
  ...BASE_PROFILE, gender: "female", weight: "65kg", dob: "1994-01-01",
  diets: ["low_carb"], kitchen: ["full_kitchen"], pairing_days: "1",
});
if (r4) {
  let totalCarbs = 0;
  for (const m of r4.days[0].meals || []) { reportMeal(m); totalCarbs += m.carbs || 0; }
  console.log(`  TOTAL CARBS: ${totalCarbs}g (limit 50g)`);
}

// ── Call 5: female/70kg/~30/None diet, tight budget, hotel/no-kitchen, 3-day ──
const r5 = await generate("CALL 5 — female/70kg/~30/None diet, $5/day budget, Hotel(No Kitchen), 3-day pairing", {
  ...BASE_PROFILE, gender: "female", weight: "70kg", dob: "1996-01-01",
  diets: ["none"], kitchen: ["hotel"], pairing_days: "3",
  budget_type: "total", budget_amount: "15", // $15 / 3 days = $5/day
});
if (r5) {
  for (const day of r5.days) {
    const cost = (day.meals || []).reduce((s, m) => s + (m.estimated_cost || 0), 0);
    console.log(`  ${day.label}: ${day.totalCalories} kcal, $${cost.toFixed(2)} (budget $5.00/day), prep_methods=${(day.meals || []).map(m => m.prep_method).join(",")}`);
    for (const m of day.meals || []) reportMeal(m);
  }
}

console.log(`\n${"═".repeat(70)}\nDONE\n${"═".repeat(70)}`);
