import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import Anthropic from "@anthropic-ai/sdk";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

const app = express();
app.set("trust proxy", 1);
// contentSecurityPolicy/CORP are tuned off/loosened: this is a JSON API with
// no HTML to protect, and tightening CORP breaks cross-origin fetch() from
// the frontend's different Vercel origin.
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));

// Only the deployed frontend (and its Vercel preview deployments) and local
// dev should be able to call this API from a browser — anyone else embedding
// these endpoints would be spending our Anthropic budget on their traffic.
const ALLOWED_ORIGINS = [
  "https://nutricrew-frontend.vercel.app",
  "https://nutricrew-frontend-natomachi-dotcoms-projects.vercel.app",
  "https://nutricrew-frontend-natomachi-dotcom-natomachi-dotcoms-projects.vercel.app",
];
const PREVIEW_ORIGIN_REGEX = /^https:\/\/nutricrew-frontend-[a-z0-9]+-natomachi-dotcoms-projects\.vercel\.app$/;
const LOCALHOST_ORIGIN_REGEX = /^http:\/\/localhost(:\d+)?$/;

app.use(cors({
  origin: (origin, callback) => {
    // No Origin header = non-browser request (curl, server-to-server) - allow.
    if (!origin) return callback(null, true);
    const allowed = ALLOWED_ORIGINS.includes(origin) || PREVIEW_ORIGIN_REGEX.test(origin) || LOCALHOST_ORIGIN_REGEX.test(origin);
    // Resolve with `false` (not an error) for disallowed origins: the request
    // still completes, but without CORS headers, so the browser blocks the
    // response from being read by that page's JS.
    callback(null, allowed);
  },
}));
app.use(express.json());

const client = new Anthropic();
const PLAN_MODEL = "claude-sonnet-4-6";
const FAST_MODEL = "claude-haiku-4-5-20251001";

const CRUD_API_BASE = process.env.CRUD_API_BASE;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

// Mirrors the frontend's 1-5 day picker — caps the number of parallel
// per-day Sonnet calls a single request can trigger.
const MAX_PAIRING_DAYS = 5;
// Generous enough for the frontend's templated prompts plus a long
// free-text description, while blocking grossly oversized input.
const MAX_PROMPT_LENGTH = 3000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Baseline abuse protection on every API route, per IP.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});
app.use("/api", apiLimiter);

// Plan generation runs several Sonnet calls per request, so it gets a much
// tighter limit, keyed by the crew member's email rather than just IP
// (shared IPs shouldn't throttle each other, but one account shouldn't be
// able to hammer this endpoint regardless of IP).
const generatePlanLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.body?.data?.email?.toLowerCase().trim() || ipKeyGenerator(req.ip),
  message: { error: "Too many plan generation requests. Please try again later." },
});

const MEAL_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["Breakfast", "Lunch", "Dinner", "Snack"] },
    name: { type: "string" },
    description: { type: "string" },
    prep: {
      type: "string",
      description: "How to prepare or assemble this meal GIVEN THE KITCHEN ACCESS CONSTRAINTS specified above — do not suggest cooking methods or equipment unavailable for this meal's assigned access type.",
    },
    calories: { type: "integer" },
    protein: { type: "integer" },
    carbs: { type: "integer" },
    fat: { type: "integer" },
    tags: { type: "array", items: { type: "string" } },
    tip: { type: "string" },
    recyclingTip: { type: "string" },
  },
  required: ["type", "name", "description", "prep", "calories", "protein", "carbs", "fat", "tags", "tip", "recyclingTip"],
  additionalProperties: false,
};

const DAY_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string" },
    jetlagNote: { type: ["string", "null"] },
    meals: { type: "array", items: MEAL_SCHEMA },
  },
  required: ["label", "jetlagNote", "meals"],
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

const AIRPLANE_MEAL_SCHEMA = {
  type: "object",
  properties: {
    fits: { type: "string", enum: ["yes", "no", "partial"] },
    dietNote: { type: "string" },
    calories: { type: "integer" },
    note: { type: "string" },
  },
  required: ["fits", "dietNote", "calories", "note"],
  additionalProperties: false,
};

const CALORIE_SCHEMA = {
  type: "object",
  properties: {
    total: { type: "integer" },
    breakdown: {
      type: "array",
      items: {
        type: "object",
        properties: {
          food: { type: "string" },
          calories: { type: "integer" },
        },
        required: ["food", "calories"],
        additionalProperties: false,
      },
    },
    note: { type: "string" },
  },
  required: ["total", "breakdown", "note"],
  additionalProperties: false,
};

function extractJSON(message) {
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text content returned by the model");
  return JSON.parse(textBlock.text);
}

function handleAnthropicError(err, res) {
  console.error(err);
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (err instanceof Anthropic.APIError) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  res.status(500).json({ error: 'Internal server error' });
}

// Checks the free-tier pairing limit against the user's record in the CRUD backend.
async function checkPairingUsage(email, name) {
  const res = await fetch(`${CRUD_API_BASE}/api/pairing-usage/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
    body: JSON.stringify({ email, name }),
  });
  if (!res.ok) {
    throw Object.assign(new Error("Failed to check pairing usage"), { status: 502 });
  }
  return res.json();
}

async function incrementPairingUsage(email) {
  const res = await fetch(`${CRUD_API_BASE}/api/pairing-usage/increment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    throw Object.assign(new Error("Failed to record pairing usage"), { status: 502 });
  }
  return res.json();
}

async function runStructured(prompt, schema, maxTokens) {
  const stream = client.messages.stream({
    model: PLAN_MODEL,
    max_tokens: maxTokens,
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw Object.assign(new Error("The model declined to generate this content."), { status: 502 });
  }
  return extractJSON(message);
}

// Rough daily calorie target for the "Calorie Deficit" goal. Without height/age
// a full Mifflin-St Jeor estimate isn't possible, so this uses a commonly-cited
// ~30 kcal/kg/day maintenance estimate for a moderately active adult (crew are
// on their feet a lot), minus a standard ~500 kcal/day deficit (~0.5kg/week),
// floored at a safe minimum.
function estimateCalorieDeficitTarget(data) {
  const weightStr = String(data.weight || "");
  const weightVal = parseFloat(weightStr);
  if (!weightVal) return null;
  const weightKg = /lb/i.test(weightStr) ? weightVal / 2.20462 : weightVal;
  const tdee = weightKg * 30;
  const floor = data.gender === "male" ? 1500 : 1200;
  return Math.round(Math.max(tdee - 500, floor) / 50) * 50;
}

// What's actually possible to prepare under each kitchen-access option.
// Keyed by the values the frontend's kitchen CheckGroup sends.
const KITCHEN_ACCESS_RULES = {
  full_kitchen: `"full_kitchen" - Full kitchen access: stove, oven, fridge/freezer, and standard cookware are all available. Normal home cooking (sauteing, baking, roasting, simmering, grilling, etc.) is fine with no special constraints.`,
  hotel: `"hotel" - Hotel room with NO kitchen: there is NO stove, NO oven, and NO cooking equipment of any kind. Every meal using this access type MUST be no-cook: either ready-to-eat as purchased, or assembled/mixed from pre-cooked, store-bought, or grab-and-go items (e.g. salads, wraps, overnight oats made in a cup/jar, yogurt parfaits, deli meat and cheese plates, fresh fruit, protein bars, pre-cooked rotisserie chicken or similar from a grocery store/deli). The "prep" field may only describe assembling, mixing, slicing, or opening packaging - NEVER cooking, heating on a stove, or baking.`,
  microwave: `"microwave" - Microwave only (no stove/oven): everything allowed for "hotel" (no-cook/assembly) is fine, PLUS anything that can be prepared using only a microwave - e.g. microwaveable rice/oatmeal cups, steam-in-bag vegetables, reheating pre-cooked proteins, or a mug omelet made with eggs in a microwave-safe mug. The "prep" field may describe microwave heating times (e.g. "Microwave on high for 90 seconds") but must NOT mention a stovetop, oven, grill, or any other cooking appliance.`,
  airplane_food: `"airplane_food" - Airline-provided meals only: this meal is served on the aircraft or bought at the airport, so there is no meal prep at all. The "description"/"prep"/"tip" fields should focus on how to SELECT or SUPPLEMENT the available airline/airport food (e.g. request the vegetarian/diabetic meal in advance, choose the side salad over fries, skip the bread roll and bring your own nuts or a protein bar to add protein, ask for black coffee instead of a sugary drink). Do NOT invent a from-scratch recipe for this meal.`,
};

// Builds the explicit per-option prep constraints for the crew's selected
// kitchen access. Replaces the old plain "Kitchen access: x, y" line, which
// gave the model no idea what was actually possible with each option.
function buildKitchenAccessBlock(kitchen) {
  const list = (kitchen && kitchen.length) ? kitchen : ["full_kitchen"];
  const rules = list.map((k) => KITCHEN_ACCESS_RULES[k]).filter(Boolean);
  if (!rules.length) return "";

  let block = `KITCHEN ACCESS CONSTRAINTS - the crew member has access to: ${list.join(", ")}.\n`
    + rules.map((r) => `- ${r}`).join("\n");

  if (list.length > 1) {
    block += `\nThis crew member selected MULTIPLE access types because different meals happen in different places during the day/pairing (e.g. breakfast at a hotel with no kitchen, dinner served on the plane). For EACH meal, decide which single access type realistically applies based on its meal type and the day's context (e.g. Dinner on a flying day is likely "airplane_food"; Breakfast or Lunch on the ground is likely "hotel" or "microwave" if listed), then apply ONLY that access type's constraints to that meal's "prep". Do not blend constraints from multiple access types within a single meal.`;
  }

  return block;
}

// Builds the shared crew-profile context used by every prompt for a plan.
function buildContext(data, lang, pairingDays) {
  const langName = lang === "fr" ? "French" : lang === "es" ? "Spanish" : "English";
  const diet = data.diet === "other" ? data.diet_other
    : data.diet === "calorie_deficit" ? "no specific restrictions"
    : data.diet;
  const jetlag = Math.abs(parseInt(data.timezone || 0, 10)) >= 4;
  const destinations = (data.destinations || []).slice(0, MAX_PAIRING_DAYS);
  // Prefer the user-selected calorie target sent from the frontend;
  // fall back to the server-side weight estimate for backwards compat.
  const calorieTarget = data.diet === "calorie_deficit"
    ? (data.calorie_target || estimateCalorieDeficitTarget(data))
    : null;
  const calorieDeficitAmount = data.diet === "calorie_deficit"
    ? (data.calorie_deficit_amount || null)
    : null;

  const budgetAmount = parseFloat(data.budget_amount);
  const hasBudget = budgetAmount > 0;
  const perDayBudget = hasBudget
    ? (data.budget_type === "total" ? budgetAmount / pairingDays : budgetAmount)
    : null;
  const budgetLine = hasBudget
    ? `$${data.budget_amount} per ${data.budget_type === "total" ? `trip (~$${perDayBudget.toFixed(2)}/day across ${pairingDays} days)` : "day"}`
    : "open (no specific limit)";

  const kitchenAccessBlock = buildKitchenAccessBlock(data.kitchen);

  const profile = `CREW PROFILE:
- Name: ${data.name}, Position: ${data.position}, Gender: ${data.gender}
- Weight: ${data.weight}, Diet: ${diet}${calorieTarget ? ` | GOAL: Calorie deficit — target exactly ${calorieTarget} kcal/day` : ""}
- Goals: ${(data.goals || []).join(", ")}
- Budget: ${budgetLine}
- Route: ${data.departure} -> ${destinations.join(" -> ")}
- Going to USA: ${data.going_usa}
- Jet lag (timezone diff): ${data.timezone || 0} hours${jetlag ? " -- SIGNIFICANT JET LAG, adjust meal timing for circadian rhythm" : ""}
- Kitchen access: ${(data.kitchen || []).join(", ") || "full_kitchen"} (see KITCHEN ACCESS CONSTRAINTS below for what's actually possible)`;

  return { langName, diet, jetlag, destinations, profile, hasBudget, perDayBudget, calorieTarget, calorieDeficitAmount, kitchenAccessBlock };
}

function buildDayPrompt(data, dayNum, pairingDays, ctx) {
  const location = ctx.destinations[dayNum - 1] || data.departure;
  return `You are a professional nutritionist specializing in aviation crew health.

${ctx.profile}

${ctx.kitchenAccessBlock}

Generate ONLY Day ${dayNum} of ${pairingDays} of this nutrition plan. This day's location: ${location}.

Respond ONLY in ${ctx.langName}. Return ONLY valid JSON matching the schema.
Include Breakfast, Lunch, Dinner, and 1-2 Snacks.
The meal "type" field must always be the literal English word "Breakfast", "Lunch", "Dinner", or "Snack" — never translate it — even though every other field must be in ${ctx.langName}.
${ctx.jetlag && dayNum === 1
    ? `Set "jetlagNote" to short, practical meal-timing advice for adjusting to the jet lag described above. Phrase all timing purely in terms of ${location} local time — do NOT state explicit clock-time conversions between time zones (e.g. do not say "X local time is Y time at home") and do NOT describe the trip as "eastward"/"westward" or specify a direction, since these are error-prone.`
    : `Set "jetlagNote" to null.`}
Every meal must include a "tip" (short practical packing/timing/prep/substitution tip) and a "recyclingTip" (short waste-reduction or recycling/composting tip tailored to a ${ctx.diet} diet).
Vary the meal choices — pick different recipes, ingredients, and combinations than a typical/generic plan each time, so returning crew members don't get repetitive suggestions.
${ctx.hasBudget
    ? `Budget constraint: the ingredients for this day's meals combined should realistically cost around $${ctx.perDayBudget.toFixed(2)} (USD-equivalent) or less in a typical grocery store near ${location}. Choose recipes and ingredients accordingly — favor affordable, widely available staples over premium or specialty items when the budget is tight, while still meeting the nutrition goals above.`
    : ""}
${ctx.calorieTarget ? `CALORIE DEFICIT GOAL: this crew member is targeting a calorie deficit for weight loss.
- Daily calorie target: ${ctx.calorieTarget} kcal
${ctx.calorieDeficitAmount ? `- Deficit goal: ${ctx.calorieDeficitAmount} kcal below maintenance (~${(ctx.calorieDeficitAmount / 7700 * 7).toFixed(2)} kg/week loss pace)` : ""}
- The SUM of the "calories" field across ALL meals today (Breakfast + Lunch + Dinner + Snacks combined) MUST total as close to ${ctx.calorieTarget} kcal as possible — within ±50 kcal. Do NOT exceed this target.
- Prioritize high-protein, high-fiber, high-volume, low-calorie-density foods to maximize satiety (especially important for crew managing energy across long pairings).
- Each meal's "calories" value must be realistic and accurate — individual meal values must sum to approximately ${ctx.calorieTarget} kcal for the day.`
    : ""}`;
}

function buildExtrasPrompt(data, pairingDays, ctx) {
  const itinerary = ctx.destinations.map((d, i) => `  Day ${i + 1}: ${d}`).join("\n");
  return `You are a professional nutritionist specializing in aviation crew health.

${ctx.profile}

${ctx.kitchenAccessBlock}

Daily itinerary:
${itinerary}

Generate the SUMMARY, GROCERY LIST, and FOOD RESTRICTIONS sections for this ${pairingDays}-day nutrition plan (day-by-day meals are generated separately).

Respond ONLY in ${ctx.langName}. Return ONLY valid JSON matching the schema.
- "summary": 2-sentence overview of the whole plan${ctx.calorieTarget ? `, noting that it targets a daily calorie deficit (~${ctx.calorieTarget} kcal/day) to support healthy, sustainable weight loss` : ""}.
- "groceryList": categorized shopping list (produce, protein, pantry, snacks, dairy) covering the whole pairing, based on the crew's kitchen access constraints above (e.g. only ready-to-eat/no-prep items if no cooking equipment is available)${ctx.hasBudget ? ` and budget — keep total grocery costs realistically within $${(ctx.perDayBudget * pairingDays).toFixed(2)} (USD-equivalent) for the whole trip by choosing cost-effective ingredients and reasonable quantities` : ""}.
- "foodRestrictions": "usa" (detailed list of what cannot be brought into the USA and why; if going_usa is "no", write "Not applicable — not traveling to the USA"), "destination" (food rules/restrictions for ${ctx.destinations.join(", ")}), "general" (general tips for a ${ctx.diet} diet while traveling).`;
}

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "NutriCrew AI backend is running" });
});

app.post("/api/generate-plan", generatePlanLimiter, async (req, res) => {
  try {
    const { data, lang } = req.body;
    if (!data) return res.status(400).json({ error: "Missing 'data' in request body" });

    const email = (data.email || "").toLowerCase().trim();
    if (!email) return res.status(400).json({ error: "Missing 'email' in request data" });
    if (!EMAIL_REGEX.test(email)) return res.status(400).json({ error: "Invalid 'email' format" });

    const usage = await checkPairingUsage(email, data.name);
    if (!usage.allowed) {
      return res.status(403).json({
        error: "premium_required",
        message: "You've used your free pairing plan. Upgrade to Premium for unlimited plans.",
        pairingCount: usage.pairingCount,
      });
    }

    if (data.diet === "calorie_deficit" && !usage.isPremium) {
      return res.status(403).json({
        error: "premium_required",
        message: "Calorie Deficit plans are a Premium feature. Upgrade to Premium to unlock this and unlimited plans.",
        pairingCount: usage.pairingCount,
      });
    }

    const pairingDays = Math.min(Math.max(parseInt(data.pairing_days, 10) || 1, 1), MAX_PAIRING_DAYS);
    const ctx = buildContext(data, lang, pairingDays);

    const dayPromises = [];
    for (let i = 1; i <= pairingDays; i++) {
      dayPromises.push(runStructured(buildDayPrompt(data, i, pairingDays, ctx), DAY_SCHEMA, 2500));
    }
    const extrasPromise = runStructured(buildExtrasPrompt(data, pairingDays, ctx), EXTRAS_SCHEMA, 4000);

    const [days, extras] = await Promise.all([Promise.all(dayPromises), extrasPromise]);
    days.forEach((d, i) => {
      d.day = i + 1;
      d.totalCalories = d.meals.reduce((sum, m) => sum + m.calories, 0);
    });

    const updatedUsage = await incrementPairingUsage(email);

    res.json({
      summary: extras.summary,
      days,
      groceryList: extras.groceryList,
      foodRestrictions: extras.foodRestrictions,
      pairingCount: updatedUsage.pairingCount,
      isPremium: updatedUsage.isPremium,
    });
  } catch (err) {
    handleAnthropicError(err, res);
  }
});

app.post("/api/estimate-calories", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing 'prompt' in request body" });
    if (typeof prompt !== "string" || prompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({ error: "'prompt' is invalid or too long" });
    }

    const message = await client.messages.create({
      model: FAST_MODEL,
      max_tokens: 1024,
      output_config: { format: { type: "json_schema", schema: CALORIE_SCHEMA } },
      messages: [{ role: "user", content: prompt }],
    });

    if (message.stop_reason === "refusal") {
      return res.status(502).json({ error: "The model declined to estimate calories." });
    }

    res.json(extractJSON(message));
  } catch (err) {
    handleAnthropicError(err, res);
  }
});

app.post("/api/check-airplane-meal", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing 'prompt' in request body" });
    if (typeof prompt !== "string" || prompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({ error: "'prompt' is invalid or too long" });
    }

    const message = await client.messages.create({
      model: FAST_MODEL,
      max_tokens: 1024,
      output_config: { format: { type: "json_schema", schema: AIRPLANE_MEAL_SCHEMA } },
      messages: [{ role: "user", content: prompt }],
    });

    if (message.stop_reason === "refusal") {
      return res.status(502).json({ error: "The model declined to check this meal." });
    }

    res.json(extractJSON(message));
  } catch (err) {
    handleAnthropicError(err, res);
  }
});

// --- Error handling ---

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Catches malformed JSON bodies and anything else that escapes a route's own
// try/catch, so Express's default handler (which can include stack traces
// when NODE_ENV isn't "production") never sends raw error details to clients.
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON in request body" });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large" });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`NutriCrew AI backend listening on port ${PORT}`);
  });
}

export default app;
