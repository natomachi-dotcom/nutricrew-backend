// Unit tests for the hard validator (validatePlan and its building blocks).
// Pure logic only — no live Anthropic calls. Mocks model output directly so
// we can assert the validator actually rejects violations rather than
// trusting the model to avoid producing them.
//
// Usage: node test-validator.mjs

process.env.VERCEL = "1";

const {
  validatePlan, validateDay, findMealAllergenViolations, findMealDietViolations,
  findMealSlotContentViolation, findMealKitchenViolation, findMealCustomsViolation,
  getExpectedMealStructure,
} = await import("./server.js");

let passed = 0;
let failed = 0;
function check(label, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

function ing(...names) {
  return names.map(name => ({ name, quantity: 1, unit: "unit" }));
}

function meal(overrides = {}) {
  return {
    type: "Lunch", name: "Test Meal", description: "A meal.", prep: "assemble",
    calories: 500, protein: 20, carbs: 40, fat: 15, tags: [],
    ingredients: ing("chicken", "rice"), estimated_cost: 5, allergens_present: [],
    diet_tags: [], tip: "enjoy", emoji: "🍽️", prep_method: "no_cook",
    ...overrides,
  };
}

// ── A. ALLERGENS — derivatives/hidden sources ──────────────────────────
console.log("\n=== A. Allergen derivative matching ===");
{
  const dairyTerms = ["butter", "ghee", "buttermilk", "casein", "whey", "mascarpone", "ricotta"];
  for (const term of dairyTerms) {
    const v = findMealAllergenViolations(meal({ ingredients: ing(term, "rice") }), new Set(["milk"]), "");
    check(`dairy derivative caught: "${term}"`, v.some(x => x.tag === "milk"), JSON.stringify(v));
  }
  const nutTerms = ["marzipan", "pesto", "nutella", "praline"];
  for (const term of nutTerms) {
    const v = findMealAllergenViolations(meal({ ingredients: ing(term) }), new Set(["tree_nuts"]), "");
    check(`tree_nuts derivative caught: "${term}"`, v.some(x => x.tag === "tree_nuts"), JSON.stringify(v));
  }
  // Soy allergy must catch tamari (it's soy-based) — the OLD guard treated
  // tamari as a safe substitute, which was actually wrong for a real soy allergy.
  const soyV = findMealAllergenViolations(meal({ ingredients: ing("tamari") }), new Set(["soy"]), "");
  check('soy allergy catches "tamari" (previously treated as a false-safe exemption)', soyV.some(x => x.tag === "soy"), JSON.stringify(soyV));

  // Self-report cross-check: model honestly flags allergens_present even if
  // ingredients look clean.
  const selfReportV = findMealAllergenViolations(meal({ ingredients: ing("mystery sauce"), allergens_present: ["shellfish"] }), new Set(["shellfish"]), "");
  check("self-reported allergens_present triggers a violation", selfReportV.some(x => x.source === "self_report"), JSON.stringify(selfReportV));

  // No false positive when the allergen isn't required.
  const noReq = findMealAllergenViolations(meal({ ingredients: ing("peanut butter") }), new Set(["milk"]), "");
  check("no violation when the allergen isn't in the required set", noReq.length === 0, JSON.stringify(noReq));

  // Qualifier: a "gluten-free" self-label in prose shouldn't trip on itself.
  const qualified = findMealAllergenViolations(meal({ name: "Gluten-free tamari stir-fry", description: "Uses gluten-free tamari.", ingredients: ing("chicken", "rice") }), new Set(["wheat_gluten"]), "");
  check('self-label qualifier avoids false positive ("gluten-free tamari")', qualified.length === 0, JSON.stringify(qualified));
}

// ── C. Diet compliance ──────────────────────────────────────────────────
console.log("\n=== C. Diet compliance ===");
{
  const veganFail = findMealDietViolations(meal({ ingredients: ing("honey", "oats") }), ["vegan"]);
  check("vegan rejects honey", veganFail.some(v => v.dietTag === "vegan"), JSON.stringify(veganFail));
  const veganPass = findMealDietViolations(meal({ ingredients: ing("tofu", "broccoli") }), ["vegan"]);
  check("vegan accepts tofu+broccoli", veganPass.length === 0, JSON.stringify(veganPass));

  const halalFail = findMealDietViolations(meal({ ingredients: ing("bacon", "eggs") }), ["halal"]);
  check("halal rejects bacon", halalFail.some(v => v.dietTag === "halal"), JSON.stringify(halalFail));

  const halalPorkFail = findMealDietViolations(meal({ name: "Cured Meat Platter", description: "Traditional pork-cured charcuterie.", ingredients: ing("cured meat") }), ["halal"]);
  check("halal rejects literal pork mention (no qualifier exempts it)", halalPorkFail.some(v => v.dietTag === "halal"), JSON.stringify(halalPorkFail));

  // Regression: "sausage"/"bacon"/"ham"/"salami"/"pepperoni"/"chorizo" are
  // ambiguous — all have common non-pork/halal versions — but the bare
  // words were banned unconditionally, rejecting "Turkey Sausage"/"Halal
  // Sausage"/"Chicken Sausage" purely for containing "sausage". Confirmed
  // live 2026-07-20 across two separate test scenarios. pork/lard/
  // prosciutto/pancetta have no non-pork variant and stay always-banned.
  const turkeySausagePass = findMealDietViolations(meal({ name: "Turkey Sausage & Eggs", ingredients: ing("turkey sausage", "eggs") }), ["halal"]);
  check('halal accepts "turkey sausage" (no false positive)', turkeySausagePass.length === 0, JSON.stringify(turkeySausagePass));

  const halalSausagePass = findMealDietViolations(meal({ name: "Halal Beef Sausage Plate", ingredients: ing("halal beef sausage") }), ["halal"]);
  check('halal accepts "halal beef sausage" (no false positive)', halalSausagePass.length === 0, JSON.stringify(halalSausagePass));

  const bareSausageFail = findMealDietViolations(meal({ name: "Sausage & Eggs", ingredients: ing("sausage", "eggs") }), ["halal"]);
  check('halal still rejects unqualified "sausage" (ambiguous defaults to pork)', bareSausageFail.some(v => v.dietTag === "halal"), JSON.stringify(bareSausageFail));

  const prosciuttoFail = findMealDietViolations(meal({ name: "Prosciutto Wrap", ingredients: ing("prosciutto") }), ["halal"]);
  check('halal STILL always rejects "prosciutto" (no non-pork variant)', prosciuttoFail.some(v => v.dietTag === "halal"), JSON.stringify(prosciuttoFail));

  const kosherFail = findMealDietViolations(meal({ ingredients: ing("chicken", "cheese sauce") }), ["kosher"]);
  check("kosher rejects meat+dairy combined", kosherFail.some(v => v.detail.includes("meat and dairy")), JSON.stringify(kosherFail));

  const gfKeto = findMealDietViolations(meal({ ingredients: ing("almond flour", "eggs") }), ["low_carb"]);
  check("low_carb has no per-meal ingredient ban (checked at day level)", gfKeto.length === 0, JSON.stringify(gfKeto));

  const carnivoreSugarFail = findMealDietViolations(meal({ name: "Sweet Beef Jerky", description: "Cured with cane sugar.", ingredients: ing("beef jerky", "cane sugar") }), ["carnivore"]);
  check("carnivore rejects genuine sugar", carnivoreSugarFail.some(v => v.dietTag === "carnivore"), JSON.stringify(carnivoreSugarFail));

  const carnivoreOilFail = findMealDietViolations(meal({ name: "Canned Sardines in Olive Oil", ingredients: ing("canned sardines in olive oil") }), ["carnivore"]);
  check("carnivore rejects olive oil", carnivoreOilFail.some(v => v.dietTag === "carnivore"), JSON.stringify(carnivoreOilFail));

  // Regression: "Sugar-Free Beef Jerky" — a meal explicitly self-labeled to
  // comply with carnivore's own ban — was tripping the bare "sugar" pattern
  // on its own self-declaration, mirroring the exact self-label false-
  // positive class ALLERGEN_SELF_LABEL_QUALIFIER already guards against for
  // allergens. Confirmed live 2026-07-20: the model wrote exactly the
  // "sugar-free beef jerky" phrasing the carnivore prompt instructs, and it
  // got rejected anyway, looping the same violation across repair attempts.
  const carnivoreSugarFreePass = findMealDietViolations(meal({ name: "Sugar-Free Beef Jerky & Cheddar", ingredients: ing("sugar-free beef jerky", "cheddar cheese") }), ["carnivore"]);
  check('carnivore accepts self-labeled "sugar-free" jerky (no false positive)', carnivoreSugarFreePass.length === 0, JSON.stringify(carnivoreSugarFreePass));

  const carnivoreUnsweetenedPass = findMealDietViolations(meal({ name: "Unsweetened Dried Beef", ingredients: ing("unsweetened dried beef") }), ["carnivore"]);
  check('carnivore accepts "unsweetened" phrasing (no false positive)', carnivoreUnsweetenedPass.length === 0, JSON.stringify(carnivoreUnsweetenedPass));

  // Regression: "Canned Tuna Salad with Mayo" — tuna + mayo, zero actual
  // vegetables — was rejected purely because the word "salad" appeared in
  // the name. "Tuna/chicken/egg salad" are conventional mayo-based dish
  // names with no vegetable content; only a genuine green/garden salad
  // should trip this. Confirmed live 2026-07-20 across two separate
  // adversarial test runs: the model kept regenerating the same (correct,
  // compliant) dish and the validator kept rejecting it, exhausting repair
  // attempts on a false positive.
  const tunaSaladPass = findMealDietViolations(meal({ name: "Canned Tuna Salad with Mayo", ingredients: ing("canned tuna", "mayonnaise") }), ["carnivore"]);
  check('carnivore accepts "tuna salad" (no vegetables, no false positive)', tunaSaladPass.length === 0, JSON.stringify(tunaSaladPass));

  const chickenSaladPass = findMealDietViolations(meal({ name: "Chicken Salad Plate", ingredients: ing("chicken", "mayo") }), ["carnivore"]);
  check('carnivore accepts "chicken salad" (no vegetables, no false positive)', chickenSaladPass.length === 0, JSON.stringify(chickenSaladPass));

  const gardenSaladFail = findMealDietViolations(meal({ name: "Garden Salad with Vinaigrette", ingredients: ing("lettuce", "tomato", "olive oil") }), ["carnivore"]);
  check("carnivore STILL rejects a genuine garden salad", gardenSaladFail.some(v => v.dietTag === "carnivore"), JSON.stringify(gardenSaladFail));
}

// ── B. Meal slot / structure ─────────────────────────────────────────────
console.log("\n=== B. Meal slot content ===");
{
  const dinnerAtBreakfast = findMealSlotContentViolation(meal({ type: "Breakfast", name: "Chicken Shawarma Wrap", description: "A savory shawarma wrap." }));
  check("dinner-style dish flagged in Breakfast slot", !!dinnerAtBreakfast, JSON.stringify(dinnerAtBreakfast));

  const breakfastAtDinner = findMealSlotContentViolation(meal({ type: "Dinner", name: "Pancakes", description: "Fluffy pancakes with syrup." }));
  check("breakfast-style dish flagged in Dinner slot", !!breakfastAtDinner, JSON.stringify(breakfastAtDinner));

  const appetizer = findMealSlotContentViolation(meal({ type: "Dinner", name: "Beef Carpaccio", description: "Thin-sliced beef carpaccio." }));
  check("appetizer-scale dish flagged in Dinner slot", !!appetizer, JSON.stringify(appetizer));

  const fine = findMealSlotContentViolation(meal({ type: "Breakfast", name: "Veggie Omelette", description: "Eggs with spinach and feta." }));
  check("normal breakfast content passes", !fine, JSON.stringify(fine));

  const structure = getExpectedMealStructure({ calorieTarget: null, gainTarget: null, maintenanceTarget: 2000 });
  check("maintenance goal expects exactly 2 snacks", structure.snackMin === 2 && structure.snackMax === 2, JSON.stringify(structure));
}

// ── F. Kitchen access ────────────────────────────────────────────────────
console.log("\n=== F. Kitchen access ===");
{
  const stoveInHotel = findMealKitchenViolation(meal({ prep_method: "stove_oven" }), ["hotel"]);
  check("stove_oven meal flagged for hotel/no-kitchen day", !!stoveInHotel, JSON.stringify(stoveInHotel));
  const noCookInHotel = findMealKitchenViolation(meal({ prep_method: "no_cook" }), ["hotel"]);
  check("no_cook meal fine for hotel/no-kitchen day", !noCookInHotel);
  const microwaveOk = findMealKitchenViolation(meal({ prep_method: "microwave" }), ["microwave"]);
  check("microwave meal fine for microwave-only day", !microwaveOk);
  const stoveOk = findMealKitchenViolation(meal({ prep_method: "stove_oven" }), ["full_kitchen"]);
  check("stove_oven meal fine for full_kitchen day", !stoveOk);
}

// ── G. Customs ────────────────────────────────────────────────────────────
console.log("\n=== G. Customs (carried food) ===");
{
  const border = [{ id: "usa", name: { en: "USA" }, carriedBans: [] }];
  const rawMeatCarried = findMealCustomsViolation(meal({ ingredients: ing("raw chicken"), tip: "pack for the flight" }), border);
  check("raw meat flagged when carried across a restricted border", !!rawMeatCarried, JSON.stringify(rawMeatCarried));
  const rawMeatLocal = findMealCustomsViolation(meal({ ingredients: ing("raw chicken"), tip: "Buy locally at the stop and consume before next flight." }), border);
  check('same meal exempt when tip says "buy locally"', !rawMeatLocal);
  const airplane = findMealCustomsViolation(meal({ ingredients: ing("raw chicken"), prep_method: "airplane_provided" }), border);
  check("airplane_provided meals exempt from customs check", !airplane);
  const noBorders = findMealCustomsViolation(meal({ ingredients: ing("raw chicken") }), []);
  check("no restricted borders -> no customs check at all", !noBorders);
}

// ── D/E full-day: calories + budget ──────────────────────────────────────
console.log("\n=== D/E. Calories + budget (day-level) ===");
{
  const meals5 = [
    meal({ type: "Breakfast", calories: 500, estimated_cost: 3 }),
    meal({ type: "Lunch", calories: 600, estimated_cost: 4 }),
    meal({ type: "Dinner", calories: 700, estimated_cost: 5 }),
    meal({ type: "Snack", calories: 100, estimated_cost: 1 }),
    meal({ type: "Snack", calories: 100, estimated_cost: 1 }),
  ]; // total 2000 kcal, $14
  const opts = {
    requiredAllergenTags: new Set(), customAllergyTerm: "", activeDietTags: [],
    expectedStructure: { breakfast: 1, lunch: 1, dinner: 1, snackMin: 2, snackMax: 2 },
    calorieTarget: 2000, calorieTolerance: 0.10, perDayBudget: 20,
    kitchenList: ["full_kitchen"], restrictedBorders: [],
  };
  const ok = validateDay(meals5, opts);
  check("2000kcal/$14 day within 2000kcal target and $20 budget passes", ok.valid, JSON.stringify(ok.violations));

  const overCal = validateDay(meals5.map(m => ({ ...m, calories: m.calories * 2 })), { ...opts, perDayBudget: 999 });
  check("day at 2x target calories fails CALORIES check", overCal.violations.some(v => v.code === "CALORIES"), JSON.stringify(overCal.violations));

  const overBudget = validateDay(meals5, { ...opts, perDayBudget: 5 });
  check("day totaling $14 against a $5 budget fails BUDGET check", overBudget.violations.some(v => v.code === "BUDGET"), JSON.stringify(overBudget.violations));

  const wrongStructure = validateDay(meals5.slice(0, 4), opts); // only 1 snack instead of 2
  check("missing a required snack fails MEAL_SLOT_STRUCTURE", wrongStructure.violations.some(v => v.code === "MEAL_SLOT_STRUCTURE"), JSON.stringify(wrongStructure.violations));
}

// ── Full validatePlan(): force a violation and confirm rejection ────────
console.log("\n=== validatePlan(): forced-violation rejection (acceptance criterion) ===");
{
  const data = {
    email: "test@example.com", name: "Test User", gender: "female", weight: "70kg", dob: "1996-01-01",
    position: "cabin", diets: ["nut_free", "dairy_free"], goals: [], kitchen: ["full_kitchen"],
    departure: "YYZ", destinations: ["LAX"], going_usa: "no", timezone: "0",
  };
  // Mock a "model response" that smuggles peanut butter into a nut-free plan.
  const violatingPlan = {
    days: [{
      day: 1,
      meals: [
        meal({ type: "Breakfast", name: "Oatmeal", ingredients: ing("oats", "milk") }),
        meal({ type: "Lunch", name: "PB Sandwich", ingredients: ing("bread", "peanut butter") }),
        meal({ type: "Dinner", name: "Chicken & Rice", ingredients: ing("chicken", "rice") }),
        meal({ type: "Snack", name: "Fruit" }),
        meal({ type: "Snack", name: "Nuts" }),
      ],
    }],
  };
  const result = validatePlan(violatingPlan, data, "en");
  check("validatePlan REJECTS a plan with peanut butter for a nut-free user", !result.valid);
  check("violation correctly identifies the peanut_butter/tree_nuts+peanuts breach", result.violations.some(v => v.code === "ALLERGEN" && v.tag === "peanuts"), JSON.stringify(result.violations));
  check("violation correctly identifies the milk breach (dairy_free)", result.violations.some(v => v.code === "ALLERGEN" && v.tag === "milk"), JSON.stringify(result.violations));
  console.log(`  Full violation log for this forced-bad plan:`);
  for (const v of result.violations) console.log(`    ${JSON.stringify(v)}`);

  // A clean plan (no banned ingredients) for the same user should pass.
  // Departure YYZ (Canada) always triggers an on-return customs check
  // regardless of destination, so carried snacks here are deliberately
  // shelf-stable/packaged rather than fresh fruit (matches what the prompt
  // itself already instructs the model to do for carried items).
  const cleanPlan = {
    days: [{
      day: 1,
      meals: [
        meal({ type: "Breakfast", name: "Veggie Scramble", ingredients: ing("eggs", "spinach", "olive oil"), calories: 500 }),
        meal({ type: "Lunch", name: "Chicken Salad", ingredients: ing("chicken", "lettuce", "olive oil"), calories: 600 }),
        meal({ type: "Dinner", name: "Salmon & Rice", ingredients: ing("salmon", "rice", "broccoli"), calories: 700 }),
        meal({ type: "Snack", name: "Trail Mix Cup", ingredients: ing("dried cranberries", "sunflower seeds"), calories: 100 }),
        meal({ type: "Snack", name: "Rice Cakes", ingredients: ing("rice cakes"), calories: 100 }),
      ],
    }],
  };
  const cleanResult = validatePlan(cleanPlan, data, "en");
  check("validatePlan ACCEPTS a genuinely clean plan for the same user", cleanResult.valid, JSON.stringify(cleanResult.violations));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
