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

  // Regression: "corn tortilla" and "rice noodles"/"rice crackers" are
  // factually, genuinely gluten-free (not wheat-based at all) with no
  // self-label phrase needed — the bare word "tortilla"/"noodles"/
  // "crackers" was banning them unconditionally as wheat_gluten. This is a
  // BLOCK-severity allergen check with zero repair chance, so this false
  // positive killed the whole day outright. Confirmed live 2026-07-20:
  // "Scrambled Eggs & Corn Tortilla" was BLOCKed for a gluten-free user.
  const cornTortilla = findMealAllergenViolations(meal({ name: "Scrambled Eggs & Corn Tortilla", ingredients: ing("eggs", "corn tortilla") }), new Set(["wheat_gluten"]), "");
  check('"corn tortilla" is not flagged as wheat_gluten (no false positive)', cornTortilla.length === 0, JSON.stringify(cornTortilla));

  const riceNoodles = findMealAllergenViolations(meal({ name: "Rice Noodle Stir-Fry", ingredients: ing("rice noodles", "vegetables") }), new Set(["wheat_gluten"]), "");
  check('"rice noodles" is not flagged as wheat_gluten (no false positive)', riceNoodles.length === 0, JSON.stringify(riceNoodles));

  const riceCrackers = findMealAllergenViolations(meal({ name: "Rice Crackers with Hummus", ingredients: ing("rice crackers", "hummus") }), new Set(["wheat_gluten"]), "");
  check('"rice crackers" is not flagged as wheat_gluten (no false positive)', riceCrackers.length === 0, JSON.stringify(riceCrackers));

  // But a genuinely wheat-based tortilla/noodle/cracker (no corn/rice
  // qualifier) must still be caught.
  const flourTortilla = findMealAllergenViolations(meal({ name: "Flour Tortilla Wrap", ingredients: ing("flour tortilla") }), new Set(["wheat_gluten"]), "");
  check('"flour tortilla" is STILL flagged as wheat_gluten', flourTortilla.length > 0, JSON.stringify(flourTortilla));

  const bareCrackers = findMealAllergenViolations(meal({ name: "Crackers with Cheese", ingredients: ing("crackers", "cheese") }), new Set(["wheat_gluten"]), "");
  check('unqualified "crackers" (no corn/rice/gluten-free) is STILL flagged as wheat_gluten', bareCrackers.length > 0, JSON.stringify(bareCrackers));

  // Regression: live verification (2026-07-20) found the model reliably
  // self-reporting allergens_present=["wheat_gluten"] even when its own
  // ingredient list already says "gluten-free bread"/"gluten-free tortilla"
  // — the self-report was trusted unconditionally with zero cross-check
  // against the same qualifier exemption the ingredient-name scan already
  // has. This was the single dominant cause of "Day X couldn't be
  // generated" (BLOCK severity, zero repair chance). The self-report must
  // now be treated as contradicted (not trusted) when the ingredient list
  // gives it a qualified, safe explanation.
  const contradictedSelfReport = findMealAllergenViolations(
    meal({ name: "Scrambled Eggs with Toast", ingredients: ing("eggs", "gluten-free bread", "margarine"), allergens_present: ["eggs", "wheat_gluten"] }),
    new Set(["wheat_gluten"]), ""
  );
  check('self-reported "wheat_gluten" contradicted by "gluten-free bread" ingredient is NOT flagged', contradictedSelfReport.length === 0, JSON.stringify(contradictedSelfReport));

  // But a self-report with NO qualified ingredient explanation (a genuinely
  // hidden/derivative allergen the model knows about but didn't spell out as
  // a discrete ingredient) must still be trusted and caught.
  const genuineSelfReport = findMealAllergenViolations(
    meal({ name: "Chicken with Teriyaki Glaze", ingredients: ing("chicken", "teriyaki glaze"), allergens_present: ["wheat_gluten"] }),
    new Set(["wheat_gluten"]), ""
  );
  check("self-reported allergen with no qualified ingredient explanation is STILL flagged", genuineSelfReport.some(x => x.source === "self_report"), JSON.stringify(genuineSelfReport));

  // Regression: live verification (2026-07-20, hotel/no-kitchen + gluten-free
  // combo) found the qualifier exemption itself too narrow — it only
  // recognized hyphenated "gluten-free"/"wheat-free", missing an underscore
  // variant the model sometimes writes ("gluten_free bread") and a "no
  // added ... wheat" negation phrase in a packaged-snack description. Both
  // are genuinely safe, correctly-labeled ingredients that were getting
  // BLOCKed with zero repair chance.
  const underscoreQualified = findMealAllergenViolations(meal({ name: "Scrambled Eggs with Toast", ingredients: ing("eggs", "gluten_free bread") }), new Set(["wheat_gluten"]), "");
  check('"gluten_free bread" (underscore) is not flagged as wheat_gluten', underscoreQualified.length === 0, JSON.stringify(underscoreQualified));

  const noAddedWheatQualified = findMealAllergenViolations(meal({ name: "Rice Cakes with Almond Butter", ingredients: ing("rice cakes", "almond butter (natural, no added sugar or wheat)") }), new Set(["wheat_gluten"]), "");
  check('"no added sugar or wheat" negation phrase is not flagged as wheat_gluten', noAddedWheatQualified.length === 0, JSON.stringify(noAddedWheatQualified));

  // Regression: live verification (2026-07-20, broad diet/kitchen matrix)
  // found the self-report contradiction check itself too narrow — it only
  // caught "matched but qualifier-exempted" ingredients, not "exempted via
  // the corn/rice lookbehind and never matched the strict pattern at all".
  // "gluten-free corn tortilla" still tripped a wheat_gluten self-report
  // BLOCK because patternMatches was empty (the strict pattern's own
  // corn/rice exemption meant it never matched to begin with).
  const cornTortillaSelfReport = findMealAllergenViolations(
    meal({ name: "Canned Tuna Salad Wrap", ingredients: ing("canned tuna", "gluten-free mayonnaise", "gluten-free corn tortilla"), allergens_present: ["fish", "eggs", "wheat_gluten"] }),
    new Set(["wheat_gluten"]), ""
  );
  check('self-reported wheat_gluten contradicted by "gluten-free corn tortilla" is NOT flagged', cornTortillaSelfReport.length === 0, JSON.stringify(cornTortillaSelfReport));

  // Regression: bare "milk"/"yogurt" had no plant-based exemption at all —
  // "oat milk", "unsweetened almond milk", "coconut milk (canned)", and
  // "coconut yogurt" were all BLOCKed as dairy for a dairy-free user, even
  // though every one of them is the correct, safe choice for that exact
  // restriction. Confirmed live 2026-07-20 across multiple dairy_free runs.
  const oatMilk = findMealAllergenViolations(meal({ name: "Oatmeal with Berries", ingredients: ing("oats", "oat milk", "berries") }), new Set(["milk"]), "");
  check('"oat milk" is not flagged as milk', oatMilk.length === 0, JSON.stringify(oatMilk));

  const almondMilk = findMealAllergenViolations(meal({ name: "Oatmeal with Banana", ingredients: ing("oats", "unsweetened almond milk") }), new Set(["milk"]), "");
  check('"unsweetened almond milk" is not flagged as milk', almondMilk.length === 0, JSON.stringify(almondMilk));

  const coconutMilk = findMealAllergenViolations(meal({ name: "Curry with Rice", ingredients: ing("vegetables", "coconut milk (canned, full-fat)", "rice") }), new Set(["milk"]), "");
  check('"coconut milk (canned, full-fat)" is not flagged as milk', coconutMilk.length === 0, JSON.stringify(coconutMilk));

  const coconutYogurt = findMealAllergenViolations(meal({ name: "Coconut Yogurt with Granola", ingredients: ing("coconut yogurt (shelf-stable or refrigerated)", "granola") }), new Set(["milk"]), "");
  check('"coconut yogurt" is not flagged as milk', coconutYogurt.length === 0, JSON.stringify(coconutYogurt));

  // But real dairy milk/yogurt (no plant qualifier) must still be caught.
  const realMilk = findMealAllergenViolations(meal({ name: "Cereal with Milk", ingredients: ing("cereal", "milk") }), new Set(["milk"]), "");
  check('unqualified "milk" is STILL flagged', realMilk.length > 0, JSON.stringify(realMilk));

  const realYogurt = findMealAllergenViolations(meal({ name: "Greek Yogurt with Honey", ingredients: ing("greek yogurt", "honey") }), new Set(["milk"]), "");
  check('unqualified "greek yogurt" is STILL flagged', realYogurt.length > 0, JSON.stringify(realYogurt));

  // Regression: the diet rules explicitly instruct the model to write a
  // cross-contamination warning in the tip for allergen-adjacent items —
  // the resulting advisory sentence ("verify no sesame cross-contact")
  // mentions the allergen word but is a SAFETY REMINDER, not a stated
  // ingredient. Confirmed live 2026-07-20: 6/6 sesame_free test runs BLOCKed
  // a genuinely sesame-free meal purely because its own tip said "sesame"
  // in a verification sentence.
  const crossContactAdvisory = findMealAllergenViolations(
    meal({ name: "Scrambled Eggs with Toast", ingredients: ing("eggs", "bread", "butter"), tip: "Hotel may provide butter and jam packets — confirm no sesame-containing ingredients." }),
    new Set(["sesame"]), ""
  );
  check('a cross-contamination advisory mentioning "sesame" is not flagged as an ingredient', crossContactAdvisory.length === 0, JSON.stringify(crossContactAdvisory));

  // But a genuine sesame mention with no advisory framing must still be caught.
  const realSesame = findMealAllergenViolations(meal({ name: "Hummus Plate", description: "Chickpea hummus with tahini and sesame seeds on top.", ingredients: ing("chickpeas", "tahini") }), new Set(["sesame"]), "");
  check('a genuine sesame mention (no cross-contamination framing) is STILL flagged', realSesame.length > 0, JSON.stringify(realSesame));

  // Regression: the negation-window check above still missed several real
  // advisory phrasings the model actually used live ("avoid cross-contact
  // with shellfish-handling surfaces", "your shellfish allergy does not
  // affect this snack", "given your shellfish allergy profile") — none
  // state the meal contains the allergen, they're all restating the user's
  // OWN restriction back at them, in the tip field specifically (which the
  // diet rules explicitly reserve for exactly this kind of advisory). The
  // free-text scan now excludes tip entirely rather than chasing every
  // possible negation phrasing.
  const tipAdvisoryPhrasing = findMealAllergenViolations(
    meal({ name: "Mixed Nuts & Dried Fruit", description: "A simple blend of roasted almonds, cashews, and dried cranberries.", ingredients: ing("almonds", "cashews", "dried cranberries"), tip: "Watch for tree_nuts allergen if you have any sensitivity; your shellfish allergy does not affect this snack." }),
    new Set(["shellfish"]), ""
  );
  check("tip-only advisory phrasing (not caught by negation window) is not flagged", tipAdvisoryPhrasing.length === 0, JSON.stringify(tipAdvisoryPhrasing));

  // But a genuine allergen stated in the DESCRIPTION (not just the tip) must
  // still be caught — only tip is excluded, not description/name.
  const realShellfishInDescription = findMealAllergenViolations(meal({ name: "Seafood Pasta", description: "Pasta tossed with shrimp and scallops in garlic butter.", ingredients: ing("pasta", "shrimp", "scallops") }), new Set(["shellfish"]), "");
  check("shellfish stated in description is STILL flagged", realShellfishInDescription.length > 0, JSON.stringify(realShellfishInDescription));
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

  const realCake = findMealSlotContentViolation(meal({ type: "Dinner", name: "Chocolate Cake", description: "A rich chocolate cake." }));
  check("a genuine cake is STILL flagged as dessert-as-meal", !!realCake, JSON.stringify(realCake));

  // Regression: live verification (2026-07-20, hotel/no-kitchen + gluten-free
  // combo) found "Tuna Salad with Rice Cakes" repeatedly rejected as
  // "'Cakes' is dessert standing in as the entire meal" — a cross-day repair
  // loop that never converged because rice cakes are a genuinely safe,
  // gluten-free-friendly savory snack/side, not a dessert.
  const riceCakesLunch = findMealSlotContentViolation(meal({ type: "Lunch", name: "Tuna Salad with Rice Cakes", description: "Canned tuna salad served with rice cakes." }));
  check('"rice cakes" is not flagged as dessert-as-meal', !riceCakesLunch, JSON.stringify(riceCakesLunch));

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

  // Regression: live verification (2026-07-20) found kitchen_access repairs
  // failing repeatedly on hotel/no-kitchen days — the repair message only
  // restated the problem (wrong prep_method) without saying what prep_method
  // TO use instead, unlike the initial-generation prompt which always names
  // the exact allowed set. The violation now carries allowedMethods so the
  // repair message can hand over the exact fix directly.
  check('kitchen violation carries allowedMethods for the repair message', Array.isArray(stoveInHotel?.allowedMethods) && stoveInHotel.allowedMethods.includes("no_cook"), JSON.stringify(stoveInHotel));
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
