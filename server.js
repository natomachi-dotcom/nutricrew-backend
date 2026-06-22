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

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const email = session.customer_email || session.metadata?.email;
    if (email) {
      try {
        await fetch(`${CRUD_API_BASE}/api/set-premium`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
          body: JSON.stringify({ email }),
        });
      } catch (err) {
        console.error("Failed to set premium after payment:", err.message);
      }
    }
  }

  res.json({ received: true });
});

app.use(express.json());

const client = new Anthropic();
const FAST_MODEL = "claude-haiku-4-5-20251001";

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL || "NutriCrew <onboarding@resend.dev>";

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://nutricrew-frontend.vercel.app";

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

const MEAL_TYPE_COLORS = {
  Breakfast: "#4A9ECC",
  Lunch:     "#4CAF7D",
  Dinner:    "#C9A84C",
  Snack:     "#7A8EAA",
};

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

  const budgetAmount = parseFloat(data.budget_amount);
  const hasBudget = budgetAmount > 0;
  const perDayBudget = hasBudget
    ? (data.budget_type === "total" ? budgetAmount / pairingDays : budgetAmount)
    : null;
  const budgetLine = hasBudget
    ? `$${data.budget_amount} per ${data.budget_type === "total" ? `trip (~$${perDayBudget.toFixed(2)}/day across ${pairingDays} days)` : "day"}`
    : "open (no specific limit)";

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

  const profile = `CREW PROFILE:
- Name: ${data.name}, Position: ${data.position}, Gender: ${data.gender}${ageStr}
- Weight: ${data.weight}, Diet: ${dietLabel}${goalNote}
- Goals: ${goals.join(", ") || "none specified"}
- Budget: ${budgetLine}
- Route: ${data.departure} -> ${destinations.join(" -> ")}
- Going to USA: ${data.going_usa}
- Jet lag (timezone diff): ${data.timezone || 0} hours${jetlag ? " -- SIGNIFICANT JET LAG, adjust meal timing for circadian rhythm" : ""}
- Kitchen access: ${(data.kitchen || []).join(", ") || "full_kitchen"} (see KITCHEN ACCESS CONSTRAINTS below for what's actually possible)${lunchBag ? `\n- Lunch bag size: ${lunchBag}` : ""}${airplaneMealDesc ? `\n- Airplane meal (provided on board): ${airplaneMealDesc}` : ""}`;

  return { langName, dietLabel, rawDiets, jetlag, destinations, profile, hasBudget, perDayBudget, calorieTarget, calorieDeficitAmount, gainTarget, goals, kitchenAccessBlock, dietRules, lunchBag, airplaneMealDesc };
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

  return `You are a professional nutritionist specializing in aviation crew health.

${ctx.profile}

${ctx.kitchenAccessBlock}

${ctx.dietRules}

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
- Avoid low-calorie-density "diet" foods.` : ""}`;
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
- "summary": 2-sentence overview of the whole plan${ctx.calorieTarget ? `, noting that it targets a daily calorie deficit (~${ctx.calorieTarget} kcal/day) to support healthy, sustainable weight loss` : ctx.gainTarget ? `, noting that it targets a calorie surplus (~${ctx.gainTarget} kcal/day) to support healthy weight and muscle gain` : ""}.
- "groceryList": categorized shopping list (produce, protein, pantry, snacks, dairy) covering the whole pairing. IMPORTANT: every item in the grocery list must comply with the DIET RULES above — do not include any ingredient that violates the diet (e.g. no meat in a vegetarian list, no dairy in a vegan or dairy-free list, no gluten in a gluten-free list, no plant items in a carnivore list). Base items on the crew's kitchen access constraints (e.g. only ready-to-eat/no-prep items if no cooking equipment is available)${ctx.hasBudget ? ` and budget — keep total grocery costs realistically within $${(ctx.perDayBudget * pairingDays).toFixed(2)} (USD-equivalent) for the whole trip` : ""}.
- "foodRestrictions": "usa" (detailed list of what cannot be brought into the USA and why; if going_usa is "no", write "Not applicable — not traveling to the USA"), "destination" (food rules/restrictions for ${ctx.destinations.join(", ")}), "general" (general tips for a ${ctx.dietLabel} diet while traveling).`;
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
      return res.json({ alreadyVerified: true, token: storeData.token, email: storeData.email, name: storeData.name, isPremium: storeData.isPremium, pairingCount: storeData.pairingCount });
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

// Parse roster image(s) with Haiku vision
app.post("/api/roster/parse", apiLimiter, async (req, res) => {
  try {
    const { images, homeBase, lang } = req.body;
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: "Missing images array" });
    }
    if (images.length > 4) return res.status(400).json({ error: "Max 4 images" });

    const imageContent = images.map(({ data, mediaType }) => ({
      type: "image",
      source: { type: "base64", media_type: mediaType || "image/jpeg", data },
    }));

    const today = new Date().toISOString().slice(0, 10);
    const prompt = `You are analyzing a cabin crew roster/schedule. Today's date is ${today}. The crew member's home base is: ${homeBase || "unknown"}.

Extract ALL future pairings (trips) from this roster. For each pairing:
- pairingDate: departure date in YYYY-MM-DD format
- returnDate: return date in YYYY-MM-DD format
- pairingDays: number of days away (minimum 1)
- departure: home base city name (e.g. "Miami", "London", "Paris")
- destinations: array of layover/destination city names in order (e.g. ["New York", "London"])
- goingUsa: "yes" if ANY destination is in the USA, otherwise "no"
- timezone: estimated hours difference from home base to main destination (negative if behind, positive if ahead, 0 if unsure)

Only include pairings with dates on or after today (${today}). Ignore past dates.
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

    const kitchenOptions = [
      { key: "hotel",        emoji: "🏨", label: "Hotel / No Kitchen" },
      { key: "microwave",    emoji: "📦", label: "Microwave Only" },
      { key: "fridge",       emoji: "❄️",  label: "Fridge Available" },
      { key: "airplane_food",emoji: "✈️",  label: "Crew Meals on Board" },
    ];

    const btnHtml = kitchenOptions.map(({ key, emoji, label }) => `
      <a href="${crudBase}/api/roster/confirm-kitchen?token=${confirmToken}&kitchen=${key}"
         style="display:block;margin:10px 0;padding:16px 24px;background:#152850;border:2px solid #1E3A6E;border-radius:12px;color:#F8FAFF;text-decoration:none;font-size:16px;font-weight:600;text-align:center;">
        ${emoji} ${label}
      </a>`).join("");

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
      ${btnHtml}
      <p style="color:#7A8EAA;font-size:13px;margin:24px 0 0;text-align:center;">Tap once — your personalised meal plan lands in your inbox within 30 seconds.</p>
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
  properties: {
    weeks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          weekStart: { type: "string" },
          days: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: { type: "string" },
                type: { type: "string", enum: ["off", "pairing", "layover", "rest"] },
                workout: {
                  type: ["object", "null"],
                  properties: {
                    title: { type: "string" },
                    duration: { type: "string" },
                    exercises: {
                      type: "array",
                      items: {
                        type: "object",
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

// Relay roster store from frontend → CRUD backend (keeps internal key server-side)
app.post("/api/roster/store-pairings", apiLimiter, async (req, res) => {
  try {
    const { email, pairings, profile } = req.body;
    if (!email || !Array.isArray(pairings) || pairings.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const r = await crudInternal("/api/roster/store", { email, pairings, profile });
    res.json(r);
  } catch (err) {
    console.error("roster/store-pairings error:", err.message);
    res.status(502).json({ error: "Failed to store pairings" });
  }
});

// ─── STRIPE ───────────────────────────────────────────────────────────────────

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !EMAIL_REGEX.test((email || "").toLowerCase().trim())) {
      return res.status(400).json({ error: "Missing or invalid email" });
    }
    if (!stripe) {
      return res.status(503).json({ error: "Payments not configured" });
    }
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: email.toLowerCase().trim(),
      metadata: { email: email.toLowerCase().trim() },
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: 999,
          product_data: {
            name: "NutriCrew Premium",
            description: "Unlimited meal plans, calorie deficit plans & nearby stores/restaurants.",
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

    const [groceries, restaurants] = await Promise.all([
      fetchPlaces(`grocery store near ${city}`),
      fetchPlaces(`healthy restaurant near ${city}`),
    ]);

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
