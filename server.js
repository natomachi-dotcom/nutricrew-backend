import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import Anthropic from "@anthropic-ai/sdk";
import { Resend } from "resend";
import Stripe from "stripe";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { createHash, randomBytes } from "crypto";

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
  "https://nutricrew.ca",
  "https://www.nutricrew.ca",
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
// Stripe webhook MUST be before express.json() — Stripe requires the raw body
// to verify the signature. Defining the route here ensures Express runs
// express.raw() on this path before the global express.json() middleware.
app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: "Stripe not configured" });
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Stripe webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const email = session.customer_email || session.metadata?.email;
      if (email) {
        await fetch(`${CRUD_API_BASE}/api/set-premium`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
          body: JSON.stringify({
            email,
            stripeCustomerId: session.customer || null,
            stripeSubscriptionId: session.subscription || null,
          }),
        });
      }
    } else if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      await fetch(`${CRUD_API_BASE}/api/set-premium-by-customer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
        body: JSON.stringify({ stripeCustomerId: subscription.customer, isPremium: false }),
      });
    } else if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object;
      const isPremium = ["active", "trialing"].includes(subscription.status);
      await fetch(`${CRUD_API_BASE}/api/set-premium-by-customer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
        body: JSON.stringify({ stripeCustomerId: subscription.customer, isPremium }),
      });
    }
  } catch (err) {
    console.error("Stripe webhook handling failed:", err.message);
  }

  res.json({ received: true });
});

app.use(express.json());

const client = new Anthropic();
const FAST_MODEL = "claude-haiku-4-5-20251001";

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL || "NutriCrew <crewmealplans@nutricrew.ca>";

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://nutricrew.ca";

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

// Plan generation runs Haiku calls per request, so it gets a tighter limit,
// keyed by the crew member's email rather than just IP (shared IPs shouldn't
// throttle each other, but one account shouldn't hammer this endpoint).
const generatePlanLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.body?.data?.email?.toLowerCase().trim() || ipKeyGenerator(req.ip),
  message: { error: "Too many plan generation requests. Please try again later." },
});

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.body?.email?.toLowerCase().trim() || ipKeyGenerator(req.ip),
  message: { error: "Too many code requests. Please try again in 15 minutes." },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.body?.email?.toLowerCase().trim() || ipKeyGenerator(req.ip),
  message: { error: "Too many login attempts. Please try again in 15 minutes." },
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
    emoji: { type: "string" },
    container: { type: "string", description: "Recommended Tupperware/container size and shape for packing this meal, e.g. '500ml rectangular container' or '300ml round container with dividers'. Only include if a lunch bag size was provided." },
  },
  required: ["type", "name", "description", "prep", "calories", "protein", "carbs", "fat", "tip", "emoji"],
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

const DAYS_SCHEMA = {
  type: "object",
  properties: {
    days: { type: "array", items: DAY_SCHEMA },
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
async function checkPairingUsage(email, name, clientIP) {
  const res = await fetch(`${CRUD_API_BASE}/api/pairing-usage/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
    body: JSON.stringify({ email, name, clientIP }),
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

function generateOTPEmailHTML(otp) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>NutriCrew Verification</title></head>
<body style="margin:0;padding:24px 12px;background:#f0f4f8;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.10);">
  <tr><td style="background:#0A1628;padding:28px 32px;text-align:center;">
    <div style="font-size:24px;font-weight:bold;color:#C9A84C;letter-spacing:4px;">✈ NUTRICREW</div>
  </td></tr>
  <tr><td style="padding:36px 32px;text-align:center;">
    <div style="font-size:18px;color:#0A1628;font-weight:bold;margin-bottom:8px;">Your verification code</div>
    <div style="font-size:14px;color:#666;margin-bottom:24px;">Enter this code in the NutriCrew app to sign in.</div>
    <div style="font-size:52px;font-weight:bold;color:#1E3A6E;letter-spacing:14px;margin:0 0 24px;font-family:monospace;">${otp}</div>
    <div style="font-size:14px;color:#888;">This code expires in <strong>10 minutes</strong>.</div>
    <div style="font-size:13px;color:#aaa;margin-top:16px;">If you didn't request this, you can safely ignore this email.</div>
  </td></tr>
  <tr><td style="background:#0A1628;padding:18px 32px;text-align:center;">
    <div style="font-size:12px;color:#4A6080;">© NutriCrew · Fuel Your Flight</div>
  </td></tr>
</table>
</body></html>`;
}

// A short "your plan is ready" notice that sends crew into the app to view
// it, rather than rendering the full plan inline — the app is the primary
// surface for the plan, the email is just the nudge to go open it.
function generatePlanEmailHTML(name, lang, destLabel, printUrl) {
  const labelMap = {
    en: { greeting: "Hi", intro: "is ready.", cta: "Open NutriCrew App", print: "Print Meal Plan", body: "Tap below to view your personalized meals, grocery list, and food rules in the app.", disclaimer: "Generated by AI — for informational purposes only. Consult a healthcare professional before making significant dietary changes." },
    fr: { greeting: "Bonjour", intro: "est prêt.", cta: "Ouvrir l'app NutriCrew", print: "Imprimer le Plan", body: "Touchez ci-dessous pour voir vos repas personnalisés, votre liste de courses et vos règles alimentaires dans l'app.", disclaimer: "Généré par IA — à titre informatif uniquement. Consultez un professionnel de santé avant tout changement alimentaire important." },
    es: { greeting: "Hola", intro: "está listo.", cta: "Abrir la app NutriCrew", print: "Imprimir Plan", body: "Toca abajo para ver tus comidas personalizadas, lista de compras y reglas alimentarias en la app.", disclaimer: "Generado por IA — solo informativo. Consulta a un profesional de salud antes de hacer cambios significativos en tu dieta." },
  };
  const L = labelMap[lang] || labelMap.en;

  return `<!DOCTYPE html>
<html lang="${lang}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NutriCrew</title></head>
<body style="margin:0;padding:24px 12px;background:#f0f4f8;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.10);">

  <tr><td style="background:#0A1628;padding:36px 32px;text-align:center;">
    <div style="font-size:28px;font-weight:bold;color:#C9A84C;letter-spacing:4px;">✈ NUTRICREW</div>
    <div style="font-size:15px;color:#7BBFE0;margin-top:8px;">Crew Nutrition Plan</div>
  </td></tr>

  <tr><td style="padding:40px 32px;text-align:center;">
    <div style="font-size:48px;margin-bottom:16px;">🍽️</div>
    <div style="font-size:20px;font-weight:bold;color:#0A1628;margin-bottom:8px;">${L.greeting}, ${name}!</div>
    <div style="font-size:17px;color:#333;line-height:1.6;margin-bottom:20px;">Your <strong>${destLabel}</strong> meal plan ${L.intro}</div>
    <div style="font-size:15px;color:#666;line-height:1.7;margin-bottom:28px;">${L.body}</div>
    <a href="${FRONTEND_URL}?plan=1" style="display:inline-block;background:#C9A84C;color:#07101E;text-decoration:none;font-size:16px;font-weight:700;padding:16px 36px;border-radius:12px;">${L.cta} →</a>
    ${printUrl ? `
    <div style="margin-top:16px;">
      <a href="${printUrl}" style="display:inline-block;background:#ffffff;color:#0A1628;text-decoration:none;font-size:14px;font-weight:700;padding:12px 28px;border-radius:10px;border:2px solid #0A1628;">🖨️ ${L.print}</a>
    </div>` : ""}
  </td></tr>

  <tr><td style="background:#0A1628;padding:24px 32px;text-align:center;">
    <div style="font-size:13px;color:#7A8EAA;line-height:1.8;">${L.disclaimer}</div>
    <div style="font-size:13px;color:#4A6080;margin-top:10px;">© NutriCrew · Fuel Your Flight</div>
  </td></tr>

</table>
</body></html>`;
}

async function sendPlanEmail(toEmail, name, lang, destLabel, printUrl) {
  if (!process.env.RESEND_API_KEY) return;
  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to: [toEmail],
    subject: `✈ Your ${destLabel} meal plan is ready`,
    html: generatePlanEmailHTML(name, lang, destLabel, printUrl),
  });
  if (result.error) console.error("Plan email error:", result.error);
}

// ─── AI ───────────────────────────────────────────────────────────────────────

async function runStructured(prompt, schema, maxTokens, model = FAST_MODEL) {
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
  const u = message.usage;
  if (u) console.log(`[tokens] in=${u.input_tokens} out=${u.output_tokens} max=${maxTokens} model=${model.split("-")[1]}`);
  return extractJSON(message);
}

// Mifflin-St Jeor TDEE estimate for calorie deficit target.
// Uses actual age if provided, defaults to 35. Height defaults to 170 cm.
function estimateTDEE(data) {
  const weightStr = String(data.weight || "");
  const weightVal = parseFloat(weightStr);
  if (!weightVal) return null;
  const weightKg = /lb/i.test(weightStr) ? weightVal / 2.20462 : weightVal;
  const age = parseInt(data.age || 35, 10);
  const bmr = data.gender === "male"
    ? (10 * weightKg) + (6.25 * 170) - (5 * age) + 5
    : (10 * weightKg) + (6.25 * 170) - (5 * age) - 161;
  return bmr * 1.55;
}

function estimateCalorieDeficitTarget(data) {
  const tdee = estimateTDEE(data);
  if (!tdee) return null;
  const floor = data.gender === "male" ? 1500 : 1200;
  return Math.round(Math.max(tdee - 500, floor) / 50) * 50;
}

function estimateGainTarget(data) {
  const tdee = estimateTDEE(data);
  if (!tdee) return null;
  return Math.round((tdee + 400) / 50) * 50;
}

// Numeric budget alone doesn't tell the model which ingredients are
// realistic — without this, it'll happily suggest salmon and steak on a
// $15/day budget because nothing tells it those don't fit.
const BUDGET_GUIDANCE = {
  low: `BUDGET DISCIPLINE (low budget) — every meal must be realistically achievable within the stated budget. Build meals around affordable staples: rice, pasta, beans, lentils, eggs, canned tuna/chicken, frozen or seasonal vegetables, oats, potatoes, store-brand pantry items. Do NOT use premium proteins (steak, salmon, shrimp, lamb), out-of-season produce, or specialty/imported ingredients — they don't fit this budget.`,
  medium: `BUDGET (moderate) — a mix of fresh proteins (chicken, eggs, fish, pork) and pantry staples fits this budget. Occasional moderately-priced ingredients are fine; don't rely on premium cuts (steak, salmon, lamb) for every meal.`,
  high: `BUDGET (generous) — premium ingredients (salmon, steak, specialty produce, organic items) are appropriate and welcome where they fit the diet and goals.`,
  none: ``,
};

// Recipe complexity should match how much the crew member wants to cook —
// "simple" should mean genuinely fewer steps/ingredients, not just a label.
const COOKING_PREF_GUIDANCE = {
  enjoys_cooking: `COOKING STYLE — this crew member enjoys cooking. Recipes may include multiple steps, more involved techniques (searing, marinating, sauce-making), and longer ingredient lists where it fits their kitchen access.`,
  simple_recipes: `COOKING STYLE — this crew member wants simple, low-effort recipes. Every meal must use 5 ingredients or fewer (excluding salt/pepper/oil) and no more than 2 prep steps (e.g. "season and pan-fry", "mix and chill"). No marinating, no multi-component sauces, no advanced techniques.`,
};

const KITCHEN_ACCESS_RULES = {
  full_kitchen: `full_kitchen: Full kitchen (stove, oven, fridge, cookware). All cooking methods OK.`,
  hotel: `hotel: NO kitchen — no stove, oven, or any cooking equipment. Meals MUST be no-cook (ready-to-eat, assembled from pre-cooked/store-bought items, or grab-and-go). "prep" = assembly/slicing/opening only. NEVER mention cooking, heating on a stove, or baking. REFRIGERATION: for any perishable ingredient (fresh proteins, dairy, cut produce, pre-cooked items), add a note in the "tip" field stating it needs refrigeration — advise the crew member to request a hotel mini-fridge or to consume the item within 2 hours of purchase if no fridge is available.`,
  microwave: `microwave: No stove/oven, microwave only. No-cook/assembly (same as hotel) is fine, PLUS microwave methods (microwaveable cups, steam-in-bag veg, reheating). "prep" may include microwave times. NEVER mention stove, oven, or grill. REFRIGERATION: for any perishable ingredient, add a note in the "tip" field advising the crew member to request a hotel mini-fridge or consume within 2 hours if no fridge is available.`,
  airplane_food: `airplane_food: Airline meal served on board — no prep possible. "description"/"prep"/"tip" = how to SELECT or SUPPLEMENT airline/airport food (e.g. choose salad over fries, bring own nuts, ask for black coffee). Do NOT invent a from-scratch recipe.`,
  fridge: `fridge: Refrigerator available but NO cooking equipment (no stove, oven, or microwave). Meals MUST be cold/no-cook: pre-made salads, cold wraps, yogurt, cheese, deli meats, fresh fruit, overnight oats, cold-brew etc. "prep" = assemble/portion/slice only. Perishables can be stored safely in the fridge.`,
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

// Returns the rule block for a single diet key.
function getSingleDietBlock(diet, calorieTarget) {
  switch (diet) {
    case "none":
      return `DIET: No restrictions. Aim for balanced meals with proteins, complex carbs, healthy fats, and vegetables.`;
    case "vegetarian":
      return `DIET: VEGETARIAN — STRICT RULES:
- NO meat (any animal flesh) or fish/seafood.
- Eggs + dairy (cheese, milk, yogurt, butter) ARE allowed.
- Protein must come from: eggs, dairy, legumes, tofu, tempeh, seitan, nuts, seeds, or quinoa/edamame.
- If meal protein <15g, suggest a fix in the "tip" field.`;
    case "vegan":
      return `DIET: VEGAN — STRICT RULES:
- NO animal products: no meat, fish, eggs, dairy, honey, gelatin, or whey.
- Every ingredient must be 100% plant-based. Watch for hidden animal products: use plant butter/coconut oil not butter; dairy-free dark chocolate not regular; vegan dressing not Caesar; egg-free pasta; dairy-free bread.
- Protein must come from: legumes, tofu, tempeh, seitan, edamame, nuts, seeds, nutritional yeast.
- Grocery "dairy" list: plant-based alternatives only (oat milk, coconut yogurt, vegan cheese) — no actual dairy.
- If meal protein <15g, suggest a plant-protein fix in the "tip" field.`;
    case "gluten_free":
      return `DIET: GLUTEN-FREE (celiac-level) — STRICT RULES:
- NO wheat, barley, rye, spelt, regular oats, regular bread/pasta/flour tortillas/crackers/baked goods, soy sauce (use gluten-free tamari), or beer.
- YES: rice, quinoa, corn, potatoes, GF-certified oats, buckwheat, millet, lentils, all proteins, all veg/fruit.
- Always label packaged items as "gluten-free" (e.g. "gluten-free tamari", "gluten-free oats").
- Add a cross-contamination warning in the "tip" for any packaged/restaurant item.`;
    case "halal":
      return `DIET: HALAL — STRICT RULES:
- NO pork or pork-derived products (no bacon, ham, lard, pork gelatin).
- NO alcohol in any form (no wine sauces, beer, cooking wine, alcohol-based vanilla — use alcohol-free vanilla).
- All meat/poultry must be labeled "halal-certified".
- Seafood is permissible.
- Add a tip to verify halal certification at restaurants/stores, and a layover tip on finding halal options.`;
    case "kosher":
      return `DIET: KOSHER — STRICT RULES:
- NO pork. NO shellfish (shrimp, crab, lobster, clams, mussels, oysters, squid).
- NO meat + dairy in the same meal (keep them fully separate).
- All meat must be labeled "kosher-certified". Fish: fins + scales only (salmon, tuna, cod, tilapia OK; catfish, shark NOT OK).
- Prefer pareve meals (fish/eggs/veg/grains) for travel simplicity.
- Add a hechsher tip for restaurant meals.`;
    case "low_carb":
      return `DIET: LOW-CARB — STRICT RULES:
- MAX 50g total carbs/day across all meals combined. Add "~Xg carbs" tag to every meal.
- NO bread, pasta, rice, potatoes, sugar, most fruit (berries ≤50g OK), corn, juice, sweetened drinks.
- YES: all proteins, non-starchy veg (greens, broccoli, cauliflower, zucchini, peppers), cheese, nuts, seeds, avocado, olive oil.
- Make up calories from protein and fat. Verify total daily carbs ≤50g.`;
    case "dairy_free":
      return `DIET: DAIRY-FREE — STRICT RULES:
- NO dairy: no milk, cheese, butter, cream, yogurt, whey, casein, ghee, or lactose.
- Watch for hidden dairy: use dairy-free dark chocolate, coconut/oat cream for sauces.
- Name the dairy-free alternative explicitly (e.g. "oat milk latte" not "latte", "coconut yogurt" not "yogurt").
- Grocery "dairy" list: dairy-free alternatives only — no actual dairy.`;
    case "mediterranean":
      return `DIET: MEDITERRANEAN — STRICT RULES:
- Primary fat: extra-virgin olive oil only (not butter, not vegetable/canola oil).
- At least 1 fish/seafood meal per day (salmon, sardines, tuna, mackerel, shrimp, etc.).
- Poultry max 2–3×/week; red meat at most once per pairing.
- Dairy in moderation: small amounts of Greek yogurt, feta, Parmesan OK.
- NO ultra-processed foods or fast food. No wine (aviation crew).`;
    case "carnivore":
      return `DIET: CARNIVORE — STRICT RULES:
- ONLY animal products: meat, fish, eggs, butter/tallow/lard/ghee.
- Include organ meat (liver, heart) at least once per pairing.
- ZERO plant ingredients: no veg, fruit, grains, legumes, nuts, seeds, sugar, or plant oils.
- Dairy optional: full-fat only (butter, heavy cream, hard cheese). Add tip that some carnivores exclude dairy.
- Include an electrolyte tip (bone broth, salt, sugar-free electrolytes) in at least one meal.
- Grocery produce + pantry categories: empty (carnivore only — no plant items).`;
    case "calorie_deficit":
      return `DIET: CALORIE DEFICIT — see CALORIE DEFICIT GOAL below for daily kcal target.
- No food-type restrictions. Prioritize high-protein, high-fiber, high-volume, low-calorie-density foods for satiety.${calorieTarget ? `\n- Daily target: ${calorieTarget} kcal — meal calories must sum to ±50 kcal of this.` : ""}`;
    case "other":
      return `DIET: Custom (see Diet field in CREW PROFILE above). Follow stated preferences closely; when in doubt, avoid anything that might conflict.`;
    default:
      return `DIET: No restrictions. Balanced, nutritious meals with variety.`;
  }
}

// Accepts a single diet string or an array of diets (multi-select).
function getDietRules(rawDiet, calorieTarget) {
  const FOOTER = `\nCRITICAL: Check every ingredient against the rules above before finalizing each meal. Replace any violating item. Full compliance required — no partial exceptions.`;

  const diets = Array.isArray(rawDiet) ? rawDiet : (rawDiet ? [rawDiet] : []);
  const filtered = diets.filter(d => d && d !== "none");

  if (filtered.length === 0) {
    return `DIET: No restrictions. Aim for balanced meals with proteins, complex carbs, healthy fats, and vegetables.` + FOOTER;
  }

  if (filtered.length === 1) {
    return getSingleDietBlock(filtered[0], calorieTarget) + FOOTER;
  }

  const blocks = filtered.map(d => getSingleDietBlock(d, calorieTarget)).join("\n\n");
  return `COMBINED DIET — user follows ALL of these simultaneously. Apply ALL rules from every diet listed below:

${blocks}

COMBINED COMPLIANCE: Where rules conflict, apply the MOST RESTRICTIVE. If one diet allows dairy but another forbids it, exclude dairy entirely. Every single meal must satisfy every selected diet.` + FOOTER;
}

// Builds the shared crew-profile context used by every prompt for a plan.
function buildContext(data, lang, pairingDays) {
  const langName = lang === "fr" ? "French" : lang === "es" ? "Spanish" : "English";

  // Support both new multi-select (data.diets array) and legacy single (data.diet string).
  const rawDiets = Array.isArray(data.diets) ? data.diets : (data.diet ? [data.diet] : ["none"]);
  const filtered = rawDiets.filter(d => d && d !== "none");
  const hasCalorieDeficit = filtered.includes("calorie_deficit");

  const dietLabel = filtered.length === 0 ? "no restrictions"
    : filtered.map(d => {
        if (d === "other") return data.diet_other || "custom diet";
        if (d === "calorie_deficit") return "calorie deficit";
        return d.replace(/_/g, " ");
      }).join(" + ");

  const jetlag = Math.abs(parseInt(data.timezone || 0, 10)) >= 4;
  const destinations = (data.destinations || []).slice(0, MAX_PAIRING_DAYS);
  // Prefer the user-selected calorie target sent from the frontend;
  // fall back to the server-side weight+age estimate for backwards compat.
  const calorieTarget = hasCalorieDeficit
    ? (data.calorie_target || estimateCalorieDeficitTarget(data))
    : null;
  const calorieDeficitAmount = hasCalorieDeficit
    ? (data.calorie_deficit_amount || null)
    : null;
  const goals = data.goals || [];
  const hasGainWeight = goals.includes("gain_weight");
  const gainTarget = hasGainWeight ? estimateGainTarget(data) : null;
  const maintenanceTarget = (!hasCalorieDeficit && !hasGainWeight) ? Math.round(estimateTDEE(data)) : null;

  const budgetAmount = parseFloat(data.budget_amount);
  const hasBudget = budgetAmount > 0;
  const perDayBudget = hasBudget
    ? (data.budget_type === "total" ? budgetAmount / pairingDays : budgetAmount)
    : null;
  const budgetLine = hasBudget
    ? `$${data.budget_amount} per ${data.budget_type === "total" ? `trip (~$${perDayBudget.toFixed(2)}/day across ${pairingDays} days)` : "day"}`
    : "open (no specific limit)";
  const budgetLevel = !hasBudget ? "none" : perDayBudget > 50 ? "high" : perDayBudget > 20 ? "medium" : "low";
  const budgetGuidance = BUDGET_GUIDANCE[budgetLevel];

  const kitchenAccessBlock = buildKitchenAccessBlock(data.kitchen);
  const dietRules = getDietRules(rawDiets, calorieTarget);

  const ageStr = data.age ? `, Age: ${data.age}` : "";
  const goalNote = calorieTarget
    ? ` | GOAL: Calorie deficit — target exactly ${calorieTarget} kcal/day`
    : gainTarget
    ? ` | GOAL: Weight gain — target exactly ${gainTarget} kcal/day`
    : "";
  const lunchBagMap = { small: "Small (~4L, fits 1–2 containers)", medium: "Medium (~6L, fits 2–3 containers)", large: "Large (~10L, fits 3–4 containers + extras)" };
  const lunchBag = data.lunch_bag ? lunchBagMap[data.lunch_bag] || data.lunch_bag : null;
  const airplaneMealDesc = (data.airplane_meal_description || "").trim() || null;
  const cookingGuidance = COOKING_PREF_GUIDANCE[data.cooking_pref] || "";

  const profile = `CREW PROFILE:
- Name: ${data.name}, Position: ${data.position}, Gender: ${data.gender}${ageStr}
- Weight: ${data.weight}, Diet: ${dietLabel}${goalNote}
- Goals: ${goals.join(", ") || "none specified"}
- Budget: ${budgetLine}
- Route: ${data.departure} -> ${destinations.join(" -> ")}
- Going to USA: ${data.going_usa}
- Jet lag (timezone diff): ${data.timezone || 0} hours${jetlag ? " -- SIGNIFICANT JET LAG, adjust meal timing for circadian rhythm" : ""}
- Kitchen access: ${(data.kitchen || []).join(", ") || "full_kitchen"} (see KITCHEN ACCESS CONSTRAINTS below for what's actually possible)${lunchBag ? `\n- Lunch bag size: ${lunchBag}` : ""}${airplaneMealDesc ? `\n- Airplane meal (provided on board): ${airplaneMealDesc}` : ""}`;

  return { langName, dietLabel, rawDiets, jetlag, destinations, profile, hasBudget, perDayBudget, budgetGuidance, calorieTarget, calorieDeficitAmount, gainTarget, maintenanceTarget, goals, kitchenAccessBlock, dietRules, lunchBag, airplaneMealDesc, cookingGuidance };
}

function buildAllDaysPrompt(data, pairingDays, ctx) {
  const daySpecs = Array.from({ length: pairingDays }, (_, i) => {
    const dayNum = i + 1;
    const loc = ctx.destinations[i] || data.departure;
    const jetlagInstr = ctx.jetlag && dayNum === 1
      ? `jetlagNote: short, practical meal-timing advice for adjusting to the jet lag above. Phrase purely in ${loc} local time — no cross-timezone clock conversions, no "eastward"/"westward" direction.`
      : `jetlagNote: null`;
    const budgetLine = ctx.hasBudget
      ? `Budget: ~$${ctx.perDayBudget.toFixed(2)} USD for today's ingredients near ${loc}.`
      : "";
    return `Day ${dayNum} — Location: ${loc}. ${budgetLine} ${jetlagInstr}`;
  }).join("\n");

  const usaCustomsBlock = data.going_usa === "yes" ? `
⚠️ HARD RULE — US BORDER CROSSING: Every single meal and ingredient in this plan MUST be legal to carry across the US border (US CBP / USDA rules). Do NOT include anything from this list in ANY meal, ingredient, or snack:
- Any fresh fruit (apples, oranges, mangoes, bananas, grapes, berries, citrus, stone fruits, etc.)
- Any fresh vegetable (tomatoes, peppers, leafy greens, cucumbers, carrots, broccoli, onions, etc.)
- Raw meat, poultry, or seafood of any kind
- Raw eggs or hard-boiled eggs in the shell
- Unpasteurized dairy or soft fresh cheese (ricotta, cottage cheese) in unsealed containers
- Fresh herbs with roots or soil

Only use ingredients that are commercially packaged and sealed, canned, dried, or fully shelf-stable. Examples: canned tuna, canned chicken, sealed deli pouches, hard cheese in sealed packaging, sealed pasteurized dairy, dried fruits, nuts, granola bars, crackers, packaged bread, canned beans, instant oats, packaged trail mix. This rule overrides all other preferences — if a food is prohibited at the US border, never include it.
` : "";

  return `You are a professional nutritionist specializing in aviation crew health.
${usaCustomsBlock}
${ctx.profile}

${ctx.kitchenAccessBlock}

${ctx.dietRules}
${ctx.budgetGuidance ? `\n${ctx.budgetGuidance}\n` : ""}${ctx.cookingGuidance ? `\n${ctx.cookingGuidance}\n` : ""}
Generate ALL ${pairingDays} day(s) of this nutrition plan in a single response. Return a JSON object with a "days" array of exactly ${pairingDays} day object(s), in order.

Respond ONLY in ${ctx.langName}. Return ONLY valid JSON matching the schema.
Each day: include Breakfast, Lunch, Dinner, and 1-2 Snacks.
The meal "type" field must always be the literal English word "Breakfast", "Lunch", "Dinner", or "Snack" — never translate it — even though every other field must be in ${ctx.langName}.
Every meal must include a "tip" and an "emoji" field with 2–3 food emoji accurately representing the meal.${ctx.lunchBag ? `\nFor every packable meal (not airplane meals), include a "container" field specifying the exact Tupperware size and shape that fits the crew member's ${ctx.lunchBag} lunch bag — e.g. "500ml rectangular container", "300ml round container with clip lid", "2× 200ml sauce containers". Size containers to fit within the bag limits.` : ""}${ctx.airplaneMealDesc ? `\nThe crew member has told us their airplane meal will include: "${ctx.airplaneMealDesc}". For any meal of type "airplane_food", describe how to complement or adapt this specific meal (e.g. add protein, skip the dessert, supplement with a snack). Plan the rest of the day's meals to balance the nutrients already provided by this airplane meal.` : ""}
Vary meal choices across all days — different recipes, ingredients, and combinations each day.

Per-day instructions:
${daySpecs}
${ctx.calorieTarget ? `
CALORIE DEFICIT GOAL: targeting a calorie deficit for weight loss.
- Daily calorie target: ${ctx.calorieTarget} kcal
${ctx.calorieDeficitAmount ? `- Deficit: ${ctx.calorieDeficitAmount} kcal below maintenance (~${(ctx.calorieDeficitAmount / 7700 * 7).toFixed(2)} kg/week)` : ""}
- Each day's meal "calories" SUM must be within ±50 kcal of ${ctx.calorieTarget}. Do NOT exceed it.
- Prioritize high-protein, high-fiber, low-calorie-density foods.` : ""}
${ctx.gainTarget ? `
WEIGHT GAIN GOAL: targeting a calorie surplus for weight/muscle gain.
- Daily calorie target: ${ctx.gainTarget} kcal
- Each day's meal "calories" SUM must be within ±75 kcal of ${ctx.gainTarget}.
- Prioritize calorie-dense, protein-rich foods (lean meats, eggs, legumes, nuts, seeds, whole grains, healthy fats). Larger portions encouraged.
- Include 2 snacks minimum per day (energy-dense: trail mix, nut butter, protein smoothie ingredients).
- Avoid low-calorie-density "diet" foods.` : ""}
${!ctx.calorieTarget && !ctx.gainTarget && ctx.maintenanceTarget ? `
MAINTENANCE CALORIE GOAL (HARD REQUIREMENT — this is NOT a diet plan):
- Calculated TDEE: ${ctx.maintenanceTarget} kcal/day. This is the target. Do NOT go below ${ctx.maintenanceTarget - 100} kcal.
- Each day MUST include EXACTLY 2 Snacks (not 1). The 5 meals cover: Breakfast, Lunch, Dinner, Snack, Snack.
- Target calorie split across the 5 meals:
    Breakfast: ~${Math.round(ctx.maintenanceTarget * 0.25)} kcal
    Lunch:     ~${Math.round(ctx.maintenanceTarget * 0.30)} kcal
    Dinner:    ~${Math.round(ctx.maintenanceTarget * 0.28)} kcal
    Snack 1:   ~${Math.round(ctx.maintenanceTarget * 0.09)} kcal
    Snack 2:   ~${Math.round(ctx.maintenanceTarget * 0.08)} kcal
    Total:     ~${ctx.maintenanceTarget} kcal
- Use full-sized portions. Add calorie-dense ingredients where needed: olive oil, avocado, nuts, cheese, whole grains, legumes, nut butter, Greek yogurt.
- VERIFY: sum all 5 meal "calories" values. If total < ${ctx.maintenanceTarget - 100} kcal, increase portion sizes before finalizing.` : ""}`;
}

function getDestinationFoodRules(destinations) {
  const dest = (destinations || []).join(" ").toUpperCase();
  const rules = [];

  const hasAny = (codes) => codes.some(c => dest.includes(c));

  const DISCLAIMER = "\n⚠️ Rules can change — always verify with the destination country's official customs/border authority or IATA travel advisories before your pairing.";

  // UK — all major airports including secondary London airports
  if (hasAny(["LHR", "LGW", "LTN", "LCY", "STN", "MAN", "EDI", "GLA", "BHX", "BRS", "NCL", "LBA", "ABZ", "BFS", "BHD", "SOU", "EXT", "CWL"])) {
    rules.push(`UNITED KINGDOM CUSTOMS (HMRC/DEFRA):
- NO meat or dairy products from outside the UK (post-Brexit rules; EU products now restricted like non-EU).
- Fresh fruit and vegetables from non-EU countries may require phytosanitary certificates.
- Commercially sealed, fully cooked, or shelf-stable products are generally permitted.
- Alcohol duty-free limit: 1L spirits or 2L wine/beer per adult.
- Declare any food exceeding personal allowance — fines up to £5,000 for violations.${DISCLAIMER}`);
  }

  // EU / Schengen — France, Germany, Benelux, Netherlands, Spain, Italy, Portugal, Austria, Switzerland, Scandinavia, Eastern Europe, Ireland, Greece
  if (hasAny([
    // France
    "CDG", "ORY", "NCE", "LYS", "MRS", "TLS", "NTE", "BOD", "SXB", "MPL", "LIL",
    // Germany
    "FRA", "MUC", "BER", "HAM", "DUS", "CGN", "STR", "NUE", "HAJ", "DTM", "LEJ",
    // Netherlands / Belgium / Luxembourg
    "AMS", "EIN", "BRU", "CRL", "LUX",
    // Spain / Portugal
    "MAD", "BCN", "PMI", "AGP", "ALC", "VLC", "SVQ", "LIS", "OPO", "FAO",
    // Italy
    "FCO", "MXP", "LIN", "NAP", "VCE", "BLQ", "CTA", "BGY", "PMO",
    // Austria / Switzerland
    "VIE", "SZG", "ZRH", "GVA", "BSL",
    // Scandinavia
    "ARN", "GOT", "MMX", "CPH", "AAL", "BLL", "HEL", "TMP", "OSL", "BGO", "TRD",
    // Eastern Europe
    "WAW", "KRK", "PRG", "BUD", "OTP", "SOF", "LJU", "ZAG", "RIX", "TLL", "VNO",
    // Greece / Cyprus / Malta
    "ATH", "SKG", "HER", "RHO", "MLA",
    // Ireland
    "DUB", "ORK", "SNN",
  ])) {
    rules.push(`EU / SCHENGEN AREA CUSTOMS:
- Travelers from outside the EU: NO meat or dairy products allowed (strict EU animal health rules).
- Fresh fruits and vegetables from non-EU countries prohibited without an official phytosanitary certificate.
- Commercially packaged and sealed food (shelf-stable, hermetically sealed) is generally permitted.
- Duty-free limits from non-EU: 1L spirits, 2L wine, 200 cigarettes per adult.
- Declare all food at customs when arriving from non-EU countries — penalties apply for undeclared items.${DISCLAIMER}`);
  }

  // Japan
  if (hasAny(["NRT", "HND", "KIX", "NGO", "CTS", "FUK", "OKA", "OIT", "KMI", "KMJ", "SDJ"])) {
    rules.push(`JAPAN CUSTOMS (Ministry of Agriculture, Forestry and Fisheries):
- Strict plant quarantine: fresh fruits and vegetables from most countries prohibited; must be inspected and certified.
- Meat products from many countries restricted or banned (especially pork from countries with foot-and-mouth disease).
- Commercially sealed processed foods (chips, cookies, sealed instant meals) are generally permitted.
- No soil or plants with roots allowed.
- Declare ALL food items on the customs form — Japan conducts thorough inspections; undeclared items may be confiscated.
- Allowed: packaged snacks, sealed chocolates, vacuum-sealed processed meats with valid inspection certificate.${DISCLAIMER}`);
  }

  // Australia
  if (hasAny(["SYD", "MEL", "BNE", "PER", "ADL", "CBR", "OOL", "CNS", "DRW", "HBA", "TSV", "MKY", "ROK", "LST"])) {
    rules.push(`AUSTRALIA CUSTOMS (DAFF — Department of Agriculture, Fisheries and Forestry):
- VERY strict biosecurity — one of the strictest in the world.
- ALL fresh or dried fruit, vegetables, meat, eggs, seeds, nuts, and plant material must be declared.
- Many fresh and unprocessed items will be confiscated or treated at your expense.
- Commercially sealed and heat-treated packaged goods (sealed chocolates, chips, biscuits) generally OK.
- Failure to declare carries fines up to AUD $2,220 or criminal prosecution.
- Always declare everything on the Incoming Passenger Card — inspectors use detector dogs.${DISCLAIMER}`);
  }

  // UAE / Gulf States — UAE, Qatar, Oman, Kuwait, Bahrain, Saudi Arabia
  if (hasAny([
    // UAE
    "DXB", "AUH", "SHJ", "DWC", "AAN", "RKT", "FJR",
    // Qatar / Oman / Kuwait / Bahrain
    "DOH", "MCT", "SLL", "KWI", "BAH",
    // Saudi Arabia
    "RUH", "JED", "DMM", "MED", "TUU", "AHB", "GIZ",
  ])) {
    rules.push(`UAE / GULF STATES CUSTOMS:
- Pork products and alcohol are restricted or prohibited in most Gulf states.
  - UAE: pork available only in licensed shops; personal import is restricted.
  - Saudi Arabia: pork and alcohol strictly prohibited — confiscation and legal penalties apply.
  - Qatar: pork restricted; alcohol only in licensed hotels, not for personal import.
  - Kuwait & Bahrain: alcohol and pork import prohibited.
- All commercially imported food must be Halal-certified; carry packaging with Halal certification visible.
- Commercially sealed non-pork snacks and packaged foods are generally permitted.
- Medications: declare any controlled substances or large medicine quantities.${DISCLAIMER}`);
  }

  // Mexico
  if (hasAny(["MEX", "CUN", "GDL", "MTY", "TLC", "SJD", "PVR", "MID", "OAX", "VER", "TAM", "ZIH", "MZT", "HMO", "CUU", "TIJ", "MXL", "LAP", "MLM", "BJX", "QRO"])) {
    rules.push(`MEXICO CUSTOMS (SAT / SENASICA):
- Duty-free personal allowance: USD $500 in goods per adult (air travel).
- Fresh fruits, vegetables, and unprocessed meat products from abroad may be restricted — SENASICA inspects for agricultural pests.
- Commercial packaged and sealed food products are generally permitted in reasonable personal quantities.
- Declare amounts of cash exceeding USD $10,000 equivalent.
- Food for personal consumption (sealed, commercially packaged) is usually fine — avoid bulk quantities.${DISCLAIMER}`);
  }

  // Canada
  if (hasAny(["YYZ", "YUL", "YVR", "YYC", "YEG", "YOW", "YHZ", "YWG", "YQB", "YXE", "YQR", "YYJ", "YXX", "YYT", "YFC", "YHM", "YKF", "YLW"])) {
    rules.push(`CANADA CUSTOMS (CBSA):
- Most commercially packaged, sealed food products are permitted.
- Fresh fruits and vegetables may be restricted depending on origin country (declare and let CBSA inspect).
- Meat and dairy from the US generally OK; from other countries, restrictions apply.
- Duty-free: 1.5L wine or 1.14L spirits or 8.5L beer per adult (19+ in most provinces).
- Declare ALL food items on the CBSA declaration card — inspectors use detector dogs; undeclared items result in fines.${DISCLAIMER}`);
  }

  if (rules.length === 0) {
    rules.push(`DESTINATION CUSTOMS (general guidance — specific country rules not found in database):
- Always declare food items at customs when crossing any international border.
- Fresh fruits, vegetables, meat, dairy, and plants are commonly restricted — check the specific country's customs authority or government website before traveling.
- Commercially sealed and packaged shelf-stable foods are generally permitted in personal quantities.
- When in doubt, consume perishables before landing or leave them behind.
${DISCLAIMER}`);
  }

  return rules.join("\n\n");
}

function buildExtrasPrompt(data, pairingDays, ctx) {
  const itinerary = ctx.destinations.map((d, i) => `  Day ${i + 1}: ${d}`).join("\n");
  const usaGroceryBlock = data.going_usa === "yes" ? `
⚠️ HARD RULE — US BORDER CROSSING: Every item in the grocery list MUST be legal to carry across the US border (US CBP / USDA rules). Do NOT include any of the following:
- Any fresh fruit (apples, oranges, mangoes, bananas, grapes, berries, citrus, stone fruits, etc.)
- Any fresh vegetable (tomatoes, peppers, leafy greens, cucumbers, carrots, broccoli, onions, etc.)
- Raw meat, poultry, or seafood of any kind
- Raw eggs or hard-boiled eggs in the shell
- Unpasteurized dairy or soft fresh cheese in unsealed containers
- Fresh herbs with roots or soil

Only list items that are commercially packaged and sealed, canned, dried, or fully shelf-stable. This rule overrides all other preferences — if a food is prohibited at the US border, never include it in the grocery list.
` : "";

  const destFoodRules = getDestinationFoodRules(ctx.destinations);

  return `You are a professional nutritionist specializing in aviation crew health.
${usaGroceryBlock}
${ctx.profile}

${ctx.kitchenAccessBlock}

${ctx.dietRules}
${ctx.budgetGuidance ? `\n${ctx.budgetGuidance}\n` : ""}
Daily itinerary:
${itinerary}

DESTINATION CUSTOMS & FOOD RULES (use this as the basis for the "destination" field in foodRestrictions):
${destFoodRules}

Generate the SUMMARY, GROCERY LIST, and FOOD RESTRICTIONS sections for this ${pairingDays}-day nutrition plan (day-by-day meals are generated separately).

Respond ONLY in ${ctx.langName}. Return ONLY valid JSON matching the schema.
- "summary": 2-sentence overview of the whole plan${ctx.calorieTarget ? `, noting that it targets a daily calorie deficit (~${ctx.calorieTarget} kcal/day) to support healthy, sustainable weight loss` : ctx.gainTarget ? `, noting that it targets a calorie surplus (~${ctx.gainTarget} kcal/day) to support healthy weight and muscle gain` : ""}.
- "groceryList": categorized shopping list (produce, protein, pantry, snacks, dairy) covering the whole pairing. IMPORTANT: every item in the grocery list must comply with the DIET RULES above — do not include any ingredient that violates the diet (e.g. no meat in a vegetarian list, no dairy in a vegan or dairy-free list, no gluten in a gluten-free list, no plant items in a carnivore list). Base items on the crew's kitchen access constraints (e.g. only ready-to-eat/no-prep items if no cooking equipment is available)${ctx.hasBudget ? ` and budget — keep total grocery costs realistically within $${(ctx.perDayBudget * pairingDays).toFixed(2)} (USD-equivalent) for the whole trip` : ""}.
- "foodRestrictions": "usa" (detailed list of what cannot be brought into the USA and why; if going_usa is "no", write "Not applicable — not traveling to the USA"), "destination" (summarize the DESTINATION CUSTOMS & FOOD RULES above into practical crew-focused bullet points for ${ctx.destinations.join(", ")}), "general" (general tips for a ${ctx.dietLabel} diet while traveling).`;
}

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "NutriCrew AI backend is running" });
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────

app.post("/api/auth/send-otp", otpLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== "string" || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "Valid email is required." });
    }
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpHash = createHash("sha256").update(otp).digest("hex");

    const storeRes = await fetch(`${CRUD_API_BASE}/api/auth/store-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
      body: JSON.stringify({ email: email.toLowerCase().trim(), otpHash, clientIP: req.ip }),
    });
    if (!storeRes.ok) {
      const err = await storeRes.json().catch(() => ({}));
      return res.status(storeRes.status).json({ error: err.error || "Failed to send code. Please try again." });
    }
    const storeData = await storeRes.json();

    // Email already verified — return a fresh session token directly, no code needed.
    if (storeData.alreadyVerified) {
      return res.json({ alreadyVerified: true, token: storeData.token, email: storeData.email, name: storeData.name, isPremium: storeData.isPremium, pairingCount: storeData.pairingCount, hasPassword: storeData.hasPassword });
    }

    if (process.env.RESEND_API_KEY) {
      const emailResult = await resend.emails.send({
        from: FROM_EMAIL,
        to: [email],
        subject: `${otp} is your NutriCrew verification code`,
        html: generateOTPEmailHTML(otp),
      });
      if (emailResult.error) console.error("OTP email error:", emailResult.error);
    } else {
      console.log(`[DEV] OTP for ${email}: ${otp}`);
    }

    res.json({ alreadyVerified: false });
  } catch (err) {
    console.error("send-otp error:", err.message);
    res.status(500).json({ error: "Failed to send code. Please try again." });
  }
});

app.post("/api/auth/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: "Email and code are required." });
    const otpHash = createHash("sha256").update(String(otp).trim()).digest("hex");

    const checkRes = await fetch(`${CRUD_API_BASE}/api/auth/check-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
      body: JSON.stringify({ email: email.toLowerCase().trim(), otpHash, clientIP: req.ip }),
    });
    const data = await checkRes.json();
    if (!checkRes.ok) return res.status(checkRes.status).json(data);
    res.json(data);
  } catch (err) {
    console.error("verify-otp error:", err.message);
    res.status(500).json({ error: "Verification failed. Please try again." });
  }
});

app.post("/api/auth/login-password", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || typeof email !== "string" || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "Valid email is required." });
    }
    if (!password || typeof password !== "string") {
      return res.status(400).json({ error: "Password is required." });
    }

    const checkRes = await fetch(`${CRUD_API_BASE}/api/auth/check-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
      body: JSON.stringify({ email: email.toLowerCase().trim(), password }),
    });
    const data = await checkRes.json();
    if (!checkRes.ok) return res.status(checkRes.status).json(data);
    res.json(data);
  } catch (err) {
    console.error("login-password error:", err.message);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// Requires a valid existing session token as proof of identity — used both
// right after OTP verification (set first password) and later from the profile (change password).
app.post("/api/auth/set-password", async (req, res) => {
  try {
    const { email, password, token } = req.body;
    if (!email || !password || !token) {
      return res.status(400).json({ error: "Email, password and token are required." });
    }
    const setRes = await fetch(`${CRUD_API_BASE}/api/auth/set-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
      body: JSON.stringify({ email: email.toLowerCase().trim(), password, token }),
    });
    const data = await setRes.json();
    if (!setRes.ok) return res.status(setRes.status).json(data);
    res.json(data);
  } catch (err) {
    console.error("set-password error:", err.message);
    res.status(500).json({ error: "Failed to set password. Please try again." });
  }
});

app.post("/api/auth/verify-session", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(401).json({ error: "No token provided." });

    const checkRes = await fetch(`${CRUD_API_BASE}/api/auth/check-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
      body: JSON.stringify({ token }),
    });
    const data = await checkRes.json();
    if (!checkRes.ok) return res.status(checkRes.status).json(data);
    res.json(data);
  } catch (err) {
    console.error("verify-session error:", err.message);
    res.status(500).json({ error: "Session check failed." });
  }
});

// ─── PLAN GENERATION ──────────────────────────────────────────────────────────

// ── MEAL CACHE HELPERS ────────────────────────────────────────────

function buildCacheKey(data, ctx, lang) {
  const diets = (Array.isArray(data.diets) ? data.diets : (data.diet ? [data.diet] : [])).filter(Boolean).sort();
  const goals = (data.goals || []).slice().sort();
  const perDay = ctx.perDayBudget;
  const budgetLevel = !perDay ? "none" : perDay > 50 ? "high" : perDay > 20 ? "medium" : "low";
  const kitchen = (data.kitchen || []).slice().sort();
  const ct = ctx.calorieTarget ? String(Math.round(ctx.calorieTarget / 100) * 100) : (ctx.gainTarget ? `gain${Math.round(ctx.gainTarget / 100) * 100}` : "none");
  return {
    dietKey: diets.join(",") || "none",
    goalKey: goals.join(",") || "none",
    budgetLevel,
    kitchenKey: kitchen.join(",") || "full_kitchen",
    calorieTargetKey: ct,
    cookingKey: data.cooking_pref || "none",
    lang: lang || "en",
  };
}

async function crudInternal(path, body) {
  const r = await fetch(`${CRUD_API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`CRUD ${path} returned ${r.status}`);
  return r.json();
}

async function queryCachedDays(email, cacheKey, count) {
  try {
    return await crudInternal("/api/meal-cache/query", { email, ...cacheKey, count });
  } catch { return { days: [], total: 0 }; }
}

async function storeCachedDays(days, cacheKey) {
  try {
    return await crudInternal("/api/meal-cache/store", { days, ...cacheKey });
  } catch (e) { console.error("meal-cache/store failed:", e.message); return { ids: [] }; }
}

function buildExtrasCacheKey(data, ctx, lang, pairingDays) {
  const base = buildCacheKey(data, ctx, lang);
  const destinations = (data.destinations || []).slice().sort();
  return { ...base, destinationKey: destinations.join(",") || "none", goingUsa: data.going_usa === "yes" ? "yes" : "no", pairingDays };
}

async function queryExtrasCache(extrasKey) {
  try {
    const r = await crudInternal("/api/extras-cache/query", extrasKey);
    return r.hit ? r.extras : null;
  } catch { return null; }
}

function storeExtrasCache(extrasKey, extras) {
  crudInternal("/api/extras-cache/store", { ...extrasKey, ...extras }).catch(e =>
    console.error("extras-cache/store failed:", e.message)
  );
}

async function markDaysSeen(email, dayIds) {
  if (!dayIds || dayIds.length === 0) return;
  try { await crudInternal("/api/meal-cache/mark-seen", { email, dayIds }); }
  catch (e) { console.error("meal-cache/mark-seen failed:", e.message); }
}

// ─────────────────────────────────────────────────────────────────

app.post("/api/generate-plan", generatePlanLimiter, async (req, res) => {
  try {
    const { data, lang } = req.body;
    if (!data) return res.status(400).json({ error: "Missing 'data' in request body" });

    const email = (data.email || "").toLowerCase().trim();
    if (!email) return res.status(400).json({ error: "Missing 'email' in request data" });
    if (!EMAIL_REGEX.test(email)) return res.status(400).json({ error: "Invalid 'email' format" });

    const pairingDays = Math.min(Math.max(parseInt(data.pairing_days, 10) || 1, 1), MAX_PAIRING_DAYS);
    const ctx = buildContext(data, lang, pairingDays);
    const cacheKey = buildCacheKey(data, ctx, lang);
    const extrasKey = buildExtrasCacheKey(data, ctx, lang, pairingDays);

    // Run auth check, meal cache query, and extras cache query all in parallel
    const [usage, { days: cachedDays }, cachedExtras] = await Promise.all([
      checkPairingUsage(email, data.name, req.ip),
      queryCachedDays(email, cacheKey, pairingDays),
      queryExtrasCache(extrasKey),
    ]);

    if (!usage.allowed) {
      return res.status(403).json({
        error: "premium_required",
        message: "You've used your free pairing plan. Upgrade to Premium for unlimited plans.",
        pairingCount: usage.pairingCount,
      });
    }

    const reqDiets = Array.isArray(data.diets) ? data.diets : (data.diet ? [data.diet] : []);
    if (reqDiets.includes("calorie_deficit") && !usage.isPremium) {
      return res.status(403).json({
        error: "premium_required",
        message: "Calorie Deficit plans are a Premium feature. Upgrade to Premium to unlock this and unlimited plans.",
        pairingCount: usage.pairingCount,
      });
    }

    const cachedDayIds = cachedDays.map(d => d._id);
    let days;
    let newDayIds = [];

    // Start EXTRAS: use cache if available, otherwise generate with Haiku
    const extrasPromise = cachedExtras
      ? Promise.resolve(cachedExtras)
      : runStructured(buildExtrasPrompt(data, pairingDays, ctx), EXTRAS_SCHEMA, 1200, FAST_MODEL)
          .then(result => { storeExtrasCache(extrasKey, result); return result; });

    if (cachedDays.length >= pairingDays) {
      // Full cache hit — no DAYS API call needed
      days = cachedDays.slice(0, pairingDays).map((d, i) => ({
        day: i + 1,
        label: `Day ${i + 1}`,
        jetlagNote: null,
        meals: d.meals,
        totalCalories: d.totalCalories,
      }));
      console.log(`[meal-cache] HIT for ${email}: days=cache extras=${cachedExtras ? "cache" : "ai"}`);
    } else {
      // Partial or full cache miss — generate missing days (EXTRAS runs in parallel)
      const missing = pairingDays - cachedDays.length;
      const maxDayTokens = Math.min(2200 * missing, 7500);

      const missingData = { ...data, pairing_days: missing };
      const missingCtx = buildContext(missingData, lang, missing);
      const daysResult = await runStructured(
        buildAllDaysPrompt(missingData, missing, missingCtx),
        DAYS_SCHEMA, maxDayTokens, FAST_MODEL
      );

      const aiDays = daysResult.days.map(d => ({
        meals: d.meals,
        totalCalories: d.meals.reduce((s, m) => s + m.calories, 0),
        label: d.label,
        jetlagNote: d.jetlagNote,
      }));

      const stored = await storeCachedDays(aiDays, cacheKey);
      newDayIds = stored.ids || [];

      const allDays = [
        ...cachedDays.map(d => ({ meals: d.meals, totalCalories: d.totalCalories, label: null, jetlagNote: null })),
        ...aiDays,
      ];
      days = allDays.slice(0, pairingDays).map((d, i) => ({
        day: i + 1,
        label: d.label || `Day ${i + 1}`,
        jetlagNote: d.jetlagNote ?? null,
        meals: d.meals,
        totalCalories: d.totalCalories,
      }));
      console.log(`[meal-cache] MISS for ${email}: generated ${missing} day(s) extras=${cachedExtras ? "cache" : "ai"}`);
    }

    const extras = await extrasPromise;

    // Fire-and-forget: mark seen + increment (neither blocks the response)
    markDaysSeen(email, [...cachedDayIds, ...newDayIds]);
    incrementPairingUsage(email).catch(e => console.error("increment failed:", e.message));

    const planResponse = {
      summary: extras.summary,
      days,
      groceryList: extras.groceryList,
      foodRestrictions: extras.foodRestrictions,
      pairingCount: usage.pairingCount + 1,
      isPremium: usage.isPremium,
    };

    // Only the roster-automation flow can deep-link the email back to the plan
    // (it's the only one that persists the plan server-side under a token) — for
    // in-app generation the user is already looking at the plan, so emailing them
    // a link that can't deep-link anywhere would just be confusing.
    if (data.source === "roster") {
      const destLabel = Array.isArray(data.destinations) ? data.destinations.join(" → ") : (data.destinations || "your destination");
      const printUrl = data.confirm_token ? `${CRUD_API_BASE}/print-plan?token=${data.confirm_token}` : null;
      sendPlanEmail(email, data.name, lang || "en", destLabel, printUrl).catch(err =>
        console.error("Plan email failed:", err.message)
      );
    }

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

// ─── ROSTER ───────────────────────────────────────────────────────────────────

const ROSTER_SCHEMA = {
  type: "object",
  properties: {
    pairings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          pairingDate:  { type: "string" },
          returnDate:   { type: "string" },
          pairingDays:  { type: "number" },
          departure:    { type: "string" },
          destinations: { type: "array", items: { type: "string" } },
          goingUsa:     { type: "string" },
          timezone:     { type: "number" },
        },
        required: ["pairingDate", "pairingDays", "departure", "destinations"],
        additionalProperties: false,
      },
    },
  },
  required: ["pairings"],
  additionalProperties: false,
};

// ─── ROSTER FORMAT KNOWLEDGE BASE ────────────────────────────────
// Descriptions of common airline scheduling systems and formats so the
// vision model can recognise which format it's looking at and extract
// pairings more accurately from each one.
const ROSTER_FORMAT_GUIDE = `
========================================================
ROSTER PAIRING EXTRACTION GUIDE
========================================================
Your PRIMARY job is to accurately read PAIRING DATA from the image.
Follow these steps in order.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — LOCATE THE DATE AXIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Most rosters are monthly grids. Find the row or column that contains
the numbers 1 through 28/29/30/31. This is the DATE AXIS.

• HORIZONTAL grid (most common): dates run LEFT→RIGHT across the top.
  Each vertical column = one calendar day.
  Example header: |  1 |  2 |  3 |  4 |  5 |  6 |  7 | ...

• VERTICAL/LIST format: dates run TOP→BOTTOM on the left side.
  Each horizontal row = one calendar day.

• WEEK-BASED format: shows 7-day rows with day abbreviations (MON TUE WED...).
  Count weeks to determine the actual calendar dates.

Also find the MONTH and YEAR — usually in a header above the grid
(e.g. "JUNE 2025", "JUN 25", "06/2025"). You need this to convert
day numbers into full YYYY-MM-DD dates.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2 — IDENTIFY PAIRING BLOCKS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Pairing blocks are the COLORED or SHADED rectangular cells that span
one or more days. They represent a work trip away from home base.

What a pairing block looks like:
• Colored background (blue, green, yellow, orange, teal, etc.)
• Contains: a pairing number (e.g. "PA 4521", "3421", "WS 201")
• Contains: airport IATA codes showing the route (e.g. "YYZ LHR", "YVR-LAS-YVR")
• Contains: departure/arrival times (e.g. "0645", "14:30", "2315")
• May span 1 day (outstation turn) or 2–5+ days (multi-day pairing)
• The block STARTS on the departure date and ENDS on the return date

What is NOT a pairing block (ignore these):
• White/empty cells = days off
• Cells with ONLY codes: DO, OFF, RD, D/O, FR = day off
• Cells with ONLY: SBY, STB, STBY, RSV, RES, HSBY = standby
• Cells with ONLY: AL, VAC, HOL, LV = leave/vacation
• Cells with ONLY: TRG, TRN, SIM, GRD, OE = training

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3 — EXTRACT DATES FROM EACH PAIRING BLOCK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For each pairing block:

1. Find which column(s)/row(s) it occupies on the date axis.
2. pairingDate = the FIRST date column the block occupies → YYYY-MM-DD
3. returnDate = the LAST date column the block occupies → YYYY-MM-DD
4. pairingDays = returnDate − pairingDate + 1  (minimum 1)

EXAMPLES:
  Block spans columns 5, 6, 7 in June 2025:
    pairingDate = 2025-06-05, returnDate = 2025-06-07, pairingDays = 3

  Block spans only column 12 in March 2026:
    pairingDate = 2026-03-12, returnDate = 2026-03-12, pairingDays = 1

  Block spans columns 28, 29, 30, 31, 1 (wraps into next month):
    If the last column is day 1 of NEXT month, use that month for returnDate.
    e.g. block starts June 28 ends July 1 → pairingDate=2025-06-28, returnDate=2025-07-01, pairingDays=4

IMPORTANT — count columns carefully:
  If the block visually spans from under day "15" to under day "18",
  that is 4 days: 15, 16, 17, 18. Do not guess — count each column.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 4 — EXTRACT ROUTE / DESTINATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Inside the pairing block, read any 3-letter IATA airport codes.
The home base is always the departure on day 1 (provided separately).
All other airports are destinations or layovers.

Route reading examples:
  "YYZ LHR YYZ" → destinations: ["London"]  (London Heathrow layover, return home)
  "YVR-LAX-JFK" → destinations: ["Los Angeles", "New York"]
  "YUL CDG NRT" → destinations: ["Paris", "Tokyo"]
  "YYC LAS" → destinations: ["Las Vegas"]

IATA → CITY NAME + TIMEZONE REFERENCE
(Use this table to convert codes to city names and estimate timezone offset)

CANADA:
YYZ = Toronto (+0 from home if home is Toronto, else EST UTC-5/EDT UTC-4)
YUL = Montreal (EST UTC-5 / EDT UTC-4)
YVR = Vancouver (PST UTC-8 / PDT UTC-7)
YYC = Calgary (MST UTC-7 / MDT UTC-6)
YEG = Edmonton (MST UTC-7 / MDT UTC-6)
YHZ = Halifax (AST UTC-4 / ADT UTC-3)
YOW = Ottawa (EST UTC-5 / EDT UTC-4)
YQB = Quebec City (EST UTC-5 / EDT UTC-4)
YTZ = Toronto Billy Bishop (EST UTC-5 / EDT UTC-4)
YWG = Winnipeg (CST UTC-6 / CDT UTC-5)
YXE = Saskatoon (CST UTC-6 / CDT UTC-5)
YQR = Regina (CST UTC-6 no DST)
YZF = Yellowknife (MST UTC-7 / MDT UTC-6)
YYT = St. John's (NST UTC-3:30 / NDT UTC-2:30)
YHM = Hamilton Ontario (EST UTC-5 / EDT UTC-4)
YKF = Waterloo (EST UTC-5 / EDT UTC-4)
YQG = Windsor (EST UTC-5 / EDT UTC-4)
YXU = London Ontario (EST UTC-5 / EDT UTC-4)
YYB = North Bay (EST UTC-5 / EDT UTC-4)
YSB = Sudbury (EST UTC-5 / EDT UTC-4)
YTS = Timmins (EST UTC-5 / EDT UTC-4)
YAM = Sault Ste. Marie (EST UTC-5 / EDT UTC-4)
YTR = Trenton (EST UTC-5 / EDT UTC-4)

USA — NORTHEAST:
JFK = New York JFK (EST UTC-5 / EDT UTC-4) — goingUsa=yes
EWR = Newark New Jersey (EST UTC-5 / EDT UTC-4) — goingUsa=yes
LGA = New York LaGuardia (EST UTC-5 / EDT UTC-4) — goingUsa=yes
BOS = Boston (EST UTC-5 / EDT UTC-4) — goingUsa=yes
PHL = Philadelphia (EST UTC-5 / EDT UTC-4) — goingUsa=yes
IAD = Washington Dulles (EST UTC-5 / EDT UTC-4) — goingUsa=yes
DCA = Washington Reagan (EST UTC-5 / EDT UTC-4) — goingUsa=yes
BWI = Baltimore (EST UTC-5 / EDT UTC-4) — goingUsa=yes
BDL = Hartford/Springfield (EST UTC-5 / EDT UTC-4) — goingUsa=yes
BTV = Burlington Vermont (EST UTC-5 / EDT UTC-4) — goingUsa=yes
PIT = Pittsburgh (EST UTC-5 / EDT UTC-4) — goingUsa=yes
BUF = Buffalo (EST UTC-5 / EDT UTC-4) — goingUsa=yes
SYR = Syracuse (EST UTC-5 / EDT UTC-4) — goingUsa=yes
ALB = Albany (EST UTC-5 / EDT UTC-4) — goingUsa=yes
PWM = Portland Maine (EST UTC-5 / EDT UTC-4) — goingUsa=yes
MHT = Manchester NH (EST UTC-5 / EDT UTC-4) — goingUsa=yes
PVD = Providence RI (EST UTC-5 / EDT UTC-4) — goingUsa=yes

USA — SOUTHEAST:
MIA = Miami (EST UTC-5 / EDT UTC-4) — goingUsa=yes
FLL = Fort Lauderdale (EST UTC-5 / EDT UTC-4) — goingUsa=yes
MCO = Orlando (EST UTC-5 / EDT UTC-4) — goingUsa=yes
TPA = Tampa (EST UTC-5 / EDT UTC-4) — goingUsa=yes
RSW = Fort Myers (EST UTC-5 / EDT UTC-4) — goingUsa=yes
PBI = West Palm Beach (EST UTC-5 / EDT UTC-4) — goingUsa=yes
SRQ = Sarasota (EST UTC-5 / EDT UTC-4) — goingUsa=yes
JAX = Jacksonville FL (EST UTC-5 / EDT UTC-4) — goingUsa=yes
SAV = Savannah (EST UTC-5 / EDT UTC-4) — goingUsa=yes
CLT = Charlotte NC (EST UTC-5 / EDT UTC-4) — goingUsa=yes
RDU = Raleigh-Durham (EST UTC-5 / EDT UTC-4) — goingUsa=yes
ORF = Norfolk VA (EST UTC-5 / EDT UTC-4) — goingUsa=yes
RIC = Richmond VA (EST UTC-5 / EDT UTC-4) — goingUsa=yes
MSY = New Orleans (CST UTC-6 / CDT UTC-5) — goingUsa=yes
BNA = Nashville (CST UTC-6 / CDT UTC-5) — goingUsa=yes
MEM = Memphis (CST UTC-6 / CDT UTC-5) — goingUsa=yes
BHM = Birmingham AL (CST UTC-6 / CDT UTC-5) — goingUsa=yes

USA — MIDWEST:
ORD = Chicago O'Hare (CST UTC-6 / CDT UTC-5) — goingUsa=yes
MDW = Chicago Midway (CST UTC-6 / CDT UTC-5) — goingUsa=yes
DTW = Detroit (EST UTC-5 / EDT UTC-4) — goingUsa=yes
MSP = Minneapolis (CST UTC-6 / CDT UTC-5) — goingUsa=yes
STL = St. Louis (CST UTC-6 / CDT UTC-5) — goingUsa=yes
MKE = Milwaukee (CST UTC-6 / CDT UTC-5) — goingUsa=yes
CLE = Cleveland (EST UTC-5 / EDT UTC-4) — goingUsa=yes
CMH = Columbus OH (EST UTC-5 / EDT UTC-4) — goingUsa=yes
CVG = Cincinnati (EST UTC-5 / EDT UTC-4) — goingUsa=yes
IND = Indianapolis (EST UTC-5 / EDT UTC-4) — goingUsa=yes
DSM = Des Moines (CST UTC-6 / CDT UTC-5) — goingUsa=yes
OMA = Omaha (CST UTC-6 / CDT UTC-5) — goingUsa=yes
MCI = Kansas City (CST UTC-6 / CDT UTC-5) — goingUsa=yes

USA — SOUTH/TEXAS:
ATL = Atlanta (EST UTC-5 / EDT UTC-4) — goingUsa=yes
DFW = Dallas Fort Worth (CST UTC-6 / CDT UTC-5) — goingUsa=yes
IAH = Houston Intercontinental (CST UTC-6 / CDT UTC-5) — goingUsa=yes
HOU = Houston Hobby (CST UTC-6 / CDT UTC-5) — goingUsa=yes
DAL = Dallas Love Field (CST UTC-6 / CDT UTC-5) — goingUsa=yes
AUS = Austin (CST UTC-6 / CDT UTC-5) — goingUsa=yes
SAT = San Antonio (CST UTC-6 / CDT UTC-5) — goingUsa=yes

USA — MOUNTAIN/WEST:
DEN = Denver (MST UTC-7 / MDT UTC-6) — goingUsa=yes
SLC = Salt Lake City (MST UTC-7 / MDT UTC-6) — goingUsa=yes
PHX = Phoenix (MST UTC-7, no DST) — goingUsa=yes
TUS = Tucson (MST UTC-7, no DST) — goingUsa=yes
ABQ = Albuquerque (MST UTC-7 / MDT UTC-6) — goingUsa=yes
LAS = Las Vegas (PST UTC-8 / PDT UTC-7) — goingUsa=yes
RNO = Reno (PST UTC-8 / PDT UTC-7) — goingUsa=yes

USA — PACIFIC COAST:
LAX = Los Angeles (PST UTC-8 / PDT UTC-7) — goingUsa=yes
SFO = San Francisco (PST UTC-8 / PDT UTC-7) — goingUsa=yes
SJC = San Jose CA (PST UTC-8 / PDT UTC-7) — goingUsa=yes
OAK = Oakland (PST UTC-8 / PDT UTC-7) — goingUsa=yes
SAN = San Diego (PST UTC-8 / PDT UTC-7) — goingUsa=yes
SEA = Seattle (PST UTC-8 / PDT UTC-7) — goingUsa=yes
PDX = Portland Oregon (PST UTC-8 / PDT UTC-7) — goingUsa=yes
BOI = Boise (MST UTC-7 / MDT UTC-6) — goingUsa=yes
SBA = Santa Barbara (PST UTC-8 / PDT UTC-7) — goingUsa=yes
SMF = Sacramento (PST UTC-8 / PDT UTC-7) — goingUsa=yes
BUR = Burbank (PST UTC-8 / PDT UTC-7) — goingUsa=yes

USA — ALASKA/HAWAII:
ANC = Anchorage Alaska (AKST UTC-9 / AKDT UTC-8) — goingUsa=yes
FAI = Fairbanks Alaska (AKST UTC-9 / AKDT UTC-8) — goingUsa=yes
HNL = Honolulu Hawaii (HST UTC-10, no DST) — goingUsa=yes
OGG = Maui Hawaii (HST UTC-10) — goingUsa=yes
KOA = Kona Hawaii (HST UTC-10) — goingUsa=yes
LIH = Kauai Hawaii (HST UTC-10) — goingUsa=yes

USA — OTHER:
MSO = Missoula MT — goingUsa=yes
GEG = Spokane — goingUsa=yes
GRR = Grand Rapids — goingUsa=yes
LNK = Lincoln NE — goingUsa=yes
CHS = Charleston SC — goingUsa=yes
GSP = Greenville SC — goingUsa=yes
GSO = Greensboro NC — goingUsa=yes
ROC = Rochester NY — goingUsa=yes
BUF = Buffalo NY — goingUsa=yes
ELP = El Paso — goingUsa=yes
TYS = Knoxville — goingUsa=yes
OKC = Oklahoma City — goingUsa=yes
TUL = Tulsa — goingUsa=yes
XNA = Fayetteville AR — goingUsa=yes
LIT = Little Rock — goingUsa=yes
GPT = Gulfport MS — goingUsa=yes
PNS = Pensacola FL — goingUsa=yes
VPS = Destin/Fort Walton FL — goingUsa=yes
GUM = Guam (ChST UTC+10) — goingUsa=yes

MEXICO:
CUN = Cancun (EST UTC-5 no DST)
MEX = Mexico City (CST UTC-6 / CDT UTC-5)
GDL = Guadalajara (CST UTC-6 / CDT UTC-5)
MTY = Monterrey (CST UTC-6 / CDT UTC-5)
PVR = Puerto Vallarta (CST UTC-6)
SJD = Los Cabos (MST UTC-7 no DST)
ZIH = Ixtapa/Zihuatanejo
HMO = Hermosillo
MID = Merida
OAX = Oaxaca

CARIBBEAN:
NAS = Nassau Bahamas
GGT = Georgetown Exuma
MBJ = Montego Bay Jamaica
KIN = Kingston Jamaica
POS = Port of Spain Trinidad
GND = Grenada
BGI = Bridgetown Barbados
ANU = Antigua
SXM = Sint Maarten
PTP = Pointe-à-Pitre Guadeloupe
FDF = Fort-de-France Martinique
SJU = San Juan Puerto Rico (AST UTC-4 no DST)
STT = St. Thomas USVI — goingUsa=yes
STX = St. Croix USVI — goingUsa=yes
HAV = Havana Cuba
VRA = Varadero Cuba
SCU = Santiago Cuba
HOG = Holguin Cuba

CENTRAL/SOUTH AMERICA:
BOG = Bogota Colombia (COT UTC-5)
MDE = Medellin Colombia
GRU = São Paulo Brazil (BRT UTC-3)
GIG = Rio de Janeiro (BRT UTC-3)
EZE = Buenos Aires (ART UTC-3)
SCL = Santiago Chile (CLT UTC-3 / CLST UTC-4)
LIM = Lima Peru (PET UTC-5)
UIO = Quito Ecuador (ECT UTC-5)
PTY = Panama City (EST UTC-5)
SJO = San Jose Costa Rica (CST UTC-6)
GUA = Guatemala City (CST UTC-6)

UNITED KINGDOM & IRELAND:
LHR = London Heathrow (GMT UTC+0 / BST UTC+1)
LGW = London Gatwick (GMT UTC+0 / BST UTC+1)
STN = London Stansted (GMT UTC+0 / BST UTC+1)
LTN = London Luton (GMT UTC+0 / BST UTC+1)
LCY = London City (GMT UTC+0 / BST UTC+1)
MAN = Manchester (GMT UTC+0 / BST UTC+1)
BHX = Birmingham UK (GMT UTC+0 / BST UTC+1)
EDI = Edinburgh (GMT UTC+0 / BST UTC+1)
GLA = Glasgow (GMT UTC+0 / BST UTC+1)
BRS = Bristol (GMT UTC+0 / BST UTC+1)
NCL = Newcastle (GMT UTC+0 / BST UTC+1)
DUB = Dublin (GMT UTC+0 / IST UTC+1)
SNN = Shannon Ireland (GMT UTC+0 / IST UTC+1)
BFS = Belfast (GMT UTC+0 / BST UTC+1)

WESTERN EUROPE:
CDG = Paris Charles de Gaulle (CET UTC+1 / CEST UTC+2)
ORY = Paris Orly (CET UTC+1 / CEST UTC+2)
FRA = Frankfurt (CET UTC+1 / CEST UTC+2)
MUC = Munich (CET UTC+1 / CEST UTC+2)
DUS = Düsseldorf (CET UTC+1 / CEST UTC+2)
HAM = Hamburg (CET UTC+1 / CEST UTC+2)
BER = Berlin Brandenburg (CET UTC+1 / CEST UTC+2)
STR = Stuttgart (CET UTC+1 / CEST UTC+2)
AMS = Amsterdam (CET UTC+1 / CEST UTC+2)
BRU = Brussels (CET UTC+1 / CEST UTC+2)
ZRH = Zurich (CET UTC+1 / CEST UTC+2)
GVA = Geneva (CET UTC+1 / CEST UTC+2)
VIE = Vienna (CET UTC+1 / CEST UTC+2)
MAD = Madrid (CET UTC+1 / CEST UTC+2)
BCN = Barcelona (CET UTC+1 / CEST UTC+2)
LIS = Lisbon (WET UTC+0 / WEST UTC+1)
OPO = Porto (WET UTC+0 / WEST UTC+1)
FCO = Rome Fiumicino (CET UTC+1 / CEST UTC+2)
MXP = Milan Malpensa (CET UTC+1 / CEST UTC+2)
BGY = Milan Bergamo (CET UTC+1 / CEST UTC+2)
VCE = Venice (CET UTC+1 / CEST UTC+2)
NAP = Naples (CET UTC+1 / CEST UTC+2)
ATH = Athens (EET UTC+2 / EEST UTC+3)
HER = Heraklion Crete (EET UTC+2 / EEST UTC+3)
SKG = Thessaloniki (EET UTC+2 / EEST UTC+3)
CPH = Copenhagen (CET UTC+1 / CEST UTC+2)
ARN = Stockholm Arlanda (CET UTC+1 / CEST UTC+2)
OSL = Oslo (CET UTC+1 / CEST UTC+2)
HEL = Helsinki (EET UTC+2 / EEST UTC+3)
KEF = Reykjavik Iceland (GMT UTC+0 no DST)
PRG = Prague (CET UTC+1 / CEST UTC+2)
WAW = Warsaw (CET UTC+1 / CEST UTC+2)
BUD = Budapest (CET UTC+1 / CEST UTC+2)
OTP = Bucharest (EET UTC+2 / EEST UTC+3)
SOF = Sofia (EET UTC+2 / EEST UTC+3)
ZAG = Zagreb (CET UTC+1 / CEST UTC+2)
DBV = Dubrovnik (CET UTC+1 / CEST UTC+2)
SPU = Split Croatia (CET UTC+1 / CEST UTC+2)
LJU = Ljubljana (CET UTC+1 / CEST UTC+2)
BEG = Belgrade (CET UTC+1 / CEST UTC+2)

CANARY ISLANDS / NORTH AFRICA:
ACE = Lanzarote (WET UTC+0 / WEST UTC+1)
TFS = Tenerife South (WET UTC+0 / WEST UTC+1)
TFN = Tenerife North (WET UTC+0 / WEST UTC+1)
LPA = Gran Canaria (WET UTC+0 / WEST UTC+1)
PMI = Palma de Mallorca (CET UTC+1 / CEST UTC+2)
IBZ = Ibiza (CET UTC+1 / CEST UTC+2)
CMN = Casablanca Morocco (WET UTC+0 / WEST UTC+1)
RAK = Marrakech (WET UTC+0)
TUN = Tunis (CET UTC+1)
ALG = Algiers (CET UTC+1)
CAI = Cairo (EET UTC+2)

MIDDLE EAST:
DXB = Dubai (GST UTC+4)
AUH = Abu Dhabi (GST UTC+4)
SHJ = Sharjah (GST UTC+4)
DOH = Doha Qatar (AST UTC+3)
KWI = Kuwait (AST UTC+3)
BAH = Bahrain (AST UTC+3)
RUH = Riyadh (AST UTC+3)
JED = Jeddah (AST UTC+3)
MCT = Muscat Oman (GST UTC+4)
AMM = Amman Jordan (EET UTC+2 / EEST UTC+3)
BEY = Beirut (EET UTC+2 / EEST UTC+3)
TLV = Tel Aviv (IST UTC+2 / IDT UTC+3)
BGW = Baghdad (AST UTC+3)
IKA = Tehran (IRST UTC+3:30 / IRDT UTC+4:30)

AFRICA:
NBO = Nairobi Kenya (EAT UTC+3)
ADD = Addis Ababa Ethiopia (EAT UTC+3)
JNB = Johannesburg (SAST UTC+2)
CPT = Cape Town (SAST UTC+2)
DUR = Durban (SAST UTC+2)
ACC = Accra Ghana (GMT UTC+0)
LOS = Lagos Nigeria (WAT UTC+1)
ABJ = Abidjan (GMT UTC+0)
DAK = Dakar Senegal (GMT UTC+0)
CMN = Casablanca (UTC+0/+1)

SOUTH ASIA:
DEL = Delhi (IST UTC+5:30)
BOM = Mumbai (IST UTC+5:30)
MAA = Chennai (IST UTC+5:30)
BLR = Bangalore (IST UTC+5:30)
HYD = Hyderabad (IST UTC+5:30)
CCU = Kolkata (IST UTC+5:30)
COK = Kochi (IST UTC+5:30)
CMB = Colombo Sri Lanka (IST UTC+5:30)
DAC = Dhaka Bangladesh (BST UTC+6)
KTM = Kathmandu (NPT UTC+5:45)
KHI = Karachi Pakistan (PKT UTC+5)
LHE = Lahore Pakistan (PKT UTC+5)
ISB = Islamabad (PKT UTC+5)

SOUTHEAST ASIA:
BKK = Bangkok (ICT UTC+7)
DMK = Bangkok Don Mueang (ICT UTC+7)
HKT = Phuket (ICT UTC+7)
CNX = Chiang Mai (ICT UTC+7)
SGN = Ho Chi Minh City (ICT UTC+7)
HAN = Hanoi (ICT UTC+7)
PNH = Phnom Penh (ICT UTC+7)
VTE = Vientiane (ICT UTC+7)
RGN = Yangon Myanmar (MMT UTC+6:30)
KUL = Kuala Lumpur (MYT UTC+8)
SIN = Singapore (SGT UTC+8)
DPS = Bali Denpasar (WITA UTC+8)
CGK = Jakarta (WIB UTC+7)
MNL = Manila (PHT UTC+8)
CEB = Cebu (PHT UTC+8)

EAST ASIA:
HKG = Hong Kong (HKT UTC+8)
PEK = Beijing Capital (CST UTC+8)
PKX = Beijing Daxing (CST UTC+8)
PVG = Shanghai Pudong (CST UTC+8)
SHA = Shanghai Hongqiao (CST UTC+8)
CAN = Guangzhou (CST UTC+8)
SZX = Shenzhen (CST UTC+8)
CTU = Chengdu (CST UTC+8)
XIY = Xi'an (CST UTC+8)
NKG = Nanjing (CST UTC+8)
HGH = Hangzhou (CST UTC+8)
WUH = Wuhan (CST UTC+8)
CKG = Chongqing (CST UTC+8)
KMG = Kunming (CST UTC+8)
TSN = Tianjin (CST UTC+8)
XMN = Xiamen (CST UTC+8)
TYO = Tokyo (general, use NRT or HND)
NRT = Tokyo Narita (JST UTC+9)
HND = Tokyo Haneda (JST UTC+9)
OSA = Osaka (general, use KIX or ITM)
KIX = Osaka Kansai (JST UTC+9)
ITM = Osaka Itami (JST UTC+9)
NGO = Nagoya (JST UTC+9)
SPK = Sapporo (general, use CTS)
CTS = Sapporo New Chitose (JST UTC+9)
FUK = Fukuoka (JST UTC+9)
OKA = Okinawa (JST UTC+9)
GMP = Seoul Gimpo (KST UTC+9)
ICN = Seoul Incheon (KST UTC+9)
PUS = Busan (KST UTC+9)
TPE = Taipei Taiwan (CST UTC+8)
KHH = Kaohsiung Taiwan (CST UTC+8)
MFM = Macau (CST UTC+8)

AUSTRALIA & PACIFIC:
SYD = Sydney (AEST UTC+10 / AEDT UTC+11)
MEL = Melbourne (AEST UTC+10 / AEDT UTC+11)
BNE = Brisbane (AEST UTC+10, no DST)
PER = Perth (AWST UTC+8, no DST)
ADL = Adelaide (ACST UTC+9:30 / ACDT UTC+10:30)
CNS = Cairns (AEST UTC+10, no DST)
OOL = Gold Coast (AEST UTC+10, no DST)
AKL = Auckland New Zealand (NZST UTC+12 / NZDT UTC+13)
CHC = Christchurch (NZST UTC+12 / NZDT UTC+13)
WLG = Wellington (NZST UTC+12 / NZDT UTC+13)
NAN = Nadi Fiji (FJT UTC+12)
PPT = Papeete Tahiti (TAHT UTC-10)
HNL = Honolulu — goingUsa=yes (listed above)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 5 — GOING USA RULE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Set goingUsa = "yes" if ANY airport in the pairing route is marked
"goingUsa=yes" in the table above (any US airport including territories
like Puerto Rico USVI Guam). Otherwise goingUsa = "no".

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 6 — TIMEZONE ESTIMATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Calculate timezone as the difference (in hours) between the crew
member's home base UTC offset and the MAIN destination UTC offset.
Positive = destination is ahead of home. Negative = destination behind.
Use 0 if you cannot determine the offset.

Example: Home base YYZ (UTC-5), destination LHR (UTC+0) → timezone = +5
Example: Home base YYZ (UTC-5), destination LAX (UTC-8) → timezone = -3

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AIRLINE SCHEDULING SYSTEMS (for format recognition only)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NETLINE/CREW: Air Canada, Swiss, Lufthansa, Brussels, SAS, TAP — horizontal monthly grid, colored blocks, dates 1–31 across top row, "PA####" pairing numbers.
WESTJET: "RD" for days off, route shown as "YYC-LAS-YYC" with dashes, WestJet/Swoop branding.
PORTER: PD prefix on pairings, YTZ and/or YYZ as base, E195-E2 jet, Florida/NE US routes.
DELTA: ATL/DTW hubs, DL flight numbers, blue color scheme, numeric pairing IDs.
UNITED: ORD/IAH/EWR hubs, UA flight numbers, FLICA-style layout.
AMERICAN: DFW/CLT/MIA hubs, AA flight numbers, Sabre-based view.
SOUTHWEST: No hub, point-to-point, WN flight numbers.
BA/IBERIA: LHR/LGW base, "DB"=day at base, "HSB"=home standby.
AIR FRANCE/KLM: CDG/AMS base, French labels, "CO"=day off, "ATTE"=standby.
EMIRATES/ETIHAD/QATAR: DXB/AUH/DOH base, AIMS layout, hotel city in block.
RYANAIR/EASYJET: European short-haul, "HOT"=hot standby, very compact grid.
LUFTHANSA GROUP (LH/LX/OS/SN): FRA/MUC/ZRH/VIE/BRU, "FR"=free day, "UU"=standby.

UNIVERSAL NON-PAIRING CODES (ignore, do not extract):
DO OFF RD D/O FR(LH) CO(AF) = Day off
SBY STB STBY HSB HSBY HOT ATTE RSV RES = Standby/Reserve
AL VAC HOL LV CONGE = Leave
TRG TRN SIM GRD GTC OE = Training
`;

// Parse roster image(s) with Haiku vision
app.post("/api/roster/parse", apiLimiter, async (req, res) => {
  try {
    const { images, homeBase, lang, email } = req.body;
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: "Missing images array" });
    }
    if (images.length > 4) return res.status(400).json({ error: "Max 4 images" });
    if (!email || !EMAIL_REGEX.test((email || "").toLowerCase().trim())) {
      return res.status(400).json({ error: "Missing or invalid 'email'" });
    }

    const usage = await checkPairingUsage(email.toLowerCase().trim(), "");
    if (!usage.isPremium) {
      return res.status(403).json({
        error: "premium_required",
        message: "Roster upload is a Premium feature. Upgrade to Premium to unlock this and more.",
      });
    }

    const imageContent = images.map(({ data, mediaType }) => ({
      type: "image",
      source: { type: "base64", media_type: mediaType || "image/jpeg", data },
    }));

    const today = new Date().toISOString().slice(0, 10);
    const prompt = `You are an expert at reading airline crew rosters and schedules. Today's date is ${today}. The crew member's home base is: ${homeBase || "unknown"}.

${ROSTER_FORMAT_GUIDE}

=== YOUR TASK ===
1. First identify which airline/scheduling system this roster belongs to using the knowledge base above.
2. Extract ALL future flight pairings (trips away from home base) visible in the roster.
3. SKIP days off, standby, training, vacation, and reserve entries — extract only actual flight pairings.

For each pairing, extract:
- pairingDate: departure date in YYYY-MM-DD format
- returnDate: return date in YYYY-MM-DD format (same as pairingDate if 1-day trip)
- pairingDays: total days away including departure and return day (minimum 1)
- departure: home base city name (e.g. "Toronto", "London", "Paris")
- destinations: array of layover/destination city names in order (e.g. ["New York", "London"])
- goingUsa: "yes" if ANY destination is a US airport/city, otherwise "no"
- timezone: estimated hours difference from home base to main destination (negative if behind, positive if ahead, 0 if unsure)

Only include pairings with dates on or after today (${today}). Ignore past pairings.
Return ONLY valid JSON with a "pairings" array. If you cannot read the roster clearly, return {"pairings":[]}.`;

    const message = await client.messages.create({
      model: FAST_MODEL,
      max_tokens: 2000,
      output_config: { format: { type: "json_schema", schema: ROSTER_SCHEMA } },
      messages: [{ role: "user", content: [...imageContent, { type: "text", text: prompt }] }],
    });

    const u = message.usage;
    if (u) console.log(`[roster-parse] in=${u.input_tokens} out=${u.output_tokens}`);

    const result = extractJSON(message);
    res.json(result);
  } catch (err) {
    handleAnthropicError(err, res);
  }
});

// Send kitchen confirmation reminder email (called from CRUD cron)
app.post("/api/roster/send-reminder", async (req, res) => {
  const key = req.headers["x-internal-key"];
  if (key !== INTERNAL_API_KEY) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { email, name, pairingDate, destinations, departure, pairingDays, confirmToken, lang } = req.body;
    if (!email || !confirmToken) return res.status(400).json({ error: "Missing required fields" });

    const dest = Array.isArray(destinations) ? destinations.join(" → ") : destinations;
    const date = pairingDate ? new Date(pairingDate).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) : "tomorrow";
    const crudBase = CRUD_API_BASE;

    // Email clients strip <form>/checkboxes, so the email links to the
    // kitchen-select web page, which supports picking more than one option.
    const kitchenSelectUrl = `${crudBase}/api/roster/kitchen-select?token=${confirmToken}`;

    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#07101E;font-family:system-ui,sans-serif;">
<div style="max-width:520px;margin:0 auto;padding:32px 16px;">
  <div style="background:#0F2040;border-radius:20px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#0A1628,#152850);padding:28px 32px;text-align:center;border-bottom:1px solid #1E3A6E;">
      <div style="font-size:36px;">✈️</div>
      <div style="color:#C9A84C;font-size:22px;font-weight:700;margin-top:8px;">NutriCrew</div>
      <div style="color:#7A8EAA;font-size:13px;margin-top:4px;">Your pairing starts tomorrow</div>
    </div>
    <div style="padding:32px;">
      <p style="color:#F8FAFF;font-size:17px;margin:0 0 8px;">Hey ${name?.split(" ")[0] || "there"} 👋</p>
      <p style="color:#7A8EAA;font-size:15px;margin:0 0 24px;">You're flying <strong style="color:#E8C96A;">${dest}</strong> on <strong style="color:#E8C96A;">${date}</strong>.</p>
      <p style="color:#F8FAFF;font-size:16px;font-weight:600;margin:0 0 16px;">What's your kitchen situation for this pairing?</p>
      <a href="${kitchenSelectUrl}" style="display:block;margin:10px 0;padding:16px 24px;background:#C9A84C;border-radius:12px;color:#07101E;text-decoration:none;font-size:16px;font-weight:700;text-align:center;">🍽️ Choose Your Kitchen Setup →</a>
      <p style="color:#7A8EAA;font-size:13px;margin:24px 0 0;text-align:center;">You can select more than one option — your personalised meal plan lands in your inbox within 30 seconds.</p>
    </div>
  </div>
</div></body></html>`;

    if (process.env.RESEND_API_KEY) {
      await resend.emails.send({
        from: FROM_EMAIL,
        to: [email],
        subject: `✈️ Your ${dest} pairing is tomorrow — what's your kitchen?`,
        html,
      });
    } else {
      console.log(`[DEV] Reminder email for ${email}: ${dest} on ${date}`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Reminder email error:", err.message);
    res.status(500).json({ error: "Failed to send reminder" });
  }
});

// Relay push subscription from frontend → CRUD backend (keeps internal key server-side)
app.post("/api/push/subscribe", apiLimiter, async (req, res) => {
  try {
    const { email, subscription } = req.body;
    if (!email || !subscription) return res.status(400).json({ error: "Missing fields" });
    const r = await crudInternal("/api/push/subscribe", { email, subscription });
    res.json(r);
  } catch (err) {
    console.error("push/subscribe relay error:", err.message);
    res.status(502).json({ error: "Failed to store push subscription" });
  }
});

// ─── GYM PLAN ─────────────────────────────────────────────────────────────────

// Exercises Haiku must choose from — each has a YouTube video ID for the thumbnail
const EXERCISE_LIBRARY = [
  { name: "Push-Up",               muscle: "Chest",       vid: "IODxDxX7oi4" },
  { name: "Diamond Push-Up",       muscle: "Triceps",     vid: "J0DXBSpghaI" },
  { name: "Pike Push-Up",          muscle: "Shoulders",   vid: "oMhDeQd7tYU" },
  { name: "Squat",                 muscle: "Legs",        vid: "ultWZbUMPL8" },
  { name: "Jump Squat",            muscle: "Legs",        vid: "CVaEhXotL7M" },
  { name: "Lunge",                 muscle: "Legs",        vid: "QOVaHwm-Q6U" },
  { name: "Reverse Lunge",         muscle: "Legs",        vid: "wrwwXE_x-pQ" },
  { name: "Glute Bridge",          muscle: "Glutes",      vid: "OUgsJ8-Vi0E" },
  { name: "Calf Raise",            muscle: "Calves",      vid: "gwLzBJYoWlA" },
  { name: "Wall Sit",              muscle: "Legs",        vid: "y-wV4Venusw"  },
  { name: "Plank",                 muscle: "Core",        vid: "pSHjTRaRanQ"  },
  { name: "Side Plank",            muscle: "Core",        vid: "K2VljzCC16g"  },
  { name: "Crunch",                muscle: "Core",        vid: "Xyd_fa5zoEU"  },
  { name: "Bicycle Crunch",        muscle: "Core",        vid: "9FGilxCbdz8"  },
  { name: "Leg Raise",             muscle: "Core",        vid: "JB2oyawG9KI"  },
  { name: "Russian Twist",         muscle: "Core",        vid: "wkD8rjkodUI"  },
  { name: "Superman",              muscle: "Back",        vid: "cc6UVNTKZAA"  },
  { name: "Mountain Climber",      muscle: "Cardio",      vid: "nmwgirgXLYM"  },
  { name: "Burpee",                muscle: "Cardio",      vid: "dZgVxmf6jkA"  },
  { name: "Jumping Jack",          muscle: "Cardio",      vid: "c4DAnQ6DtF8"  },
  { name: "High Knee",             muscle: "Cardio",      vid: "8opcQdC-V-U"  },
  { name: "Tricep Dip",            muscle: "Triceps",     vid: "0326dy_-CzM"  },
  { name: "Dumbbell Curl",         muscle: "Biceps",      vid: "ykJmrZ5v0Oo"  },
  { name: "Dumbbell Shoulder Press",muscle: "Shoulders",  vid: "qEwKCR5JCog"  },
  { name: "Dumbbell Row",          muscle: "Back",        vid: "pYcpY20QaE8"  },
  { name: "Dumbbell Squat",        muscle: "Legs",        vid: "Dy55_GsGGvU"  },
  { name: "Dumbbell Lunge",        muscle: "Legs",        vid: "L8fvypPrzzs"  },
  { name: "Hip Flexor Stretch",    muscle: "Flexibility", vid: "gX7I-j2JkCE"  },
  { name: "Hamstring Stretch",     muscle: "Flexibility", vid: "7kFJtCJMqRs"  },
  { name: "Child's Pose",          muscle: "Flexibility", vid: "qZ_KahQm4ac"  },
  { name: "Cat-Cow",               muscle: "Flexibility", vid: "kqnua4rHVVA"  },
  { name: "Downward Dog",          muscle: "Flexibility", vid: "j97SSGsnCAQ"  },
  { name: "Pigeon Pose",           muscle: "Flexibility", vid: "Qq4MJMoaEWM"  },
  { name: "Neck Roll",             muscle: "Flexibility", vid: "Zp-JfaLPMOk"  },
  { name: "Shoulder Roll",         muscle: "Flexibility", vid: "y7s3BfObUPM"  },
];

const EXERCISE_NAME_LIST = EXERCISE_LIBRARY.map(e => e.name).join(", ");

const GYM_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    weeks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          weekStart: { type: "string" },
          days: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                date: { type: "string" },
                type: { type: "string", enum: ["off", "pairing", "layover", "rest"] },
                workout: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: {
                    title: { type: "string" },
                    duration: { type: "string" },
                    exercises: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          name: { type: "string" },
                          sets: { type: "number" },
                          reps: { type: "string" },
                          notes: { type: "string" },
                        },
                        required: ["name", "sets", "reps", "notes"],
                      },
                    },
                  },
                  required: ["title", "duration", "exercises"],
                },
              },
              required: ["date", "type", "workout"],
            },
          },
        },
        required: ["weekStart", "days"],
      },
    },
  },
  required: ["weeks"],
};

app.post("/api/gym-plan/generate", apiLimiter, async (req, res) => {
  try {
    const { email, pairings, profile, lang } = req.body;
    if (!email || !Array.isArray(pairings) || pairings.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const usage = await checkPairingUsage(email.toLowerCase().trim(), profile?.name);
    if (!usage.isPremium) {
      return res.status(403).json({
        error: "premium_required",
        message: "Gym plans are a Premium feature. Upgrade to Premium to unlock this and more.",
      });
    }

    const goals = (profile?.goals || ["energy"]).join(", ");
    const pairingLines = pairings.map(p => {
      const start = p.pairingDate ? new Date(p.pairingDate).toISOString().split("T")[0] : "?";
      const end   = p.returnDate  ? new Date(p.returnDate).toISOString().split("T")[0]  : "?";
      return `  - ${start} to ${end}: ${p.departure} → ${(p.destinations||[]).join(" → ")} (${p.pairingDays || 1} days)`;
    }).join("\n");

    const prompt = `You are a fitness coach for flight crew. Create a monthly gym plan tailored to their roster.

Goals: ${goals}
Position: ${profile?.position || "cabin"}

Roster schedule:
${pairingLines}

Rules:
- "off" days (not in any pairing): 40-50 min full workout, 5-6 exercises
- "layover" days (hotel, mid-pairing): 20 min hotel circuit, 4-5 bodyweight exercises only
- "pairing" days (departure/arrival day of a trip): 15 min stretch/mobility only, 3-4 exercises from Flexibility
- "rest" days (day after long trip): rest — set workout to null

Use ONLY these exercise names (exact spelling): ${EXERCISE_NAME_LIST}

Cover the calendar from today through the last return date. Group into weeks starting Monday.
Return compact JSON, no commentary.`;

    const message = await client.messages.create({
      model: FAST_MODEL,
      max_tokens: 3000,
      output_config: { format: { type: "json_schema", schema: GYM_PLAN_SCHEMA } },
      messages: [{ role: "user", content: prompt }],
    });

    const u = message.usage;
    if (u) console.log(`[gym-plan] in=${u.input_tokens} out=${u.output_tokens}`);

    const plan = extractJSON(message);

    // Attach videoId + muscle to each exercise from the library
    const libMap = Object.fromEntries(EXERCISE_LIBRARY.map(e => [e.name, e]));
    for (const week of plan.weeks || []) {
      for (const day of week.days || []) {
        for (const ex of day.workout?.exercises || []) {
          const lib = libMap[ex.name];
          if (lib) { ex.vid = lib.vid; ex.muscle = lib.muscle; }
        }
      }
    }

    // Store in CRUD backend (fire-and-forget)
    const month = new Date(pairings[0].pairingDate).toISOString().slice(0, 7);
    crudInternal("/api/gym-plan/store", { email, month, plan }).catch(e => console.error("gym-plan store error:", e.message));

    res.json({ ok: true, plan });
  } catch (err) {
    handleAnthropicError(err, res);
  }
});

// Relay gym plan fetch from frontend
app.get("/api/gym-plan/get", apiLimiter, async (req, res) => {
  try {
    const { email, month } = req.query;
    if (!email || !month) return res.status(400).json({ error: "Missing email or month" });
    const r = await fetch(`${CRUD_API_BASE}/api/gym-plan/get?email=${encodeURIComponent(email)}&month=${month}`, {
      headers: { "x-internal-key": INTERNAL_API_KEY },
    });
    const d = await r.json();
    res.json(d);
  } catch (err) {
    console.error("gym-plan get relay error:", err.message);
    res.status(502).json({ error: "Failed to fetch gym plan" });
  }
});

// ─── JETLAG MEAL PLAN (premium) ────────────────────────────────────────────

const JETLAG_PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    schedule: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          actions: { type: "array", items: { type: "string" } },
        },
        required: ["label", "actions"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "schedule"],
  additionalProperties: false,
};

app.post("/api/jetlag-plan", apiLimiter, async (req, res) => {
  try {
    const { email, departure, destination, timezone, diets, lang } = req.body;
    if (!email || !EMAIL_REGEX.test((email || "").toLowerCase().trim())) {
      return res.status(400).json({ error: "Missing or invalid 'email'" });
    }
    if (!departure || !destination) return res.status(400).json({ error: "Missing departure or destination" });
    const tz = parseInt(timezone, 10) || 0;
    if (Math.abs(tz) < 4) return res.status(400).json({ error: "No significant jetlag for this timezone difference" });

    const usage = await checkPairingUsage(email.toLowerCase().trim(), "");
    if (!usage.isPremium) {
      return res.status(403).json({
        error: "premium_required",
        message: "The personalized jetlag meal plan is a Premium feature. Upgrade to Premium to unlock this and more.",
      });
    }

    const direction = tz > 0 ? "eastward (destination is ahead in time)" : "westward (destination is behind in time)";
    const dietLine = Array.isArray(diets) && diets.length ? diets.join(", ") : "no restrictions";
    const prompt = `Create a short, practical jetlag meal-timing plan for a flight crew member flying ${direction}, ${Math.abs(tz)} hours time difference, from ${departure} to ${destination}. Diet: ${dietLine}.

Cover: the travel day, plus the first 2 days at the destination. For each entry give a label (e.g. "Travel day", "Day 1 in ${destination}") and 2-4 short, concrete meal-timing actions stated in destination local time (specific times, what to eat or avoid, hydration, caffeine cutoff). Be specific to the direction and size of the time difference — no generic advice.

Respond in ${lang === "fr" ? "French" : lang === "es" ? "Spanish" : "English"}. Return compact JSON, no commentary.`;

    const result = await runStructured(prompt, JETLAG_PLAN_SCHEMA, 900, FAST_MODEL);
    res.json(result);
  } catch (err) {
    handleAnthropicError(err, res);
  }
});

// Relay roster store from frontend → CRUD backend (keeps internal key server-side)
app.post("/api/roster/store-pairings", apiLimiter, async (req, res) => {
  try {
    const { email, pairings, profile } = req.body;
    if (!email || !Array.isArray(pairings) || pairings.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const usage = await checkPairingUsage(email.toLowerCase().trim(), profile?.name);
    if (!usage.isPremium) {
      return res.status(403).json({
        error: "premium_required",
        message: "Roster automation is a Premium feature. Upgrade to Premium to unlock this and more.",
      });
    }

    const r = await crudInternal("/api/roster/store", { email, pairings, profile });
    res.json(r);
  } catch (err) {
    console.error("roster/store-pairings error:", err.message);
    res.status(502).json({ error: "Failed to store pairings" });
  }
});

// Relay: lets the app check for a roster-automation-generated plan without email.
app.get("/api/roster/latest-plan", apiLimiter, async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Missing email" });
    const r = await fetch(`${CRUD_API_BASE}/api/roster/latest-plan?email=${encodeURIComponent(email)}`, {
      headers: { "x-internal-key": INTERNAL_API_KEY },
    });
    const d = await r.json();
    res.json(d);
  } catch (err) {
    console.error("roster/latest-plan relay error:", err.message);
    res.status(502).json({ error: "Failed to fetch latest plan" });
  }
});

app.post("/api/roster/mark-plan-viewed", apiLimiter, async (req, res) => {
  try {
    const { confirmToken } = req.body;
    if (!confirmToken) return res.status(400).json({ error: "Missing confirmToken" });
    const r = await crudInternal("/api/roster/mark-plan-viewed", { confirmToken });
    res.json(r);
  } catch (err) {
    console.error("roster/mark-plan-viewed relay error:", err.message);
    res.status(502).json({ error: "Failed to mark plan viewed" });
  }
});

// ─── STRIPE ───────────────────────────────────────────────────────────────────

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { email, plan } = req.body;
    if (!email || !EMAIL_REGEX.test((email || "").toLowerCase().trim())) {
      return res.status(400).json({ error: "Missing or invalid email" });
    }
    if (!stripe) {
      return res.status(503).json({ error: "Payments not configured" });
    }
    const isAnnual = plan === "annual";
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer_email: email.toLowerCase().trim(),
      metadata: { email: email.toLowerCase().trim() },
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: isAnnual ? 6232 : 799, // annual is 35% off 12 months at $7.99
          recurring: { interval: isAnnual ? "year" : "month" },
          product_data: {
            name: isAnnual ? "NutriCrew Premium (Annual)" : "NutriCrew Premium (Monthly)",
            description: "Unlimited meal plans, gym plans, roster automation, calorie deficit, jetlag meal plans & nearby stores/restaurants.",
          },
        },
        quantity: 1,
      }],
      success_url: `${FRONTEND_URL}?premium=true`,
      cancel_url: FRONTEND_URL,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err.message);
    res.status(500).json({ error: "Could not create checkout session." });
  }
});

// ─── NEARBY PLACES (premium only) ────────────────────────────────────────────

async function fetchPlaces(query) {
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${process.env.GOOGLE_PLACES_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Places API error: ${res.status}`);
  const data = await res.json();
  return (data.results || []).slice(0, 3).map(p => ({
    name: p.name,
    address: p.formatted_address,
    rating: p.rating ?? null,
    open_now: p.opening_hours?.open_now ?? null,
  }));
}

app.post("/api/places", async (req, res) => {
  try {
    const { city, email } = req.body;
    if (!city || typeof city !== "string" || city.length > 100) {
      return res.status(400).json({ error: "Missing or invalid 'city'" });
    }
    if (!email || !EMAIL_REGEX.test((email || "").toLowerCase().trim())) {
      return res.status(400).json({ error: "Missing or invalid 'email'" });
    }
    if (!process.env.GOOGLE_PLACES_API_KEY) {
      return res.status(503).json({ error: "Places not configured" });
    }

    // Verify the user is premium before calling Places API.
    const usage = await checkPairingUsage(email.toLowerCase().trim(), "");
    if (!usage.isPremium) {
      return res.status(403).json({ error: "premium_required" });
    }

    // Same destination gets looked up by every crew member who flies it —
    // cache by city so repeat tab-opens (including re-opening the Nearby tab
    // in the same session) don't re-bill two Google Places calls each time.
    const cityKey = city.toLowerCase().trim();
    const cached = await crudInternal("/api/places-cache/query", { cityKey }).catch(() => ({ hit: false }));

    if (cached.hit) {
      return res.json({ groceries: cached.groceries, restaurants: cached.restaurants });
    }

    const [groceries, restaurants] = await Promise.all([
      fetchPlaces(`grocery store near ${city}`),
      fetchPlaces(`healthy restaurant near ${city}`),
    ]);

    crudInternal("/api/places-cache/store", { cityKey, groceries, restaurants }).catch(e =>
      console.error("places-cache/store failed:", e.message)
    );

    res.json({ groceries, restaurants });
  } catch (err) {
    console.error("Places error:", err.message);
    res.status(502).json({ error: "Could not fetch nearby places." });
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
