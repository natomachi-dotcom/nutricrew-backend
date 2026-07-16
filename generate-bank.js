/**
 * generate-bank.js
 * Pre-generates meal plans for common combos and writes plans-bank.json.
 * Run once (or to refresh the bank):
 *   node --use-system-ca generate-bank.js
 *
 * Requires ANTHROPIC_API_KEY in .env (same file as server.js uses).
 * Takes ~5–10 min and costs ~$0.50–0.80 in Haiku API credits.
 */

import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { createRequire } from "module";

// Load .env manually (dotenv ESM compat)
const require = createRequire(import.meta.url);
try { require("dotenv").config(); } catch {}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-haiku-4-5-20251001";
const OUT = "./plans-bank.json";

// MUST match server.js's CACHE_SCHEMA_VERSION exactly, and MUST be bumped in
// lockstep whenever that constant changes there — server.js's bankLookupKey
// folds its own CACHE_SCHEMA_VERSION into the same key position this script
// writes to. A mismatch here silently makes every entry this script produces
// unreachable (this has already happened twice: once from a missing version
// segment entirely, once from a stale "hotel_no_kitchen" kitchen key).
const CACHE_SCHEMA_VERSION = "v8";

// ─── SCHEMAS (must match server.js) ──────────────────────────────
// server.js's hard validator (validatePlan) now runs against EVERY bank
// entry before it's ever served (see the rawBankEntries filter in
// /api/generate-plan) — an entry missing ingredients/estimated_cost/
// allergens_present/diet_tags/prep_method will simply fail validation and
// get discarded at serve time, falling through to normal AI generation. So
// this schema must stay in lockstep with server.js's MEAL_SCHEMA or freshly
// generated bank entries are silent, wasted spend.
const ALLERGEN_TAGS = [
  "peanuts", "tree_nuts", "milk", "eggs", "fish", "shellfish", "soy",
  "wheat_gluten", "sesame", "mustard", "celery", "lupin", "sulphites",
];

const MEAL_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["Breakfast", "Lunch", "Dinner", "Snack"] },
    name: { type: "string" },
    description: { type: "string" },
    prep: { type: "string" },
    calories: { type: "integer" },
    protein: { type: "integer" },
    carbs: { type: "integer" },
    fat: { type: "integer" },
    tags: { type: "array", items: { type: "string" } },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          quantity: { type: "number" },
          unit: { type: "string" },
        },
        required: ["name", "quantity", "unit"],
        additionalProperties: false,
      },
      description: "Every distinct ingredient in this meal, listed separately — never omit one because it seems minor.",
    },
    estimated_cost: { type: "number", description: "Estimated USD-equivalent cost of this meal's ingredients for a single portion." },
    allergens_present: {
      type: "array",
      items: { type: "string", enum: ALLERGEN_TAGS },
      description: "EVERY major allergen category this meal's ingredients touch, including hidden/derivative sources. Empty array only if genuinely none apply.",
    },
    diet_tags: {
      type: "array",
      items: { type: "string" },
      description: "Diet/lifestyle labels this exact meal fully satisfies (e.g. vegan, gluten_free, halal, keto) — only if genuinely, completely true.",
    },
    prep_method: {
      type: "string",
      enum: ["no_cook", "microwave", "stove_oven", "airplane_provided"],
      description: "The realistic way this meal gets made, matching the kitchen access given above.",
    },
    tip: { type: "string" },
    recyclingTip: { type: "string" },
    emoji: { type: "string" },
  },
  required: ["type", "name", "description", "prep", "calories", "protein", "carbs", "fat", "tip", "emoji", "ingredients", "estimated_cost", "allergens_present", "diet_tags", "prep_method"],
  additionalProperties: false,
};

const DAYS_SCHEMA = {
  type: "object",
  properties: {
    days: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          jetlagNote: { type: ["string", "null"] },
          hydrationNote: { type: ["string", "null"] },
          meals: { type: "array", items: MEAL_SCHEMA },
        },
        required: ["label", "jetlagNote", "hydrationNote", "meals"],
        additionalProperties: false,
      },
    },
  },
  required: ["days"],
  additionalProperties: false,
};

const EXTRAS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    groceryList: {
      type: "object",
      properties: {
        produce: { type: "array", items: { type: "string" } },
        protein: { type: "array", items: { type: "string" } },
        pantry: { type: "array", items: { type: "string" } },
        snacks: { type: "array", items: { type: "string" } },
        dairy: { type: "array", items: { type: "string" } },
      },
      required: ["produce", "protein", "pantry", "snacks", "dairy"],
      additionalProperties: false,
    },
    foodRestrictions: {
      type: "object",
      properties: {
        usa: { type: "string" },
        destination: { type: "string" },
        general: { type: "string" },
      },
      required: ["usa", "destination", "general"],
      additionalProperties: false,
    },
  },
  required: ["summary", "groceryList", "foodRestrictions"],
  additionalProperties: false,
};

// ─── COMBOS ───────────────────────────────────────────────────────

const DIETS = [
  { key: "none",         label: "No dietary restrictions — eat anything" },
  { key: "vegetarian",   label: "Vegetarian (no meat, poultry, or seafood)" },
  { key: "vegan",        label: "Vegan (no animal products of any kind — no meat, dairy, eggs, honey)" },
  { key: "gluten_free",  label: "Strictly gluten-free (no wheat, barley, rye, or cross-contamination risk)" },
  { key: "halal",        label: "Halal (use halal-certified ingredients only; no pork, no alcohol in any form)" },
  { key: "lactose_free", label: "Lactose-free (no dairy products)" },
  { key: "low_carb",     label: "Low-carb (under 100g net carbs per day; avoid bread, pasta, rice, sugar)" },
];

const KITCHENS = [
  {
    key: "full_kitchen",
    label: "Full home kitchen with stove, oven, and all standard cooking equipment.",
  },
  {
    // Must be "hotel" — this key becomes part of the plan-bank lookup key
    // server.js builds from the live request's data.kitchen value, and the
    // frontend's kitchen picker sends "hotel" (the string "hotel_no_kitchen"
    // is only a UI translation label id, never a real value). Using the wrong
    // string here previously left every hotel-kitchen bank entry silently
    // unreachable — same failure mode as the "plan-bank key format" bug.
    key: "hotel",
    label: "Hotel room only. NO stove, oven, or microwave. Meals must be pre-made, packaged, cold-assembled, or ordered from the hotel. No cooking.",
  },
];

const PAIRING_DAYS_LIST = [1, 2, 3];

// ─── PROMPT BUILDERS ─────────────────────────────────────────────

function buildDaysPrompt(pairingDays, dietLabel, kitchenLabel) {
  const daySpecs = Array.from({ length: pairingDays }, (_, i) =>
    `Day ${i + 1} — jetlagNote: null, hydrationNote: one short crew-specific hydration tip for a ground day`
  ).join("\n");

  return `You are a professional nutritionist specializing in aviation crew health.

KITCHEN ACCESS: ${kitchenLabel}
DIETARY REQUIREMENT: ${dietLabel}

The crew member is a typical flight attendant: moderately active, long shifts, needs sustained energy and convenient portable meals. Aim for ~1950–2100 kcal/day across 5 meals (Breakfast, Lunch, Dinner, Snack, Snack). Prioritize practical real foods over supplements.

Generate ALL ${pairingDays} day(s) of this nutrition plan. Return a JSON object with a "days" array of exactly ${pairingDays} day object(s), in order.

Rules:
- Each day must have exactly: 1 Breakfast, 1 Lunch, 1 Dinner, 2 Snacks (5 meals total).
- The "type" field must be exactly "Breakfast", "Lunch", "Dinner", or "Snack" — never translated.
- Every meal must include "tip" (1 practical tip) and "emoji" (2–3 food emoji representing the meal).
- Do NOT include a "container" field.
- Vary meals significantly across days — different ingredients, cuisines, and preparation styles.
- The "prep" field must respect the kitchen access constraint above.
- List EVERY distinct ingredient in "ingredients" (as {name, quantity, unit}) — however minor. This is the primary signal a downstream automated allergen check relies on; an incomplete list is treated as a failure.
- "allergens_present" must honestly include every major allergen this meal's ingredients touch, including hidden/derivative sources (e.g. Worcestershire sauce -> fish; soy sauce -> wheat + soy; pesto -> tree_nuts). Allergies stated in DIETARY REQUIREMENT above are absolute prohibitions, not preferences — leave out anything even plausibly a hidden source.
- "estimated_cost" must be a realistic USD-equivalent estimate for one portion.
- "prep_method" (no_cook / microwave / stove_oven / airplane_provided) must match what's actually achievable under KITCHEN ACCESS above.
- "diet_tags" must only include a label if the meal genuinely, fully satisfies it.

Per-day instructions:
${daySpecs}`;
}

function buildExtrasPrompt(pairingDays, dietLabel, kitchenLabel, days) {
  const mealNames = days.flatMap(d => d.meals.map(m => m.name)).join(", ");
  return `You are a professional nutritionist specializing in aviation crew health.

For a ${pairingDays}-day crew nutrition plan:
Diet: ${dietLabel}
Kitchen: ${kitchenLabel}
Meals included: ${mealNames}

Return JSON:
- "summary": 2-sentence overview of what makes this plan good for crew health.
- "groceryList": all ingredients needed across all days, categorized (produce, protein, pantry, snacks, dairy). Each item should be specific (e.g. "Greek yogurt 500g" not just "yogurt").
- "foodRestrictions.usa": "Not applicable — route destination not specified."
- "foodRestrictions.destination": "Destination not specified for this plan. Check local customs rules on arrival for any items in your grocery list."
- "foodRestrictions.general": 3–4 practical food safety and freshness tips for crew on ${pairingDays}-day pairings.`;
}

// ─── AI CALL ─────────────────────────────────────────────────────

async function runStructured(prompt, schema, maxTokens) {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  });
  const message = await stream.finalMessage();
  const text = message.content.find(b => b.type === "text")?.text;
  if (!text) throw new Error("No text in response");
  const u = message.usage;
  console.log(`    tokens: in=${u?.input_tokens} out=${u?.output_tokens}`);
  return JSON.parse(text);
}

async function withRetry(fn, label) {
  try { return await fn(); }
  catch (e) {
    console.warn(`    Retry: ${label} (${e.message})`);
    await new Promise(r => setTimeout(r, 3000));
    return await fn();
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY in .env");
    process.exit(1);
  }

  // Load existing bank to resume interrupted runs
  let existingPlans = {};
  if (existsSync(OUT)) {
    try {
      existingPlans = JSON.parse(readFileSync(OUT, "utf8")).plans || {};
      const total = Object.values(existingPlans).reduce((s, arr) => s + arr.length, 0);
      console.log(`Resuming: found ${total} existing entries in ${OUT}`);
    } catch { existingPlans = {}; }
  }

  const plans = { ...existingPlans };
  let generated = 0;
  let skipped = 0;

  const totalCombos = DIETS.length * KITCHENS.length * PAIRING_DAYS_LIST.length;
  let combo = 0;

  for (const diet of DIETS) {
    for (const kitchen of KITCHENS) {
      for (const pairingDays of PAIRING_DAYS_LIST) {
        combo++;

        // Key format must match server.js's bankLookupKey exactly — a live
        // request's key is [dietKey|CACHE_SCHEMA_VERSION, goalKey, budgetLevel,
        // kitchenKey, calorieTargetKey, cookingKey, lang, pairingDays].join("|"),
        // one flat key PER pairing-day count (not one key holding a 1/2/3-day
        // array — that was the original form of this exact bug).
        const bankKey = `${diet.key}|${CACHE_SCHEMA_VERSION}|none|none|${kitchen.key}|none|none|en|${pairingDays}`;
        if (!plans[bankKey]) plans[bankKey] = [];

        // Skip already-generated entries
        const exists = plans[bankKey].some(e => e.pairingDays === pairingDays);
        if (exists) {
          console.log(`[${combo}/${totalCombos}] SKIP ${bankKey} (already exists)`);
          skipped++;
          continue;
        }

        console.log(`[${combo}/${totalCombos}] GEN  ${diet.key} × ${kitchen.key} × ${pairingDays}d`);

        try {
          // Step 1: Generate days. Bumped from 2200/day (6000 cap) now that
          // MEAL_SCHEMA carries structured ingredients + allergens_present +
          // diet_tags + estimated_cost + prep_method per meal.
          const maxDayTokens = Math.min(3000 * pairingDays, 9000);
          const daysResult = await withRetry(
            () => runStructured(
              buildDaysPrompt(pairingDays, diet.label, kitchen.label),
              DAYS_SCHEMA,
              maxDayTokens
            ),
            `days ${diet.key}×${kitchen.key}×${pairingDays}d`
          );

          const days = daysResult.days.map((d, i) => ({
            day: i + 1,
            label: d.label || `Day ${i + 1}`,
            jetlagNote: null,
            hydrationNote: d.hydrationNote || null,
            meals: d.meals,
            totalCalories: d.meals.reduce((s, m) => s + (m.calories || 0), 0),
          }));

          // Step 2: Generate extras
          const extrasResult = await withRetry(
            () => runStructured(
              buildExtrasPrompt(pairingDays, diet.label, kitchen.label, days),
              EXTRAS_SCHEMA,
              1400
            ),
            `extras ${diet.key}×${kitchen.key}×${pairingDays}d`
          );

          plans[bankKey].push({
            pairingDays,
            summary: extrasResult.summary,
            days,
            groceryList: extrasResult.groceryList,
            foodRestrictions: extrasResult.foodRestrictions,
          });

          generated++;

          // Save progress after every successful entry
          writeFileSync(OUT, JSON.stringify({ version: 1, generated: new Date().toISOString(), plans }, null, 2));
          console.log(`    Saved. (${generated} generated so far)`);
        } catch (e) {
          console.error(`    FAILED after retry: ${e.message}`);
        }

        // Brief pause between API calls
        await new Promise(r => setTimeout(r, 800));
      }
    }
  }

  const totalEntries = Object.values(plans).reduce((s, arr) => s + arr.length, 0);
  console.log(`\nDone. Generated ${generated} new entries, skipped ${skipped} existing. Total: ${totalEntries} entries in ${OUT}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
