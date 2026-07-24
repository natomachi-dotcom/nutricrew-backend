// Unit tests for meal-appropriateness validation (slot content, portion
// scale, cross-day variety, titles, icons). Pure logic only — no live
// Anthropic calls. Mocks model output directly, including the exact
// production bug report (sardines served as breakfast, two days running).
//
// Usage: node test-meal-appropriateness.mjs

process.env.VERCEL = "1";

const {
  validatePlan, findMealSlotContentViolation, findMealPortionScaleViolation,
  findMealTitleViolation, findMealIconViolation, getMealHeroCategory,
  findCrossDayVarietyViolations, titlesShareSignificantPattern,
  findMealAllergenViolations, ALLERGEN_DERIVATIVES, deterministicTitleFix, deterministicFodmapGarlicFix,
  deterministicIngredientStripFix, WALL_RULES, MEAL_SLOT_FORCED_CHOICES,
} = await import("./server.js");

let passed = 0;
let failed = 0;
function check(label, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

function ing(...names) { return names.map(name => ({ name, quantity: 1, unit: "unit" })); }
function meal(overrides = {}) {
  return {
    type: "Breakfast", name: "Meal", description: "A meal.", prep: "assemble",
    calories: 500, protein: 20, carbs: 40, fat: 15, tags: [],
    ingredients: ing("eggs", "toast"), estimated_cost: 5, allergens_present: [],
    diet_tags: [], tip: "enjoy", emoji: "🍳", prep_method: "no_cook",
    ...overrides,
  };
}

// ── PRODUCTION BUG, REPRODUCED EXACTLY ──────────────────────────────────
console.log("\n=== Exact production bug: sardines at breakfast, 2 days running ===");
{
  const day1Meal = meal({
    name: "Mediterranean Greek Yogurt Parfait with Sardines & Olive Oil Drizzle",
    description: "Greek yogurt topped with sardines and a drizzle of olive oil.",
    ingredients: ing("greek yogurt", "sardines", "olive oil", "honey"),
    emoji: "🐟🥣",
  });
  const v1 = findMealSlotContentViolation(day1Meal);
  check("sardines-at-breakfast content REJECTED", !!v1, JSON.stringify(v1));

  const day2Meal = meal({
    name: "Mediterranean Overnight Oats with Sardines & Olive Oil Drizzle",
    description: "Overnight oats topped with sardines and olive oil.",
    ingredients: ing("oats", "sardines", "olive oil"),
    emoji: "🐟🥣",
  });
  const v2 = findMealSlotContentViolation(day2Meal);
  check("day-2 sardines-at-breakfast ALSO rejected independently", !!v2, JSON.stringify(v2));

  const titleV1 = findMealTitleViolation(day1Meal);
  check('title rejected for containing diet name "Mediterranean"', !!titleV1, JSON.stringify(titleV1));

  const iconV1 = findMealIconViolation(day1Meal);
  check("fish icon on Breakfast rejected (matches the reported icon bug)", !!iconV1, JSON.stringify(iconV1));

  const cross = findCrossDayVarietyViolations([
    { day: 1, meals: [day1Meal, meal({ type: "Lunch" }), meal({ type: "Dinner" })] },
    { day: 2, meals: [day2Meal, meal({ type: "Lunch" }), meal({ type: "Dinner" })] },
  ]);
  check("cross-day repeat (sardines hero + shared title pattern) caught", cross.length > 0, JSON.stringify(cross));
  console.log(`  Cross-day violations detected: ${JSON.stringify(cross, null, 2)}`);
}

// ── AC #5: forced violations, confirm rejection ──────────────────────────
console.log("\n=== AC #5: force violations, confirm validator rejects each ===");
{
  const cerealAtDinner = meal({ type: "Dinner", name: "Cereal Bowl", description: "A bowl of cereal with milk.", ingredients: ing("cereal", "milk") });
  check("cereal at DINNER rejected", !!findMealSlotContentViolation(cerealAtDinner), JSON.stringify(findMealSlotContentViolation(cerealAtDinner)));

  const roastAsSnack = meal({ type: "Snack", name: "Pot Roast", description: "A hearty pot roast with vegetables.", ingredients: ing("beef", "carrots", "potatoes", "onion", "beef stock"), calories: 600 });
  const slotV = findMealSlotContentViolation(roastAsSnack);
  const portionV = findMealPortionScaleViolation(roastAsSnack, 2000);
  check("roast as SNACK rejected (content)", !!slotV, JSON.stringify(slotV));
  check("roast as SNACK also rejected (portion scale, 600/2000=30%)", !!portionV, JSON.stringify(portionV));

  // Allergen present (peanut) for a nut-free user, via the full validatePlan path.
  const data = {
    email: "test@example.com", name: "V", gender: "female", weight: "70kg", dob: "1996-01-01",
    position: "cabin", diets: ["nut_free"], goals: [], kitchen: ["full_kitchen"],
    departure: "YOW", destinations: ["YOW"], going_usa: "no", timezone: "0",
  };
  const violatingPlan = {
    days: [{
      day: 1,
      meals: [
        meal({ type: "Breakfast", name: "Veggie Scramble", ingredients: ing("eggs", "spinach"), calories: 500 }),
        meal({ type: "Lunch", name: "PB Sandwich", ingredients: ing("bread", "peanut butter"), calories: 600 }),
        meal({ type: "Dinner", name: "Chicken & Rice", ingredients: ing("chicken", "rice"), calories: 700 }),
        meal({ type: "Snack", name: "Fruit Cup", ingredients: ing("apple"), calories: 100 }),
        meal({ type: "Snack", name: "Crackers", ingredients: ing("rice crackers"), calories: 100 }),
      ],
    }],
  };
  const result = validatePlan(violatingPlan, data, "en");
  check("full plan with a peanut allergen present is REJECTED end-to-end", !result.valid);
  check("violation log identifies the allergen specifically", result.violations.some(v => v.code === "ALLERGEN" && v.tag === "peanuts"), JSON.stringify(result.violations));
  console.log(`  Full violation log for the forced-bad plan:`);
  for (const v of result.violations) console.log(`    ${JSON.stringify(v)}`);
}

// ── Normal, appropriate meals pass ────────────────────────────────────────
console.log("\n=== Normal meals pass every check ===");
{
  const normalBreakfast = meal({ type: "Breakfast", name: "Veggie Omelette", description: "Eggs with spinach and feta.", ingredients: ing("eggs", "spinach", "feta"), emoji: "🍳🧀" });
  check("normal breakfast passes slot content", !findMealSlotContentViolation(normalBreakfast));
  check("normal breakfast passes icon check", !findMealIconViolation(normalBreakfast));
  check("normal breakfast title passes", !findMealTitleViolation(normalBreakfast));

  const smokedSalmonBagel = meal({ type: "Breakfast", name: "Smoked Salmon Bagel", description: "A bagel with smoked salmon and cream cheese.", ingredients: ing("bagel", "smoked salmon", "cream cheese"), emoji: "🐟🥯" });
  check("smoked salmon bagel is a NORMAL breakfast (not rejected)", !findMealSlotContentViolation(smokedSalmonBagel));
  check("smoked salmon bagel's fish icon is exempted (explicit exception)", !findMealIconViolation(smokedSalmonBagel));

  const normalSnack = meal({ type: "Snack", name: "Apple & Almond Butter", ingredients: ing("apple", "almond butter"), calories: 150 });
  check("normal snack passes portion scale", !findMealPortionScaleViolation(normalSnack, 2000));

  // Regression: findMealIconViolation used to also reject Breakfast's fish-
  // emoji ban on Snack meals, putting it in direct conflict with content this
  // codebase explicitly allows (DINNER_STYLE_AT_BREAKFAST_PATTERN treats
  // canned sardines/tuna/salmon as fine for Snack, only banning them at
  // Breakfast) — a fish-based Snack could never pass repair, since the model
  // kept proposing the correct fish emoji and this rule kept rejecting it.
  // Confirmed live 2026-07-20 against real production-style requests.
  const sardineSnack = meal({ type: "Snack", name: "Canned Sardines in Oil", description: "Whole sardines canned in oil.", ingredients: ing("canned sardines in oil"), emoji: "🐟🥫" });
  check("fish emoji on a Snack is NOT rejected (sardines/tuna/salmon are a valid Snack)", !findMealIconViolation(sardineSnack));

  const sardineBreakfast = meal({ type: "Breakfast", name: "Sardine Toast", description: "Toast topped with sardines.", ingredients: ing("bread", "canned sardines"), emoji: "🐟🍞" });
  check("fish emoji on Breakfast is STILL rejected (the original reported bug)", !!findMealIconViolation(sardineBreakfast));

  const longTitle = meal({ name: "Grilled Herb-Crusted Chicken Breast with Roasted Seasonal Vegetables and Quinoa" });
  check("overly long title rejected", !!findMealTitleViolation(longTitle));

  const goodLengthTitle = meal({ name: "Greek Yogurt Parfait with Berries & Granola" });
  check('user\'s own example title ("Greek Yogurt Parfait with Berries & Granola") passes length check', !findMealTitleViolation(goodLengthTitle));

  // Regression: told only "don't name the diet," the model reliably swapped
  // ONE diet-name violation for ANOTHER instead of dropping the qualifier
  // entirely — "...Gluten-Free Toast" -> repair -> "...Dairy-Free Toast" ->
  // repair -> back to "...Gluten-Free Toast", exhausting REPAIR_ATTEMPTS in
  // a loop that never converges. Confirmed live 2026-07-20 across 2 of 3
  // adversarial test runs. findMealTitleViolation now computes the exact
  // corrected name (diet term stripped) so the repair message can hand it
  // over directly instead of leaving the model to guess.
  const dietNameTitle = meal({ name: "Scrambled Eggs with Gluten-Free Toast" });
  const dietNameViolation = findMealTitleViolation(dietNameTitle);
  check("diet name in title is still rejected", !!dietNameViolation, JSON.stringify(dietNameViolation));
  check('suggestedName strips the diet qualifier, not just flags it', dietNameViolation?.suggestedName === "Scrambled Eggs with Toast", JSON.stringify(dietNameViolation));

  const dairyFreeTitle = meal({ name: "Scrambled Eggs with Dairy-Free Toast" });
  const dairyFreeViolation = findMealTitleViolation(dairyFreeTitle);
  check('suggestedName works for a DIFFERENT diet name too (not hardcoded to gluten-free)', dairyFreeViolation?.suggestedName === "Scrambled Eggs with Toast", JSON.stringify(dairyFreeViolation));

  // Regression: even with the directive repair message above, live
  // verification (2026-07-20, hotel/no-kitchen + gluten-free) found the
  // model STILL failing to comply and exhausting REPAIR_ATTEMPTS on a
  // cross-day repair — "Tuna Salad with Gluten-Free Crackers" survived 2
  // full regeneration attempts. deterministicTitleFix applies the known-
  // correct name directly instead of gambling another model round-trip on
  // it, when title_quality is the ONLY remaining problem.
  const titleOnlyViolation = { ruleId: "title_quality", suggestedName: "Tuna Salad with Crackers" };
  const fixed = deterministicTitleFix({ name: "Tuna Salad with Gluten-Free Crackers", calories: 400 }, [titleOnlyViolation]);
  check("deterministicTitleFix applies the suggestedName when title is the only problem", fixed?.name === "Tuna Salad with Crackers", JSON.stringify(fixed));

  const otherViolation = { ruleId: "kitchen_access", detail: "wrong prep_method" };
  const notFixed = deterministicTitleFix({ name: "Tuna Salad with Gluten-Free Crackers" }, [titleOnlyViolation, otherViolation]);
  check("deterministicTitleFix declines when OTHER violations are also present", notFixed === null, JSON.stringify(notFixed));

  // Regression: live verification (2026-07-22) found fodmap garlic/onion the
  // single most persistent repair failure in production — even a
  // strengthened prompt AND a directive repair message didn't reliably stop
  // the model from reaching for it again on the next attempt.
  // deterministicFodmapGarlicFix strips the word out directly instead of
  // gambling a third regeneration on model compliance, when it's the ONLY
  // remaining problem.
  const garlicViolation = { ruleId: "diet_compliance", dietTag: "fodmap", detail: "garlic" };
  const garlicMeal = {
    name: "Rotisserie Chicken with Garlic Rice",
    description: "Rotisserie chicken with garlic rice and carrots.",
    tip: "Buy locally and consume before next flight.",
    ingredients: [{ name: "rotisserie chicken" }, { name: "garlic" }, { name: "rice" }, { name: "carrots" }],
  };
  const garlicFixed = deterministicFodmapGarlicFix(garlicMeal, [garlicViolation]);
  check("deterministicFodmapGarlicFix removes garlic from ingredients", !garlicFixed.ingredients.some(i => /garlic/i.test(i.name)), JSON.stringify(garlicFixed?.ingredients));
  check("deterministicFodmapGarlicFix strips garlic from name/description", !/garlic/i.test(garlicFixed.name) && !/garlic/i.test(garlicFixed.description), JSON.stringify(garlicFixed));

  const onionViolation = { ruleId: "diet_compliance", dietTag: "fodmap", detail: "onion" };
  const onionFixed = deterministicFodmapGarlicFix({ name: "Beef Stew", ingredients: [{ name: "beef" }, { name: "onion" }] }, [onionViolation]);
  check("deterministicFodmapGarlicFix also handles onion", !onionFixed.ingredients.some(i => /onion/i.test(i.name)), JSON.stringify(onionFixed?.ingredients));

  const otherDietViolation = { ruleId: "diet_compliance", dietTag: "fodmap", detail: "honey" };
  const notGarlicFixed = deterministicFodmapGarlicFix({ name: "Yogurt with Honey" }, [otherDietViolation]);
  check("deterministicFodmapGarlicFix declines for a non-garlic/onion fodmap violation", notGarlicFixed === null, JSON.stringify(notGarlicFixed));

  const garlicPlusOther = deterministicFodmapGarlicFix(garlicMeal, [garlicViolation, { ruleId: "kitchen_access", detail: "wrong prep_method" }]);
  check("deterministicFodmapGarlicFix declines when OTHER violations are also present", garlicPlusOther === null, JSON.stringify(garlicPlusOther));

  // General escape hatch: when a meal is stuck on ANY single flagged
  // ingredient (not just fodmap garlic/onion) after the model's normal
  // repair attempts are exhausted, strip it instead of failing the whole
  // day. This is the last-resort safety net wired in right before a day
  // would otherwise be marked "couldn't be generated."
  const sugarViolation = { ruleId: "diet_compliance", dietTag: "carnivore", detail: "sugar" };
  const jerkyMeal = { name: "Sugared Beef Jerky", description: "Beef jerky with a touch of sugar in the cure.", ingredients: [{ name: "beef jerky" }, { name: "sugar" }, { name: "salt" }] };
  const jerkyFixed = deterministicIngredientStripFix(jerkyMeal, [sugarViolation]);
  check("deterministicIngredientStripFix generalizes to carnivore sugar", !jerkyFixed.ingredients.some(i => /sugar/i.test(i.name)) && !/sugar/i.test(jerkyFixed.description), JSON.stringify(jerkyFixed));

  const butterViolation = { ruleId: "diet_compliance", dietTag: "vegan", detail: "butter" };
  const toastMeal = { name: "Toast with Butter", ingredients: [{ name: "toast" }, { name: "butter" }] };
  const toastFixed = deterministicIngredientStripFix(toastMeal, [butterViolation]);
  check("deterministicIngredientStripFix generalizes to vegan butter", !toastFixed.ingredients.some(i => /butter/i.test(i.name)), JSON.stringify(toastFixed));

  // Declines for structural, non-ingredient violations (can't fix a
  // combination rule by removing one word) — e.g. kosher's hand-written
  // "meat and dairy combined in one meal" sentence.
  const kosherStructural = { ruleId: "diet_compliance", dietTag: "kosher", detail: "meat and dairy combined in one meal" };
  const kosherNotFixed = deterministicIngredientStripFix({ name: "Cheeseburger" }, [kosherStructural]);
  check("deterministicIngredientStripFix declines for a structural (multi-word sentence) violation", kosherNotFixed === null, JSON.stringify(kosherNotFixed));

  // Declines when stripping would leave the meal with zero ingredients.
  const onlyIngredientViolation = { ruleId: "diet_compliance", dietTag: "vegan", detail: "honey" };
  const emptyResult = deterministicIngredientStripFix({ name: "Honey", ingredients: [{ name: "honey" }] }, [onlyIngredientViolation]);
  check("deterministicIngredientStripFix declines rather than leave zero ingredients", emptyResult === null, JSON.stringify(emptyResult));

  // Declines for non-diet_compliance violations (e.g. allergens) — this is
  // never the mechanism for silently dropping a personal/medical allergen.
  const allergenViolation = { code: "ALLERGEN", ruleId: "no_allergens", detail: "peanuts" };
  const allergenNotFixed = deterministicIngredientStripFix({ name: "PB Sandwich", ingredients: [{ name: "peanut butter" }, { name: "bread" }] }, [allergenViolation]);
  check("deterministicIngredientStripFix declines for allergen violations (safety boundary)", allergenNotFixed === null, JSON.stringify(allergenNotFixed));
}

// ── Hero classification + title-pattern matching ──────────────────────────
console.log("\n=== Hero classification & title-pattern matching ===");
{
  check('getMealHeroCategory identifies "sardines"', getMealHeroCategory(meal({ name: "Sardine Toast" })) === "sardines");
  check('getMealHeroCategory identifies "chicken"', getMealHeroCategory(meal({ name: "Grilled Chicken Salad" })) === "chicken");
  check("getMealHeroCategory returns null for a plain fruit snack", getMealHeroCategory(meal({ name: "Apple Slices", ingredients: ing("apple") })) === null);
  check("identical trailing 'with' clauses flagged as a repeating pattern",
    titlesShareSignificantPattern("Mediterranean Parfait with Sardines & Olive Oil Drizzle", "Overnight Oats with Sardines & Olive Oil Drizzle"));
  check("genuinely different titles are NOT flagged",
    !titlesShareSignificantPattern("Veggie Omelette with Spinach", "Overnight Oats with Berries"));
}

// ── No false positives on 3 days of genuinely varied breakfasts ──────────
console.log("\n=== No cross-day false positive on genuinely varied breakfasts ===");
{
  const days = [
    { day: 1, meals: [
      meal({ type: "Breakfast", name: "Veggie Omelette", ingredients: ing("eggs", "spinach") }),
      meal({ type: "Lunch", name: "Chicken Caesar Salad", ingredients: ing("chicken", "lettuce", "parmesan") }),
      meal({ type: "Dinner", name: "Grilled Salmon & Rice", ingredients: ing("salmon", "rice", "broccoli") }),
    ] },
    { day: 2, meals: [
      meal({ type: "Breakfast", name: "Greek Yogurt Parfait", ingredients: ing("greek yogurt", "berries", "granola") }),
      meal({ type: "Lunch", name: "Turkey Club Wrap", ingredients: ing("turkey", "tortilla", "avocado") }),
      meal({ type: "Dinner", name: "Beef Stir-Fry", ingredients: ing("beef", "rice", "vegetables") }),
    ] },
    { day: 3, meals: [
      meal({ type: "Breakfast", name: "Overnight Oats", ingredients: ing("oats", "almond milk", "chia seeds") }),
      meal({ type: "Lunch", name: "Lentil Soup & Bread", ingredients: ing("lentils", "bread", "carrots") }),
      meal({ type: "Dinner", name: "Roast Chicken & Potatoes", ingredients: ing("chicken", "potatoes", "green beans") }),
    ] },
  ];
  const cross = findCrossDayVarietyViolations(days);
  check("3 genuinely varied breakfasts produce zero cross-day violations", cross.length === 0, JSON.stringify(cross));
}

// ── Regression: "yog?hurt" only matched "yohurt"/"yoghurt", never the ────
// ── common American spelling "yogurt" — found while chasing what looked ──
// ── like a cross-day false positive; actually a real allergen-safety gap. ─
console.log("\n=== Regression: American-spelling \"yogurt\" matches the milk allergen ===");
{
  check('ALLERGEN_DERIVATIVES.milk matches "yogurt" (US spelling)', ALLERGEN_DERIVATIVES.milk.test("yogurt"));
  check('ALLERGEN_DERIVATIVES.milk matches "yoghurt" (UK spelling)', ALLERGEN_DERIVATIVES.milk.test("yoghurt"));
  const dairyAllergyMeal = meal({ type: "Snack", name: "Yogurt Cup", ingredients: ing("yogurt", "honey") });
  const v = findMealAllergenViolations(dairyAllergyMeal, new Set(["milk"]), "");
  check('a meal with "yogurt" (no "h") is caught for a dairy-allergic user', v.some(x => x.tag === "milk"), JSON.stringify(v));
}

// ── Regression: "Grilled Steak & Eggs" at Breakfast survived BOTH repair ──
// ── attempts and 503'd the whole plan (production, 2026-07-24) — the ────
// ── repair message was too vague to converge. Message must now name ──────
// ── concrete breakfast-appropriate alternatives instead of just saying ───
// ── "make it typical".──────────────────────────────────────────────────
console.log("\n=== Regression: directive meal-slot repair messages (2026-07-24 503) ===");
{
  const steakBreakfast = meal({ type: "Breakfast", name: "Grilled Steak & Eggs", description: "Steak with eggs.", ingredients: ing("steak", "eggs") });
  const v = findMealSlotContentViolation(steakBreakfast);
  check('"Grilled Steak & Eggs" at Breakfast is flagged', !!v, JSON.stringify(v));
  check('violation carries category "dinner_at_breakfast"', v?.category === "dinner_at_breakfast", JSON.stringify(v));

  const rule = WALL_RULES.find(r => r.id === "meal_slot_appropriateness");
  const fullViolation = { ...v, mealType: "Breakfast", mealName: steakBreakfast.name };
  const msg = rule.message(fullViolation);
  check("dinner_at_breakfast message names concrete breakfast alternatives", /\beggs\b/i.test(msg) && /\boats\b/i.test(msg), msg);
  check("dinner_at_breakfast message does NOT just say 'genuinely typical' with no examples", msg.length > 100, msg);

  // Other categories also get concrete, non-generic guidance.
  const dessertDinner = meal({ type: "Dinner", name: "Chocolate Cake", description: "A whole cake as dinner.", ingredients: ing("cake") });
  const dv = findMealSlotContentViolation(dessertDinner);
  check('dessert-as-dinner carries category "dessert_as_meal"', dv?.category === "dessert_as_meal", JSON.stringify(dv));
  const dmsg = rule.message({ ...dv, mealType: "Dinner", mealName: dessertDinner.name });
  check("dessert_as_meal message names a real substitute (protein/vegetable/starch)", /protein/i.test(dmsg) && /vegetable/i.test(dmsg), dmsg);
}

// ── Regression: forced-choice fallback has full category coverage ────────
// ── (the last real attempt before a slot mismatch is silently accepted — ─
// ── every category findMealSlotContentViolation can produce must have a ──
// ── non-empty forced-choice list, or that category falls straight ────────
// ── through to acceptance with no extra attempt). ─────────────────────────
console.log("\n=== Regression: MEAL_SLOT_FORCED_CHOICES covers every violation category ===");
{
  const cases = [
    { meal: meal({ type: "Breakfast", name: "Grilled Steak & Eggs", description: "Steak with eggs.", ingredients: ing("steak", "eggs") }), expectCategory: "dinner_at_breakfast" },
    { meal: meal({ type: "Dinner", name: "Pancakes & Waffles", description: "A stack of pancakes.", ingredients: ing("pancakes", "syrup") }), expectCategory: "breakfast_at_meal" },
    { meal: meal({ type: "Lunch", name: "Beef Carpaccio", description: "Thin beef carpaccio.", ingredients: ing("beef", "olive oil") }), expectCategory: "appetizer_at_meal" },
    { meal: meal({ type: "Dinner", name: "Chocolate Cake", description: "A whole cake as dinner.", ingredients: ing("cake") }), expectCategory: "dessert_as_meal" },
    { meal: meal({ type: "Snack", name: "Beef Stew", description: "A full beef stew.", ingredients: ing("beef", "potatoes") }), expectCategory: "heavy_main_as_snack" },
  ];
  for (const { meal: m, expectCategory } of cases) {
    const v = findMealSlotContentViolation(m);
    check(`"${m.name}" (${m.type}) produces category "${expectCategory}"`, v?.category === expectCategory, JSON.stringify(v));
    const choices = MEAL_SLOT_FORCED_CHOICES[expectCategory];
    check(`MEAL_SLOT_FORCED_CHOICES["${expectCategory}"] is a non-empty list of concrete alternatives`, Array.isArray(choices) && choices.length > 0, JSON.stringify(choices));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
