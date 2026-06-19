import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import Anthropic from "@anthropic-ai/sdk";
import { Resend } from "resend";
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

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL || "NutriCrew <onboarding@resend.dev>";

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

// ─── EMAIL ────────────────────────────────────────────────────────────────────

const MEAL_TYPE_COLORS = {
  Breakfast: "#4A9ECC",
  Lunch:     "#4CAF7D",
  Dinner:    "#C9A84C",
  Snack:     "#7A8EAA",
};

function generatePlanEmailHTML(name, lang, plan) {
  const { summary, days, groceryList, foodRestrictions } = plan;
  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  const labelMap = {
    en: { greeting: "Hi", intro: "Your NutriCrew meal plan is ready.", prepLabel: "How to prepare", tipLabel: "Tip", groceryTitle: "Grocery List", restrictionsTitle: "Food Rules", calories: "kcal", protein: "Protein", carbs: "Carbs", fat: "Fat", totalLabel: "Day total", disclaimer: "Generated by AI — for informational purposes only. Consult a healthcare professional before making significant dietary changes." },
    fr: { greeting: "Bonjour", intro: "Votre plan nutritionnel NutriCrew est prêt.", prepLabel: "Comment préparer", tipLabel: "Conseil", groceryTitle: "Liste de Courses", restrictionsTitle: "Règles Alimentaires", calories: "kcal", protein: "Protéines", carbs: "Glucides", fat: "Lipides", totalLabel: "Total du jour", disclaimer: "Généré par IA — à titre informatif uniquement. Consultez un professionnel de santé avant tout changement alimentaire important." },
    es: { greeting: "Hola", intro: "Tu plan nutricional de NutriCrew está listo.", prepLabel: "Cómo preparar", tipLabel: "Consejo", groceryTitle: "Lista de Compras", restrictionsTitle: "Reglas Alimentarias", calories: "kcal", protein: "Proteínas", carbs: "Carbohidratos", fat: "Grasas", totalLabel: "Total del día", disclaimer: "Generado por IA — solo informativo. Consulta a un profesional de salud antes de hacer cambios significativos en tu dieta." },
  };
  const L = labelMap[lang] || labelMap.en;

  const daysHTML = days.map(day => {
    const mealsHTML = day.meals.map(meal => {
      const color = MEAL_TYPE_COLORS[meal.type] || "#7A8EAA";
      return `
        <tr>
          <td style="padding:28px 32px;border-bottom:2px solid #f0f0f0;">
            <div style="display:inline-block;font-size:13px;font-weight:bold;text-transform:uppercase;letter-spacing:2px;color:${color};background:${color}18;padding:4px 12px;border-radius:20px;margin-bottom:14px;">${meal.type}</div>
            <div style="font-size:20px;font-weight:bold;color:#0A1628;margin-bottom:10px;line-height:1.3;">${meal.name}</div>
            <div style="font-size:16px;color:#444;margin-bottom:20px;line-height:1.8;">${meal.description}</div>

            <div style="background:#f5f8ff;border-left:4px solid ${color};padding:14px 18px;margin-bottom:12px;border-radius:0 6px 6px 0;">
              <div style="font-size:13px;font-weight:bold;color:${color};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">${L.prepLabel}</div>
              <div style="font-size:15px;color:#333;line-height:1.8;">${meal.prep}</div>
            </div>

            ${meal.tip ? `
            <div style="background:#fffbf0;border-left:4px solid #C9A84C;padding:14px 18px;margin-bottom:16px;border-radius:0 6px 6px 0;">
              <div style="font-size:13px;font-weight:bold;color:#C9A84C;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">${L.tipLabel}</div>
              <div style="font-size:15px;color:#333;line-height:1.8;">${meal.tip}</div>
            </div>` : ""}

            <table cellpadding="0" cellspacing="0" style="margin-top:4px;">
              <tr>
                <td style="padding-right:24px;text-align:center;">
                  <div style="font-size:20px;font-weight:bold;color:#0A1628;">${meal.calories}</div>
                  <div style="font-size:13px;color:#888;">${L.calories}</div>
                </td>
                <td style="padding-right:24px;text-align:center;border-left:1px solid #eee;padding-left:24px;">
                  <div style="font-size:20px;font-weight:bold;color:#4CAF7D;">${meal.protein}g</div>
                  <div style="font-size:13px;color:#888;">${L.protein}</div>
                </td>
                <td style="padding-right:24px;text-align:center;border-left:1px solid #eee;padding-left:24px;">
                  <div style="font-size:20px;font-weight:bold;color:#4A9ECC;">${meal.carbs}g</div>
                  <div style="font-size:13px;color:#888;">${L.carbs}</div>
                </td>
                <td style="text-align:center;border-left:1px solid #eee;padding-left:24px;">
                  <div style="font-size:20px;font-weight:bold;color:#C9A84C;">${meal.fat}g</div>
                  <div style="font-size:13px;color:#888;">${L.fat}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>`;
    }).join("");

    return `
      <tr><td style="background:#1E3A6E;padding:20px 32px;">
        <div style="font-size:20px;font-weight:bold;color:#E8C96A;">${day.label}</div>
      </td></tr>
      ${day.jetlagNote ? `<tr><td style="background:#152850;padding:16px 32px;">
        <div style="font-size:15px;color:#7BBFE0;line-height:1.7;">✈ ${day.jetlagNote}</div>
      </td></tr>` : ""}
      ${mealsHTML}
      <tr><td style="background:#f0f4ff;padding:14px 32px;text-align:right;">
        <span style="font-size:15px;font-weight:bold;color:#1E3A6E;">${L.totalLabel}: ${day.totalCalories} ${L.calories}</span>
      </td></tr>`;
  }).join("");

  const groceryCats = [
    { key: "produce", label: "🥦 Produce" },
    { key: "protein", label: "🍗 Protein" },
    { key: "pantry",  label: "🥫 Pantry" },
    { key: "snacks",  label: "🍫 Snacks" },
    { key: "dairy",   label: "🥛 Dairy" },
  ];
  const groceryHTML = groceryCats.map(({ key, label }) => {
    const items = (groceryList[key] || []);
    if (!items.length) return "";
    return `
      <tr><td style="padding:0 0 24px 0;">
        <div style="font-size:16px;font-weight:bold;color:#1E3A6E;margin-bottom:10px;">${label}</div>
        <ul style="margin:0;padding-left:20px;">
          ${items.map(i => `<li style="font-size:16px;color:#333;line-height:2;">${i}</li>`).join("")}
        </ul>
      </td></tr>`;
  }).join("");

  const restrictionsHTML = [
    foodRestrictions.usa && `
      <tr><td style="padding:20px 0;border-bottom:1px solid #eee;">
        <div style="font-size:16px;font-weight:bold;color:#1E3A6E;margin-bottom:8px;">🇺🇸 USA</div>
        <div style="font-size:16px;color:#444;line-height:1.8;">${foodRestrictions.usa}</div>
      </td></tr>`,
    foodRestrictions.destination && `
      <tr><td style="padding:20px 0;border-bottom:1px solid #eee;">
        <div style="font-size:16px;font-weight:bold;color:#1E3A6E;margin-bottom:8px;">📍 Destination</div>
        <div style="font-size:16px;color:#444;line-height:1.8;">${foodRestrictions.destination}</div>
      </td></tr>`,
    foodRestrictions.general && `
      <tr><td style="padding:20px 0;">
        <div style="font-size:16px;font-weight:bold;color:#1E3A6E;margin-bottom:8px;">💡 General</div>
        <div style="font-size:16px;color:#444;line-height:1.8;">${foodRestrictions.general}</div>
      </td></tr>`,
  ].filter(Boolean).join("");

  return `<!DOCTYPE html>
<html lang="${lang}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NutriCrew Meal Plan</title></head>
<body style="margin:0;padding:24px 12px;background:#f0f4f8;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.10);">

  <!-- Header -->
  <tr><td style="background:#0A1628;padding:36px 32px;text-align:center;">
    <div style="font-size:28px;font-weight:bold;color:#C9A84C;letter-spacing:4px;">✈ NUTRICREW</div>
    <div style="font-size:15px;color:#7BBFE0;margin-top:8px;">Crew Nutrition Plan</div>
  </td></tr>

  <!-- Greeting -->
  <tr><td style="padding:32px 32px 24px;background:#152850;">
    <div style="font-size:22px;font-weight:bold;color:#F8FAFF;margin-bottom:8px;">${L.greeting}, ${name}!</div>
    <div style="font-size:16px;color:#B8D4F0;line-height:1.7;">${L.intro}</div>
    <div style="font-size:14px;color:#7A9EC0;margin-top:8px;">${date}</div>
  </td></tr>

  <!-- Summary -->
  <tr><td style="padding:28px 32px;font-size:16px;color:#333;line-height:1.9;border-bottom:3px solid #C9A84C;">${summary}</td></tr>

  <!-- Days & Meals -->
  ${daysHTML}

  <!-- Grocery List -->
  <tr><td style="padding:32px 32px 8px;">
    <div style="font-size:22px;font-weight:bold;color:#0A1628;border-bottom:3px solid #C9A84C;padding-bottom:12px;margin-bottom:24px;">${L.groceryTitle}</div>
    <table width="100%" cellpadding="0" cellspacing="0">${groceryHTML}</table>
  </td></tr>

  <!-- Food Rules -->
  <tr><td style="padding:32px 32px 8px;background:#f7f9fc;">
    <div style="font-size:22px;font-weight:bold;color:#0A1628;border-bottom:3px solid #C9A84C;padding-bottom:12px;margin-bottom:4px;">${L.restrictionsTitle}</div>
    <table width="100%" cellpadding="0" cellspacing="0">${restrictionsHTML}</table>
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#0A1628;padding:24px 32px;text-align:center;">
    <div style="font-size:13px;color:#7A8EAA;line-height:1.8;">${L.disclaimer}</div>
    <div style="font-size:13px;color:#4A6080;margin-top:10px;">© NutriCrew · Fuel Your Flight</div>
  </td></tr>

</table>
</body></html>`;
}

async function sendPlanEmail(toEmail, name, lang, plan) {
  if (!process.env.RESEND_API_KEY) return;
  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to: [toEmail],
    subject: `✈ Your NutriCrew Meal Plan — ${date}`,
    html: generatePlanEmailHTML(name, lang, plan),
  });
  if (result.error) console.error("Plan email error:", result.error);
}

// ─── AI ───────────────────────────────────────────────────────────────────────

async function runStructured(prompt, schema, maxTokens, model = PLAN_MODEL) {
  const stream = client.messages.stream({
    model,
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

const KITCHEN_ACCESS_RULES = {
  full_kitchen: `full_kitchen: Full kitchen (stove, oven, fridge, cookware). All cooking methods OK.`,
  hotel: `hotel: NO kitchen — no stove, oven, or any cooking equipment. Meals MUST be no-cook (ready-to-eat, assembled from pre-cooked/store-bought items, or grab-and-go). "prep" = assembly/slicing/opening only. NEVER mention cooking, heating on a stove, or baking. REFRIGERATION: for any perishable ingredient (fresh proteins, dairy, cut produce, pre-cooked items), add a note in the "tip" field stating it needs refrigeration — advise the crew member to request a hotel mini-fridge or to consume the item within 2 hours of purchase if no fridge is available.`,
  microwave: `microwave: No stove/oven, microwave only. No-cook/assembly (same as hotel) is fine, PLUS microwave methods (microwaveable cups, steam-in-bag veg, reheating). "prep" may include microwave times. NEVER mention stove, oven, or grill. REFRIGERATION: for any perishable ingredient, add a note in the "tip" field advising the crew member to request a hotel mini-fridge or consume within 2 hours if no fridge is available.`,
  airplane_food: `airplane_food: Airline meal served on board — no prep possible. "description"/"prep"/"tip" = how to SELECT or SUPPLEMENT airline/airport food (e.g. choose salad over fries, bring own nuts, ask for black coffee). Do NOT invent a from-scratch recipe.`,
};

function buildKitchenAccessBlock(kitchen) {
  const list = (kitchen && kitchen.length) ? kitchen : ["full_kitchen"];
  const rules = list.map((k) => KITCHEN_ACCESS_RULES[k]).filter(Boolean);
  if (!rules.length) return "";

  let block = `KITCHEN ACCESS (${list.join(", ")}):\n` + rules.map((r) => `- ${r}`).join("\n");

  if (list.length > 1) {
    block += `\nMULTIPLE ACCESS TYPES: for each meal, apply whichever single type fits realistically (e.g. dinner on flying day → airplane_food; ground-day breakfast → hotel/microwave). Never blend constraints across types in one meal.`;
  }

  return block;
}

// Returns a strict rule block for the given diet key, injected verbatim into
// every day prompt and the extras prompt so the model can't miss it.
function getDietRules(rawDiet, calorieTarget) {
  const FOOTER = `\nCRITICAL: Check every ingredient against the rules above before finalizing each meal. Replace any violating item. Full compliance required — no partial exceptions.`;

  let block = "";

  switch (rawDiet) {
    case "none":
      block = `DIET: No restrictions. Aim for balanced meals with proteins, complex carbs, healthy fats, and vegetables.`;
      break;

    case "vegetarian":
      block = `DIET: VEGETARIAN — STRICT RULES:
- NO meat (any animal flesh) or fish/seafood.
- Eggs + dairy (cheese, milk, yogurt, butter) ARE allowed.
- Protein must come from: eggs, dairy, legumes, tofu, tempeh, seitan, nuts, seeds, or quinoa/edamame.
- If meal protein <15g, suggest a fix in the "tip" field.`;
      break;

    case "vegan":
      block = `DIET: VEGAN — STRICT RULES:
- NO animal products: no meat, fish, eggs, dairy, honey, gelatin, or whey.
- Every ingredient must be 100% plant-based. Watch for hidden animal products: use plant butter/coconut oil not butter; dairy-free dark chocolate not regular; vegan dressing not Caesar; egg-free pasta; dairy-free bread.
- Protein must come from: legumes, tofu, tempeh, seitan, edamame, nuts, seeds, nutritional yeast.
- Grocery "dairy" list: plant-based alternatives only (oat milk, coconut yogurt, vegan cheese) — no actual dairy.
- If meal protein <15g, suggest a plant-protein fix in the "tip" field.`;
      break;

    case "gluten_free":
      block = `DIET: GLUTEN-FREE (celiac-level) — STRICT RULES:
- NO wheat, barley, rye, spelt, regular oats, regular bread/pasta/flour tortillas/crackers/baked goods, soy sauce (use gluten-free tamari), or beer.
- YES: rice, quinoa, corn, potatoes, GF-certified oats, buckwheat, millet, lentils, all proteins, all veg/fruit.
- Always label packaged items as "gluten-free" (e.g. "gluten-free tamari", "gluten-free oats").
- Add a cross-contamination warning in the "tip" for any packaged/restaurant item.`;
      break;

    case "halal":
      block = `DIET: HALAL — STRICT RULES:
- NO pork or pork-derived products (no bacon, ham, lard, pork gelatin).
- NO alcohol in any form (no wine sauces, beer, cooking wine, alcohol-based vanilla — use alcohol-free vanilla).
- All meat/poultry must be labeled "halal-certified".
- Seafood is permissible.
- Add a tip to verify halal certification at restaurants/stores, and a layover tip on finding halal options.`;
      break;

    case "kosher":
      block = `DIET: KOSHER — STRICT RULES:
- NO pork. NO shellfish (shrimp, crab, lobster, clams, mussels, oysters, squid).
- NO meat + dairy in the same meal (keep them fully separate).
- All meat must be labeled "kosher-certified". Fish: fins + scales only (salmon, tuna, cod, tilapia OK; catfish, shark NOT OK).
- Prefer pareve meals (fish/eggs/veg/grains) for travel simplicity.
- Add a hechsher tip for restaurant meals.`;
      break;

    case "low_carb":
      block = `DIET: LOW-CARB — STRICT RULES:
- MAX 50g total carbs/day across all meals combined. Add "~Xg carbs" tag to every meal.
- NO bread, pasta, rice, potatoes, sugar, most fruit (berries ≤50g OK), corn, juice, sweetened drinks.
- YES: all proteins, non-starchy veg (greens, broccoli, cauliflower, zucchini, peppers), cheese, nuts, seeds, avocado, olive oil.
- Make up calories from protein and fat. Verify total daily carbs ≤50g.`;
      break;

    case "dairy_free":
      block = `DIET: DAIRY-FREE — STRICT RULES:
- NO dairy: no milk, cheese, butter, cream, yogurt, whey, casein, ghee, or lactose.
- Watch for hidden dairy: use dairy-free dark chocolate, coconut/oat cream for sauces.
- Name the dairy-free alternative explicitly (e.g. "oat milk latte" not "latte", "coconut yogurt" not "yogurt").
- Grocery "dairy" list: dairy-free alternatives only — no actual dairy.`;
      break;

    case "mediterranean":
      block = `DIET: MEDITERRANEAN — STRICT RULES:
- Primary fat: extra-virgin olive oil only (not butter, not vegetable/canola oil).
- At least 1 fish/seafood meal per day (salmon, sardines, tuna, mackerel, shrimp, etc.).
- Poultry max 2–3×/week; red meat at most once per pairing.
- Dairy in moderation: small amounts of Greek yogurt, feta, Parmesan OK.
- NO ultra-processed foods or fast food. No wine (aviation crew).`;
      break;

    case "carnivore":
      block = `DIET: CARNIVORE — STRICT RULES:
- ONLY animal products: meat, fish, eggs, butter/tallow/lard/ghee.
- Include organ meat (liver, heart) at least once per pairing.
- ZERO plant ingredients: no veg, fruit, grains, legumes, nuts, seeds, sugar, or plant oils.
- Dairy optional: full-fat only (butter, heavy cream, hard cheese). Add tip that some carnivores exclude dairy.
- Include an electrolyte tip (bone broth, salt, sugar-free electrolytes) in at least one meal.
- Grocery produce + pantry categories: empty (carnivore only — no plant items).`;
      break;

    case "calorie_deficit":
      block = `DIET: CALORIE DEFICIT — see CALORIE DEFICIT GOAL below for daily kcal target.
- No food-type restrictions. Prioritize high-protein, high-fiber, high-volume, low-calorie-density foods for satiety.${calorieTarget ? `\n- Daily target: ${calorieTarget} kcal — meal calories must sum to ±50 kcal of this.` : ""}`;
      break;

    case "other":
      block = `DIET: Custom (see Diet field in CREW PROFILE above). Follow stated preferences closely; when in doubt, avoid anything that might conflict.`;
      break;

    default:
      block = `DIET: No restrictions. Balanced, nutritious meals with variety.`;
  }

  return block + FOOTER;
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
  const dietRules = getDietRules(data.diet, calorieTarget);

  const profile = `CREW PROFILE:
- Name: ${data.name}, Position: ${data.position}, Gender: ${data.gender}
- Weight: ${data.weight}, Diet: ${diet}${calorieTarget ? ` | GOAL: Calorie deficit — target exactly ${calorieTarget} kcal/day` : ""}
- Goals: ${(data.goals || []).join(", ")}
- Budget: ${budgetLine}
- Route: ${data.departure} -> ${destinations.join(" -> ")}
- Going to USA: ${data.going_usa}
- Jet lag (timezone diff): ${data.timezone || 0} hours${jetlag ? " -- SIGNIFICANT JET LAG, adjust meal timing for circadian rhythm" : ""}
- Kitchen access: ${(data.kitchen || []).join(", ") || "full_kitchen"} (see KITCHEN ACCESS CONSTRAINTS below for what's actually possible)`;

  return { langName, diet, jetlag, destinations, profile, hasBudget, perDayBudget, calorieTarget, calorieDeficitAmount, kitchenAccessBlock, dietRules };
}

function buildDayPrompt(data, dayNum, pairingDays, ctx) {
  const location = ctx.destinations[dayNum - 1] || data.departure;
  return `You are a professional nutritionist specializing in aviation crew health.

${ctx.profile}

${ctx.kitchenAccessBlock}

${ctx.dietRules}

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

${ctx.dietRules}

Daily itinerary:
${itinerary}

Generate the SUMMARY, GROCERY LIST, and FOOD RESTRICTIONS sections for this ${pairingDays}-day nutrition plan (day-by-day meals are generated separately).

Respond ONLY in ${ctx.langName}. Return ONLY valid JSON matching the schema.
- "summary": 2-sentence overview of the whole plan${ctx.calorieTarget ? `, noting that it targets a daily calorie deficit (~${ctx.calorieTarget} kcal/day) to support healthy, sustainable weight loss` : ""}.
- "groceryList": categorized shopping list (produce, protein, pantry, snacks, dairy) covering the whole pairing. IMPORTANT: every item in the grocery list must comply with the DIET RULES above — do not include any ingredient that violates the diet (e.g. no meat in a vegetarian list, no dairy in a vegan or dairy-free list, no gluten in a gluten-free list, no plant items in a carnivore list). Base items on the crew's kitchen access constraints (e.g. only ready-to-eat/no-prep items if no cooking equipment is available)${ctx.hasBudget ? ` and budget — keep total grocery costs realistically within $${(ctx.perDayBudget * pairingDays).toFixed(2)} (USD-equivalent) for the whole trip` : ""}.
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
      dayPromises.push(runStructured(buildDayPrompt(data, i, pairingDays, ctx), DAY_SCHEMA, 1400, FAST_MODEL));
    }
    const extrasPromise = runStructured(buildExtrasPrompt(data, pairingDays, ctx), EXTRAS_SCHEMA, 2000);

    const [days, extras] = await Promise.all([Promise.all(dayPromises), extrasPromise]);
    days.forEach((d, i) => {
      d.day = i + 1;
      d.totalCalories = d.meals.reduce((sum, m) => sum + m.calories, 0);
    });

    const updatedUsage = await incrementPairingUsage(email);

    const planResponse = {
      summary: extras.summary,
      days,
      groceryList: extras.groceryList,
      foodRestrictions: extras.foodRestrictions,
      pairingCount: updatedUsage.pairingCount,
      isPremium: updatedUsage.isPremium,
    };

    // Send plan email — failure is non-fatal, plan is returned regardless.
    sendPlanEmail(email, data.name, lang || "en", planResponse).catch(err =>
      console.error("Plan email failed:", err.message)
    );

    res.json(planResponse);
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
