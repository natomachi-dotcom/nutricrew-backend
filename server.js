import "dotenv/config";
import express from "express";
import compression from "compression";
import cors from "cors";
import helmet from "helmet";
import Anthropic from "@anthropic-ai/sdk";
import { Resend } from "resend";
import Stripe from "stripe";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __serverDir = dirname(fileURLToPath(import.meta.url));
let PLAN_BANK_MAP = {};
try {
  const raw = JSON.parse(readFileSync(join(__serverDir, "plans-bank.json"), "utf8"));
  PLAN_BANK_MAP = raw.plans || {};
  const count = Object.values(PLAN_BANK_MAP).reduce((s, a) => s + a.length, 0);
  console.log(`[bank] Loaded ${count} pre-generated plan entries`);
} catch {
  console.log("[bank] plans-bank.json not found — bank disabled, all plans go to AI");
}

const app = express();
app.use(compression());
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

  // A subscription counts as premium during its trial and during Stripe's
  // dunning retry window after a failed renewal charge ("past_due") — access
  // is only actually revoked on customer.subscription.deleted, once Stripe
  // gives up retrying. This avoids locking someone out on the first missed
  // payment; see invoice.payment_failed below.
  const PREMIUM_STATUSES = ["active", "trialing", "past_due"];

  try {
    // All handlers below only ever $set fields (never increment/append), so
    // Stripe redelivering the same event is naturally idempotent — no extra
    // dedup bookkeeping needed.
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const email = session.customer_email || session.metadata?.email;
      console.log(`[webhook] checkout.session.completed id=${event.id} email=${email} customer=${session.customer}`);
      if (email) {
        let trialEnd = null;
        if (session.subscription) {
          try {
            const subscription = await stripe.subscriptions.retrieve(session.subscription);
            trialEnd = subscription.trial_end || null;
          } catch (e) {
            console.error(`[webhook] could not retrieve subscription ${session.subscription}:`, e.message);
          }
        }
        const r = await fetch(`${CRUD_API_BASE}/api/set-premium`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
          body: JSON.stringify({
            email,
            stripeCustomerId: session.customer || null,
            stripeSubscriptionId: session.subscription || null,
            trialEnd,
          }),
        });
        if (!r.ok) {
          const body = await r.text().catch(() => "");
          console.error(`[webhook] set-premium failed: ${r.status} ${body}`);
          return res.status(500).json({ error: "Failed to update user premium status" });
        }
        console.log(`[webhook] set-premium ok for ${email} trialEnd=${trialEnd}`);
      }
    } else if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      console.log(`[webhook] subscription.deleted customer=${subscription.customer}`);
      const r = await fetch(`${CRUD_API_BASE}/api/set-premium-by-customer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
        body: JSON.stringify({ stripeCustomerId: subscription.customer, isPremium: false, trialEnd: null }),
      });
      if (!r.ok) {
        console.error(`[webhook] set-premium-by-customer failed: ${r.status}`);
        return res.status(500).json({ error: "Failed to revoke user premium status" });
      }
    } else if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object;
      const isPremium = PREMIUM_STATUSES.includes(subscription.status);
      console.log(`[webhook] subscription.updated customer=${subscription.customer} status=${subscription.status} isPremium=${isPremium} trialEnd=${subscription.trial_end}`);
      const r = await fetch(`${CRUD_API_BASE}/api/set-premium-by-customer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
        body: JSON.stringify({ stripeCustomerId: subscription.customer, isPremium, trialEnd: subscription.trial_end || null }),
      });
      if (!r.ok) {
        console.error(`[webhook] set-premium-by-customer failed: ${r.status}`);
        return res.status(500).json({ error: "Failed to update user premium status" });
      }
    } else if (event.type === "invoice.paid") {
      const invoice = event.data.object;
      console.log(`[webhook] invoice.paid customer=${invoice.customer} subscription=${invoice.subscription} amount=${invoice.amount_paid}`);
      // Confirms the trial converted (or a renewal succeeded) — the subscription's
      // own status ("active") is the source of truth for isPremium, already kept
      // in sync by customer.subscription.updated. Nothing further to do here
      // beyond logging for observability.
    } else if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      console.log(`[webhook] invoice.payment_failed customer=${invoice.customer} subscription=${invoice.subscription} attempt=${invoice.attempt_count}`);
      // Don't revoke access here — Stripe moves the subscription to "past_due"
      // and retries per its dunning schedule; customer.subscription.updated
      // already keeps isPremium=true through that window (see PREMIUM_STATUSES
      // above). Access is only actually revoked once Stripe gives up and fires
      // customer.subscription.deleted.
    }
  } catch (err) {
    console.error("Stripe webhook handling failed:", err.message);
    return res.status(500).json({ error: "Webhook handling failed" });
  }

  res.json({ received: true });
});

// Lightweight keep-warm endpoint — UptimeRobot / cron-job.org should ping
// this every 5 min to prevent Render free-tier cold starts.
app.get("/health", (_req, res) => res.json({ ok: true }));

app.use(express.json());

const client = new Anthropic();
const FAST_MODEL = "claude-haiku-4-5-20251001";

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL || "NutriCrew <crewmealplans@nutricrew.ca>";

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://nutricrew.ca";
// Free trial length before the first real charge — change this one constant to adjust it.
const TRIAL_DAYS = 30;

const CRUD_API_BASE = process.env.CRUD_API_BASE;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

// Looks up whether this email already has a Stripe customer on file — used to
// decide trial eligibility (see /api/create-checkout-session) so the same
// account can't restart the free trial by re-checking out.
async function getExistingStripeCustomerId(email) {
  const r = await fetch(`${CRUD_API_BASE}/api/user/stripe-customer?email=${encodeURIComponent(email)}`, {
    headers: { "x-internal-key": INTERNAL_API_KEY },
  });
  if (!r.ok) return null;
  const data = await r.json().catch(() => ({}));
  return data.stripeCustomerId || null;
}

// Mirrors the frontend's 1-5 day picker — caps the number of parallel
// per-day Haiku calls a single request can trigger.
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
    ingredients: {
      type: "array",
      items: { type: "string" },
      description: "Each distinct ingredient by short name (e.g. \"eggs\", \"spinach\", \"feta cheese\") — specific enough for a crew member to spot a personal allergen, not full recipe steps.",
    },
    tip: { type: "string" },
    recyclingTip: { type: "string" },
    emoji: { type: "string" },
    container: { type: "string", description: "Recommended Tupperware/container size and shape for packing this meal, e.g. '500ml rectangular container' or '300ml round container with dividers'. Only include if a lunch bag size was provided." },
  },
  required: ["type", "name", "description", "prep", "calories", "protein", "carbs", "fat", "tip", "emoji", "ingredients"],
  additionalProperties: false,
};

const DAY_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string" },
    jetlagNote: { type: ["string", "null"] },
    hydrationNote: { type: ["string", "null"] },
    meals: { type: "array", items: MEAL_SCHEMA },
  },
  required: ["label", "jetlagNote", "hydrationNote", "meals"],
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
  if (err.status === 504 || err.name === 'AbortError') {
    return res.status(504).json({ error: "Request timed out. Please try again." });
  }
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (err instanceof Anthropic.APIError) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  res.status(500).json({ error: 'Internal server error' });
}

// Checks the free-tier pairing limit against the user's record in the CRUD backend.
// Read-only — does not consume a pairing. Used by premium-gated features
// (roster, gym plans, jetlag plans) that only care about usage.isPremium.
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

// Atomically checks-and-consumes a free pairing slot in one DB operation —
// unlike checkPairingUsage, this actually decides the request's fate, so it
// must be called once, up front, by anything that's about to generate a
// plan. If generation fails afterward, call releasePairingUsage to give a
// non-premium user's slot back.
async function reservePairingUsage(email, name, clientIP) {
  const res = await fetch(`${CRUD_API_BASE}/api/pairing-usage/reserve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
    body: JSON.stringify({ email, name, clientIP }),
  });
  if (!res.ok) {
    throw Object.assign(new Error("Failed to reserve pairing usage"), { status: 502 });
  }
  return res.json();
}

async function releasePairingUsage(email) {
  const res = await fetch(`${CRUD_API_BASE}/api/pairing-usage/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    throw Object.assign(new Error("Failed to release pairing usage"), { status: 502 });
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
  let timeoutId;
  const timeoutPromise = new Promise((_, rej) => {
    timeoutId = setTimeout(
      () => rej(Object.assign(new Error("AI request timed out"), { status: 504 })),
      45000
    );
  });
  let message;
  try {
    message = await Promise.race([stream.finalMessage(), timeoutPromise]);
  } catch (e) {
    try { stream.controller?.abort(); } catch {}
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
  if (message.stop_reason === "refusal") {
    throw Object.assign(new Error("The model declined to generate this content."), { status: 502 });
  }
  const u = message.usage;
  if (u) console.log(`[tokens] in=${u.input_tokens} out=${u.output_tokens} max=${maxTokens} model=${model.split("-")[1]}`);
  return extractJSON(message);
}

// If the model returns meals whose calorie sum is outside target ± tolerance,
// proportionally rescale calories and macros on every meal so the total lands on
// target. This is a deterministic safety net — it never calls the model again.
function rescaleMealsToTarget(meals, target, toleranceFraction = 0.15) {
  const actual = meals.reduce((s, m) => s + (m.calories || 0), 0);
  if (!actual || !target) return { meals, totalCalories: actual };
  const ratio = target / actual;
  if (Math.abs(ratio - 1) <= toleranceFraction) return { meals, totalCalories: actual };
  const rescaled = meals.map(m => ({
    ...m,
    calories: Math.round((m.calories || 0) * ratio),
    protein: Math.round((m.protein || 0) * ratio),
    carbs: Math.round((m.carbs || 0) * ratio),
    fat: Math.round((m.fat || 0) * ratio),
  }));
  const newTotal = rescaled.reduce((s, m) => s + m.calories, 0);
  console.log(`[calorie-guard] meals rescaled: actual=${actual} target=${target} ratio=${ratio.toFixed(3)} → ${newTotal} kcal`);
  return { meals: rescaled, totalCalories: newTotal };
}

// ── ALLERGEN GUARD ──────────────────────────────────────────────────────
// The model doesn't 100% reliably follow allergy instructions in the prompt
// alone (observed live: nut-free plans still including peanut butter or
// unlabeled granola). For genuine allergies/intolerances — as opposed to
// broader lifestyle diets — a deterministic keyword check + one corrective
// regeneration pass is a real guarantee, not just a request to the model.
// Scoped to the 7 binary, well-defined allergens; FODMAP is excluded (a fuzzy
// elimination diet with many portion-dependent exceptions, not a fixed
// banned-ingredient list, and not typically life-threatening like the others).
const ALLERGEN_RULES = {
  nut_free: {
    banned: /\b(peanuts?|peanut butter|almonds?|walnuts?|cashews?|pistachios?|pecans?|hazelnuts?|macadamia|brazil nuts?|pine nuts?|nutella|marzipan|praline|granola|trail mix|pesto)\b/i,
    qualifier: /nut-free|nut free/i,
  },
  shellfish_free: {
    banned: /\b(shrimps?|prawns?|crabs?|lobsters?|crayfish|clams?|mussels?|oysters?|scallops?|squid|octopus|calamari|shellfish|oyster sauce|fish sauce|shrimp paste|surimi)\b/i,
    qualifier: null, // no safe "shellfish-free oyster sauce" phrasing exists — always a hard ban
  },
  egg_free: {
    banned: /\b(eggs?|mayonnaise|mayo|hollandaise|b[ée]arnaise|meringue|frittata|quiche|french toast)\b/i,
    qualifier: /egg-free|egg free/i,
  },
  soy_free: {
    banned: /\b(soy sauce|soybeans?|edamame|tofu|tempeh|soy milk|miso|soy lecithin)\b/i,
    qualifier: /soy-free|soy free|coconut aminos|tamari/i,
  },
  gluten_free: {
    banned: /\b(wheat|barley|rye|spelt|regular oats|regular (bread|pasta)|flour tortillas?|soy sauce)\b/i,
    qualifier: /gluten-free|gluten free/i,
  },
  dairy_free: {
    banned: /\b(milk|cheese|butter|cream|yogurt|whey)\b/i,
    qualifier: /dairy-free|dairy free|coconut|oat milk|almond milk|plant-based|vegan/i,
  },
  lactose_free: {
    banned: /\b(milk|cream|yogurt)\b/i,
    qualifier: /lactose-free|lactose free|hard cheese|parmesan|cheddar|aged cheese/i,
  },
  sesame_free: {
    banned: /\b(sesame|tahini|halva|za'?\s?atar|benne|gomashio|hummus|baba ganoush)\b/i,
    qualifier: /sesame-free|sesame free|tahini-free|tahini free/i,
  },
};

// Kosher's core rule isn't "banned ingredient present" like an allergy — it's
// "meat and dairy never in the SAME meal". A simple presence-based keyword
// scan can't express that, so this is a separate compositional check.
const KOSHER_MEAT_WORDS = /\b(beef|chicken|turkey|lamb|veal|duck|goose|sausage|bacon|ham|pastrami|salami|jerky|meat|poultry)\b/i;
const KOSHER_DAIRY_WORDS = /\b(cheese|milk|cream|butter|yogurt|yoghurt|whey|ghee)\b/i;

// Scans one meal's text for banned terms belonging to the crew member's
// active allergen/intolerance selections. A banned term is only a violation
// if the diet has no qualifier pattern, or the qualifier phrase isn't also
// present somewhere in the same meal (e.g. "gluten-free tamari" is fine).
function findMealAllergenViolations(meal, activeDiets) {
  const text = [meal.name, meal.description, meal.tip, ...(meal.tags || [])].filter(Boolean).join(" ");
  const violations = [];
  for (const diet of activeDiets) {
    const rule = ALLERGEN_RULES[diet];
    if (!rule) continue;
    const match = text.match(rule.banned);
    if (!match) continue;
    if (rule.qualifier && rule.qualifier.test(text)) continue;
    violations.push({ diet, term: match[0] });
  }
  if (activeDiets.includes("kosher") && KOSHER_MEAT_WORDS.test(text) && KOSHER_DAIRY_WORDS.test(text)) {
    violations.push({ diet: "kosher", term: "meat and dairy combined in one meal" });
  }
  return violations;
}

// Asks the model to replace ONE meal that failed the allergen guard, naming
// the exact banned term(s) found so the correction is targeted rather than a
// generic "try again". Falls back to the original meal if this also fails.
async function regenerateCompliantMeal(meal, violations, dietRules, kitchenAccessBlock) {
  const prompt = `Revise this ONE meal — it violates a dietary restriction and must be replaced.

ORIGINAL MEAL: ${JSON.stringify({ name: meal.name, description: meal.description })}
VIOLATION: contains "${violations.map(v => v.term).join('", "')}", which is not allowed under this rule:

${dietRules}

${kitchenAccessBlock}

Generate a REPLACEMENT ${meal.type} meal that fully complies with the rule above and the kitchen access constraints, keeping calories close to ${meal.calories} kcal. Include an "ingredients" array listing each distinct ingredient by short name. Return ONLY the meal JSON — no violating ingredient anywhere in the name, description, tip, or ingredients.`;
  try {
    const replacement = await runStructured(prompt, MEAL_SCHEMA, 700, FAST_MODEL);
    return { ...replacement, type: meal.type };
  } catch (e) {
    console.error(`[allergen-guard] regeneration failed for "${meal.name}": ${e.message}`);
    return meal;
  }
}

// Deterministic post-generation safety net: checks every meal in every day
// against the crew member's allergen selections and regenerates (once) any
// meal that violates one. Runs on bank hits and cache hits too, since those
// may have been produced before this guard existed.
async function applyAllergenGuard(days, data, ctx) {
  const rawDiets = Array.isArray(data.diets) ? data.diets : (data.diet ? [data.diet] : []);
  const activeDiets = rawDiets.filter(d => ALLERGEN_RULES[d] || d === "kosher");
  if (activeDiets.length === 0) return days;

  let violationCount = 0;
  const guardedDays = await Promise.all(days.map(async (day) => {
    if (!day?.meals) return day;
    const meals = await Promise.all(day.meals.map(async (meal) => {
      const violations = findMealAllergenViolations(meal, activeDiets);
      if (violations.length === 0) return meal;
      violationCount++;
      console.warn(`[allergen-guard] "${meal.name}" violates ${violations.map(v => `${v.diet}("${v.term}")`).join(", ")} — regenerating`);
      const replacement = await regenerateCompliantMeal(meal, violations, ctx.dietRules, ctx.kitchenAccessBlock);
      const stillViolating = findMealAllergenViolations(replacement, activeDiets);
      if (stillViolating.length > 0) {
        console.error(`[allergen-guard] "${replacement.name}" STILL violates ${stillViolating.map(v => v.diet).join(", ")} after regeneration — serving anyway, flag for review`);
      }
      return replacement;
    }));
    return { ...day, meals };
  }));

  if (violationCount > 0) console.log(`[allergen-guard] corrected ${violationCount} meal(s) across ${days.length} day(s)`);
  return guardedDays;
}

// Mifflin-St Jeor TDEE estimate for calorie deficit target.
// Uses actual age if provided, defaults to 35. Height defaults to 170 cm.
function estimateTDEE(data) {
  const weightStr = String(data.weight || "");
  const weightVal = parseFloat(weightStr);
  if (!weightVal) return null;
  const weightKg = /lb/i.test(weightStr) ? weightVal / 2.20462 : weightVal;
  let age = parseInt(data.age, 10);
  if (!age && data.dob) age = Math.floor((Date.now() - new Date(data.dob)) / (365.25 * 24 * 60 * 60 * 1000));
  if (!age || age < 16 || age > 80) age = 35;
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
  const normalized = Array.isArray(kitchen) ? kitchen : (kitchen ? [kitchen] : []);
  const list = normalized.length ? normalized : ["full_kitchen"];
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
      return `DIET: GLUTEN-FREE / WHEAT ALLERGY (celiac-level, zero tolerance — wheat is one of the most common adult anaphylaxis triggers, not just a celiac concern):
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
      return `DIET: DAIRY-FREE / MILK ALLERGY — STRICT RULES (milk is one of the most common food-allergy anaphylaxis triggers — treat as zero tolerance, not just a preference):
- NO dairy: no milk, cheese, butter, cream, yogurt, whey, casein, ghee, or lactose. This includes sheep, goat, and other animal milks, not just cow's milk — cross-reactivity between mammalian milks is common.
- Watch for hidden dairy: use dairy-free dark chocolate, coconut/oat cream for sauces.
- Name the dairy-free alternative explicitly (e.g. "oat milk latte" not "latte", "coconut yogurt" not "yogurt").
- Grocery "dairy" list: dairy-free alternatives only — no actual dairy.`;
    case "lactose_free":
      return `DIET: LACTOSE-FREE — STRICT RULES:
- NO regular milk, soft cheese, cream, or regular yogurt (lactose intolerance, not a dairy allergy).
- YES: lactose-free milk/yogurt, hard aged cheeses (cheddar, parmesan — naturally very low lactose), butter (trace lactose, generally tolerated), plant-based alternatives.
- Name the lactose-free alternative explicitly where used (e.g. "lactose-free milk" not "milk").
- Add a tip if a meal contains a low-but-nonzero-lactose item (hard cheese, butter) so the crew member can judge their own tolerance.`;
    case "nut_free":
      return `DIET: NUT ALLERGY — STRICT RULES (life-threatening allergy, zero tolerance):
- NO tree nuts (almonds, walnuts, cashews, pistachios, pecans, hazelnuts, macadamias, brazil nuts, pine nuts) or peanuts, in any form: whole, chopped, butters/spreads, milks, oils, flours, or as a garnish.
- Watch for hidden nuts: granola, trail mix, pesto, some baked goods, Asian/Thai sauces (satay, some curries), marzipan, praline, nut-based crackers or energy bars.
- NO substituting almond/cashew/peanut milk, flour, or butter for anything — use oat, soy (unless also soy-free), or dairy alternatives instead.
- Add a cross-contamination warning in the "tip" for any packaged, restaurant, or airplane-catered item ("ask about nut cross-contact").`;
    case "egg_free":
      return `DIET: EGG-FREE — STRICT RULES:
- NO eggs in any form: whole eggs, egg whites, mayonnaise, most baked goods leavened/bound with egg, some pastas, meringue, hollandaise/béarnaise sauce.
- Watch for hidden egg: quiche, frittata, French toast, breaded/battered items, some processed meats (as binder), egg-wash glazed bread.
- Protein must come from non-egg sources instead: meat, fish, dairy, legumes, tofu, nuts/seeds (unless also nut-free).
- Name the egg-free alternative explicitly (e.g. "egg-free mayo" not "mayo").`;
    case "shellfish_free":
      return `DIET: SHELLFISH ALLERGY — STRICT RULES (can be life-threatening, zero tolerance):
- NO crustaceans (shrimp, crab, lobster, crayfish) or mollusks (clams, mussels, oysters, scallops, squid, octopus), in any form: whole, in stocks/broths/sauces (e.g. oyster sauce, fish sauce often contains shellfish, shrimp paste), or as flavoring.
- Fin fish (salmon, tuna, cod, tilapia, etc.) is generally fine unless the user also excluded fish elsewhere — shellfish and fish are different allergens.
- Watch for hidden shellfish: some Asian sauces/pastes, paella, bouillabaisse, surimi/imitation crab (still shellfish-derived).
- Add a cross-contamination warning in the "tip" for any seafood restaurant or airplane-catered item.`;
    case "soy_free":
      return `DIET: SOY ALLERGY — STRICT RULES (soy is one of the most common adult anaphylaxis triggers — zero tolerance):
- NO soy in any form: soybeans, edamame, tofu, tempeh, soy sauce, soy milk, soy lecithin (common in chocolate/processed foods), soybean oil, miso.
- Use coconut aminos or gluten-free tamari alternatives only if also verified soy-free; otherwise use plain sea salt for seasoning instead of soy sauce.
- Watch for hidden soy: many processed/packaged foods, protein bars, some broths and marinades.
- Protein must come from non-soy sources: meat, fish, eggs, dairy, legumes (other than soy), nuts/seeds (unless also nut-free).`;
    case "sesame_free":
      return `DIET: SESAME ALLERGY — STRICT RULES (sesame is a top-9 major food allergen, can be life-threatening, zero tolerance):
- NO sesame in any form: seeds (whole or hulled), sesame oil, tahini, sesame paste, sesame flour, benne, gomashio.
- Watch for hidden sesame: hummus and baba ganoush traditionally contain tahini (must be made/labeled sesame-free), halva, za'atar, some breads/bagels/buns/crackers with visible or baked-in seeds, many Middle Eastern and some Asian sauces/dressings, sesame-oil finishing drizzles.
- Name the sesame-free alternative explicitly where a normally-sesame dish is used (e.g. "sesame-free hummus" not "hummus", "tahini-free dressing").
- Add a cross-contamination warning in the "tip" for any packaged, restaurant, or airplane-catered item.`;
    case "fodmap":
      return `DIET: LOW-FODMAP — STRICT RULES:
- NO high-FODMAP foods: onion, garlic, wheat, most legumes/beans, apples, pears, mango, watermelon, honey, high-fructose corn syrup, milk/soft cheese, cashews, pistachios.
- YES: most meat/fish/eggs, rice, quinoa, oats, potatoes, most hard cheeses, lactose-free dairy, firm tofu, low-FODMAP veg (carrots, zucchini, spinach, bell peppers, tomatoes) and fruit (banana, grapes, oranges, strawberries, blueberries).
- Use garlic-infused oil (not garlic itself) and the green tops of scallions (not onion) for allium flavor.
- Note this is typically a temporary elimination-phase diet — add a tip suggesting the crew member confirm current tolerance for any borderline item.`;
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

function getCognitivePerfRules(data) {
  const reportTime = (data.report_time || "").trim();
  const dutyHours = parseInt(data.duty_hours, 10) || 0;
  const layoverType = (data.layover_type || "").trim();
  const flightDir = (data.flight_direction || "").trim();

  if (!reportTime && !dutyHours && !layoverType && !flightDir) return null;

  const rules = [];

  if (reportTime) {
    const [rHour = 8] = reportTime.split(":").map(Number);
    if (rHour >= 3 && rHour < 6) {
      rules.push(`EARLY WAKE REPORT (${reportTime} — Window of Circadian Low): Highest fatigue risk. Pre-duty meal must be HIGH-PROTEIN (eggs, Greek yogurt, lean meat) — protein supports alertness. Avoid heavy carbs before duty. First in-flight snack within 90 minutes of report: complex carbs + protein (oat bar, nut butter). Strategic caffeine: one serving at report time, then taper after hour 4 of duty.`);
    } else if (rHour >= 22 || rHour < 3) {
      rules.push(`NIGHT SHIFT REPORT (${reportTime}): Duty crosses the WOCL (02:00–06:00). Pre-duty meal must be LIGHT — avoid large meals, as GI function slows at night. Plan portable snacks every 2–3 hours during duty. Avoid heavy high-fat meals between 02:00–06:00 as they worsen fatigue.`);
    } else if (rHour >= 14 && rHour < 17) {
      rules.push(`POST-LUNCH DIP REPORT (${reportTime}): Circadian post-lunch dip window. Avoid heavy carbohydrate lunch before duty — risk of drowsiness. Prefer a light protein-rich pre-duty meal. Keep a caffeine option available for hour 1 of duty.`);
    }
  }

  if (dutyHours >= 12) {
    rules.push(`EXTENDED DUTY (${dutyHours}h): Plan MUST include portable, calorie-dense snacks for hours 6–${dutyHours}. Budget ~150–200 kcal per 2-hour block in the extended window. Avoid high-fat/high-carb meal combinations that cause drowsiness. Include hydration cues in every snack.`);
  } else if (dutyHours >= 8) {
    rules.push(`STANDARD-LONG DUTY (${dutyHours}h): Include at least 2 substantial, portable snacks spaced ~3 hours apart across the duty window.`);
  }

  if (layoverType === "short") {
    rules.push(`SHORT LAYOVER (≤8h — sleep opportunity): Nutrition must prioritize RECOVERY SLEEP. Pre-sleep: light tryptophan-rich meal (turkey, banana, warm milk). Avoid alcohol, caffeine, and heavy meals within 3h of sleep. On wake: rapid high-protein snack before next duty block.`);
  } else if (layoverType === "long") {
    rules.push(`LONG LAYOVER (24h+): Full recovery window. Day 1 layover: hydrate aggressively, eat anti-inflammatory foods (berries, omega-3 fish, leafy greens). Day 2: align meal timing with destination time zone. Prioritize recovery sleep nutrition (tryptophan, magnesium-rich foods).`);
  }

  if (flightDir === "east") {
    rules.push(`EASTWARD FLIGHT (advance circadian): Circadian advance is harder. At destination: eat melatonin-supporting foods in the evening (tart cherries, kiwi, walnuts). Avoid late-night eating — it delays the advance. Get bright-light exposure in the morning at destination.`);
  } else if (flightDir === "west") {
    rules.push(`WESTWARD FLIGHT (delay circadian): Body adjusts more easily westward. Allow slightly later meal timing at destination. Bright light exposure in the evening at destination accelerates adjustment.`);
  }

  return rules.length > 0
    ? `COGNITIVE PERFORMANCE PROTOCOL — DUTY-OPTIMIZED NUTRITION:\n${rules.join("\n\n")}`
    : null;
}

// Computes a per-day water target scaled to flight distance and duty length.
// Cabin altitude (~8,000 ft) depressurises cabin air to ~15 % humidity — crew
// lose roughly 1.5× the water of a ground day per flight hour.
function computeHydration(data) {
  const tzAbs = Math.abs(parseInt(data.timezone || 0, 10));
  const dutyHours = parseInt(data.duty_hours || 0, 10);

  // Base 2.5 L — already above ground-day norms to account for baseline crew activity
  let liters = 2.5;
  let category;

  if (tzAbs >= 7) { liters += 0.75; category = "ultra-long-haul"; }
  else if (tzAbs >= 5) { liters += 0.5; category = "long-haul"; }
  else if (tzAbs >= 3) { liters += 0.25; category = "medium-haul"; }
  else { category = "domestic"; }

  if (dutyHours >= 12) liters += 0.25;

  return {
    dailyTargetLiters: Math.min(parseFloat(liters.toFixed(2)), 4.0),
    category,
  };
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

  const cognitivePerfRules = getCognitivePerfRules(data);
  const restrictedBorders = detectRestrictedBorders(data.destinations, data.going_usa, data.departure);

  return { langName, dietLabel, rawDiets, jetlag, destinations, profile, hasBudget, perDayBudget, budgetGuidance, calorieTarget, calorieDeficitAmount, gainTarget, maintenanceTarget, goals, kitchenAccessBlock, dietRules, lunchBag, airplaneMealDesc, cookingGuidance, cognitivePerfRules, restrictedBorders };
}

function buildAllDaysPrompt(data, pairingDays, ctx, startDayNum = 1) {
  const hydration = computeHydration(data);
  const daySpecs = Array.from({ length: pairingDays }, (_, i) => {
    const dayNum = startDayNum + i;
    const loc = ctx.destinations[startDayNum - 1 + i] || data.departure;
    const jetlagInstr = ctx.jetlag && dayNum === 1
      ? `jetlagNote: short, practical meal-timing advice for adjusting to the jet lag above. Phrase purely in ${loc} local time — no cross-timezone clock conversions, no "eastward"/"westward" direction.`
      : `jetlagNote: null`;
    const budgetLine = ctx.hasBudget
      ? `Budget: ~$${ctx.perDayBudget.toFixed(2)} USD for today's ingredients near ${loc}.`
      : "";
    return `Day ${dayNum} — Location: ${loc}. ${budgetLine} ${jetlagInstr} hydrationNote: one crew-specific hydration sentence for this day at ${loc} (flight day vs. layover, time of duty) — practical, no numbers, ≤12 words. Never say "stay hydrated".`;
  }).join("\n");
  const hydrationBlock = `\nHYDRATION CONTEXT (${hydration.dailyTargetLiters}L/day target — ${hydration.category}): Cabin pressure at altitude drops humidity to ~15%. Write each day's "hydrationNote" as a brief, crew-tailored tip specific to that day's context (in-flight, transit, layover). Example: "Pack an extra bottle — you're at altitude today." or "Layover day: sip steadily and add electrolytes if it's warm.".\n`;

  const carriedFoodBlock = buildCarriedFoodPromptBlock(ctx.restrictedBorders);

  return `You are a professional nutritionist specializing in aviation crew health.
${carriedFoodBlock ? carriedFoodBlock + "\n" : ""}
${ctx.profile}

${ctx.kitchenAccessBlock}

${ctx.dietRules}
${ctx.budgetGuidance ? `\n${ctx.budgetGuidance}\n` : ""}${ctx.cookingGuidance ? `\n${ctx.cookingGuidance}\n` : ""}
Generate ALL ${pairingDays} day(s) of this nutrition plan in a single response. Return a JSON object with a "days" array of exactly ${pairingDays} day object(s), in order.

Respond ONLY in ${ctx.langName}. Return ONLY valid JSON matching the schema.
Each day: include Breakfast, Lunch, Dinner, and 1-2 Snacks.
The meal "type" field must always be the literal English word "Breakfast", "Lunch", "Dinner", or "Snack" — never translate it — even though every other field must be in ${ctx.langName}.
Every meal must include a "tip" and an "emoji" field with 2–3 food emoji accurately representing the meal. Every meal must also include an "ingredients" array listing each distinct ingredient by short name (e.g. "eggs", "spinach", "feta cheese") — specific enough for a crew member to spot a personal allergen, not full recipe steps.${ctx.lunchBag ? `\nFor every packable meal (not airplane meals), include a "container" field specifying the exact Tupperware size and shape that fits the crew member's ${ctx.lunchBag} lunch bag — e.g. "500ml rectangular container", "300ml round container with clip lid", "2× 200ml sauce containers". Size containers to fit within the bag limits.` : ""}${ctx.airplaneMealDesc ? `\nThe crew member has told us their airplane meal will include: "${ctx.airplaneMealDesc}". For any meal of type "airplane_food", describe how to complement or adapt this specific meal (e.g. add protein, skip the dessert, supplement with a snack). Plan the rest of the day's meals to balance the nutrients already provided by this airplane meal.` : ""}
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
- VERIFY: sum all 5 meal "calories" values. If total < ${ctx.maintenanceTarget - 100} kcal, increase portion sizes before finalizing.` : ""}
${ctx.cognitivePerfRules ? `\n${ctx.cognitivePerfRules}` : ""}
${hydrationBlock}`;
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

// ─── CARRIED-FOOD / BORDER-CROSSING RULES ─────────────────────────────────────
// Crew carry ONE bag for the whole pairing. Any food packed at home or carried
// between stops must clear the customs of EVERY restricted country in the trip,
// not just the country where that food is "used". The UNION of all bans applies
// to packed/carried items; locally-purchased same-stop food stays unrestricted.

const BORDER_COUNTRY_RULES = [
  {
    id: "australia",
    name: "Australia (DAFF biosecurity)",
    codes: ["SYD","MEL","BNE","PER","ADL","CBR","OOL","CNS","DRW","HBA","TSV","MKY","ROK","LST"],
    carriedBans: [
      "Fresh or dried fruit of any kind",
      "Fresh or dried vegetables of any kind",
      "Meat, poultry, or seafood (unless commercially heat-treated and sealed)",
      "Eggs or egg products (unless commercially sealed/pasteurized)",
      "Seeds and nuts (unless commercially sealed/packaged)",
      "Any unpackaged plant material",
    ],
  },
  {
    id: "usa",
    name: "USA (CBP/USDA)",
    usaFlagTrigger: true,
    codes: [
      "JFK","LAX","ORD","ATL","DFW","DEN","SFO","SEA","MIA","BOS","IAD","IAH",
      "PHX","MCO","LAS","MSP","DTW","FLL","CLT","EWR","PHL","SLC","MDW","BWI",
      "SAN","TPA","HNL","PDX","BNA","AUS","RDU","SJC","OAK","MKE","SMF","MSY",
      "RSW","PIT","CMH","ABQ","ONT","BUF","PVD","JAX","ANC","CLE","IND","CVG",
      "OMA","KCI","GRR","SNA","DAL","HOU","SAT","BDL","ORF","RIC","GEG","MEM",
      "BHM","TUS","ELP","STL",
    ],
    carriedBans: [
      "Any fresh fruit (apples, oranges, mangoes, bananas, grapes, berries, citrus, stone fruits, etc.)",
      "Any fresh vegetable (tomatoes, peppers, leafy greens, cucumbers, carrots, broccoli, onions, etc.)",
      "Raw or undercooked meat, poultry, or seafood",
      "Raw eggs or hard-boiled eggs in the shell",
      "Unpasteurized dairy or soft fresh cheese in unsealed containers",
      "Fresh herbs with roots or soil",
    ],
  },
  {
    id: "japan",
    name: "Japan (MAFF quarantine)",
    codes: ["NRT","HND","KIX","NGO","CTS","FUK","OKA","OIT","KMI","KMJ","SDJ"],
    carriedBans: [
      "Fresh fruits and vegetables (strict plant quarantine — most prohibited without inspection certificate)",
      "Unprocessed or uninspected meat/poultry (especially pork from FMD-risk countries)",
      "Plants with soil or roots",
    ],
  },
  {
    id: "eu",
    name: "EU/Schengen border",
    codes: [
      "CDG","ORY","NCE","LYS","MRS","TLS","NTE","BOD","SXB","MPL","LIL",
      "FRA","MUC","BER","HAM","DUS","CGN","STR","NUE","HAJ","DTM","LEJ",
      "AMS","EIN","BRU","CRL","LUX","MAD","BCN","PMI","AGP","ALC","VLC",
      "SVQ","LIS","OPO","FAO","FCO","MXP","LIN","NAP","VCE","BLQ","CTA",
      "BGY","PMO","VIE","SZG","ZRH","GVA","BSL","ARN","GOT","MMX","CPH",
      "AAL","BLL","HEL","TMP","OSL","BGO","TRD","WAW","KRK","PRG","BUD",
      "OTP","SOF","LJU","ZAG","RIX","TLL","VNO","ATH","SKG","HER","RHO",
      "MLA","DUB","ORK","SNN",
    ],
    carriedBans: [
      "Meat and meat products from outside the EU",
      "Dairy products from outside the EU",
      "Fresh fruits and vegetables from non-EU countries (without phytosanitary certificate)",
    ],
  },
  {
    id: "uk",
    name: "United Kingdom (HMRC/DEFRA)",
    codes: ["LHR","LGW","LTN","LCY","STN","MAN","EDI","GLA","BHX","BRS","NCL","LBA","ABZ","BFS","BHD","SOU","EXT","CWL"],
    carriedBans: [
      "Meat and dairy from outside the UK (post-Brexit — EU products are also restricted)",
      "Fresh fruit and vegetables from non-EU countries without phytosanitary certificates",
    ],
  },
  {
    id: "uae",
    name: "UAE/Gulf States",
    codes: ["DXB","AUH","SHJ","DWC","AAN","RKT","FJR","DOH","MCT","SLL","KWI","BAH","RUH","JED","DMM","MED","TUU","AHB","GIZ"],
    carriedBans: [
      "Pork products of any kind",
      "Alcoholic beverages",
    ],
  },
  {
    id: "canada",
    name: "Canada (CBSA/CFIA)",
    codes: ["YYZ","YVR","YUL","YYC","YEG","YOW","YWG","YHZ","YQB","YXE","YQR","YXX","YXU","YHM","YWG","YQM","YFC","YQT","YZF"],
    carriedBans: [
      "Fresh fruits and vegetables without a phytosanitary certificate",
      "Meat, poultry, and meat products (unless commercially canned/pouched and shelf-stable)",
      "Raw or unpasteurized dairy products",
      "Raw eggs or egg products (unless commercially sealed/pasteurized)",
      "Plants, seeds, or soil-bearing plant material",
    ],
  },
];

// Returns array of restricted-border entries that apply to this pairing.
// Each entry carries the days[] it was detected on (empty = triggered by going_usa flag
// with no specific airport found in destinations).
// Destination/departure fields hold a free-typed string like "Toronto (YYZ)"
// (matching the app's own input placeholder convention), not a bare code —
// pull just the airport code out before matching against BORDER_COUNTRY_RULES.
function extractAirportCode(str) {
  const s = (str || "").trim();
  return (s.match(/\(([A-Za-z]{3,4})\)/)?.[1] || s.slice(0, 3)).toUpperCase();
}

// A pairing's bag isn't just exposed to each day's destination — it also has
// to clear the crew member's OWN home-country customs on return. Without this,
// e.g. a Canada-based crew member flying to the USA and back would never see
// Canada's own carried-food restrictions applied to whatever they bought
// abroad and are bringing home.
function detectRestrictedBorders(destinations, goingUsa, departure) {
  const dests = destinations || [];
  const found = [];
  for (const rule of BORDER_COUNTRY_RULES) {
    const days = [];
    dests.forEach((d, i) => {
      if (d && rule.codes.includes(extractAirportCode(d))) days.push(i + 1);
    });
    const onReturn = !!(departure && rule.codes.includes(extractAirportCode(departure)));
    const triggered = days.length > 0 || onReturn || (rule.usaFlagTrigger && goingUsa === "yes");
    if (triggered) found.push({ id: rule.id, name: rule.name, carriedBans: rule.carriedBans, days, onReturn });
  }
  return found;
}

// Union of every banned item across all restricted borders (deduped by text).
function unionCarriedBans(restrictedBorders) {
  const seen = new Set();
  const bans = [];
  for (const b of restrictedBorders) {
    for (const ban of b.carriedBans) {
      if (!seen.has(ban)) { seen.add(ban); bans.push(ban); }
    }
  }
  return bans;
}

// Prompt block injected into the DAYS and EXTRAS AI prompts.
function buildCarriedFoodPromptBlock(restrictedBorders) {
  if (!restrictedBorders || restrictedBorders.length === 0) return "";
  const countryLines = restrictedBorders.map(b => {
    const parts = [];
    if (b.days.length > 0) parts.push(`Day${b.days.length > 1 ? "s" : ""} ${b.days.join(" & ")}`);
    if (b.onReturn) parts.push("on return home");
    const dayStr = parts.length > 0 ? ` (${parts.join("; ")})` : " (during this pairing)";
    return `  • ${b.name}${dayStr}`;
  }).join("\n");
  const banLines = unionCarriedBans(restrictedBorders).map(b => `  ❌ ${b}`).join("\n");
  return `⚠️ CROSS-BORDER CARRIED-FOOD RULES — HARD REQUIREMENT:
Crew carry ONE bag for the whole pairing. This pairing crosses:
${countryLines}
ANY food pre-packed at home, carried between days, or kept as leftovers must clear ALL these customs checkpoints. The union of all bans applies — NEVER pack or carry:
${banLines}
For ALL packed/carried meals and snacks: use ONLY commercially packaged/sealed, canned, dried, or shelf-stable ingredients.

LOCALLY-PURCHASED, SAME-STOP MEALS (bought AND fully consumed at one stop before the next flight):
• CAN use fresh local ingredients — they never cross a border in the bag.
• In the meal "tip" field: note "Buy locally at [stop] and consume before next flight — do not pack leftovers."
For any packed/carried meal "tip": briefly explain WHY shelf-stable — e.g. "Canned tuna used: packed items must clear USA and Japan customs."`;
}

// User-facing text added server-side to foodRestrictions.carried — not generated by the model.
function buildCarriedFoodNote(restrictedBorders) {
  if (!restrictedBorders || restrictedBorders.length === 0) return null;
  const countryStrs = restrictedBorders.map(b => {
    const parts = [];
    if (b.days.length > 0) parts.push(`Day ${b.days.join(", ")}`);
    if (b.onReturn) parts.push("on return home");
    return `${b.name}${parts.length > 0 ? ` (${parts.join("; ")})` : ""}`;
  });
  const bans = unionCarriedBans(restrictedBorders);
  return `Your bag crosses ${countryStrs.length > 1 ? "multiple restricted borders" : "a restricted border"} on this pairing: ${countryStrs.join("; ")}.\n\nAny food packed at home or carried between stops must clear ALL of these customs checkpoints. The following items cannot be packed or carried anywhere on this pairing:\n${bans.map(b => `• ${b}`).join("\n")}\n\nLocally-purchased food bought and eaten entirely at one stop (nothing packed for later) does not have these restrictions.\n\nSafe to pack and carry: commercially packaged and sealed, canned, dried, or shelf-stable items only.`;
}

function buildExtrasPrompt(data, pairingDays, ctx) {
  const itinerary = ctx.destinations.map((d, i) => `  Day ${i + 1}: ${d}`).join("\n");
  // Carried-food block applies to the grocery list: items you buy at home to pack
  // must clear every restricted border in the pairing. Same union logic as DAYS prompt.
  const carriedGroceryBlock = buildCarriedFoodPromptBlock(ctx.restrictedBorders);

  const destFoodRules = getDestinationFoodRules(ctx.destinations);

  return `You are a professional nutritionist specializing in aviation crew health.
${carriedGroceryBlock ? carriedGroceryBlock + "\n" : ""}
${ctx.profile}

${ctx.kitchenAccessBlock}

${ctx.dietRules}
${ctx.budgetGuidance ? `\n${ctx.budgetGuidance}\n` : ""}
Daily itinerary:
${itinerary}

DESTINATION CUSTOMS & FOOD RULES (for the "destination" field in foodRestrictions):
${destFoodRules}

Generate the SUMMARY, GROCERY LIST, and FOOD RESTRICTIONS sections for this ${pairingDays}-day nutrition plan (day-by-day meals are generated separately).

Respond ONLY in ${ctx.langName}. Return ONLY valid JSON matching the schema.
- "summary": 2-sentence overview of the whole plan${ctx.calorieTarget ? `, noting that it targets a daily calorie deficit (~${ctx.calorieTarget} kcal/day) to support healthy, sustainable weight loss` : ctx.gainTarget ? `, noting that it targets a calorie surplus (~${ctx.gainTarget} kcal/day) to support healthy weight and muscle gain` : ""}.
- "groceryList": categorized shopping list (produce, protein, pantry, snacks, dairy) for items to buy at home and CARRY on the pairing. IMPORTANT: (1) every item must comply with the DIET RULES above; (2) if CROSS-BORDER CARRIED-FOOD RULES are stated above, EVERY item in the grocery list must comply — do not include any banned carried item; (3) base items on kitchen access constraints${ctx.hasBudget ? `; (4) keep total costs within $${(ctx.perDayBudget * pairingDays).toFixed(2)} (USD-equivalent) for the whole trip` : ""}.
- "foodRestrictions": "usa" (${data.going_usa === "yes" ? "practical list of what cannot be brought into the USA and why" : "Not applicable — not traveling to the USA"}), "destination" (summarize the DESTINATION CUSTOMS & FOOD RULES above into practical crew-focused bullet points for ${ctx.destinations.join(", ")}), "general" (general tips for a ${ctx.dietLabel} diet while traveling).`;
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
      return res.json({ alreadyVerified: true, token: storeData.token, email: storeData.email, name: storeData.name, isPremium: storeData.isPremium, pairingCount: storeData.pairingCount, hasPassword: storeData.hasPassword, ...toFrontendProfileFields(storeData) });
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
    res.json({ ...data, ...toFrontendProfileFields(data) });
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
    res.json({ ...data, ...toFrontendProfileFields(data) });
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
    res.json({ ...data, ...toFrontendProfileFields(data) });
  } catch (err) {
    console.error("verify-session error:", err.message);
    res.status(500).json({ error: "Session check failed." });
  }
});

// Persists durable profile preferences to the user's server-side record, so
// they survive a cleared cache or a new device — not just localStorage on
// whichever browser set them.
// Frontend uses snake_case (matches the pairing/check-in object shape);
// the CRUD API's User schema uses camelCase. This is the single mapping
// between the two — reused for both saving and reading these fields back.
const PROFILE_FIELD_MAP = {
  gender: "gender", weight: "weight", dob: "dob", position: "position",
  lunch_bag: "lunchBag", cooking_pref: "cookingPref",
  diets: "diets", diet_other: "dietOther", goals: "goals",
  calorie_target: "calorieTarget", calorie_deficit_amount: "calorieDeficitAmount",
  calorie_deficit_preset: "calorieDeficitPreset", departure: "departure",
  budget_type: "budgetType", budget_amount: "budgetAmount", kitchen: "kitchen",
};
function toCrudProfileFields(snakeCaseFields) {
  const out = {};
  for (const [snake, camel] of Object.entries(PROFILE_FIELD_MAP)) {
    if (snakeCaseFields[snake] !== undefined) out[camel] = snakeCaseFields[snake];
  }
  return out;
}
function toFrontendProfileFields(camelCaseFields) {
  const reverse = Object.fromEntries(Object.entries(PROFILE_FIELD_MAP).map(([s, c]) => [c, s]));
  const out = {};
  for (const [camel, val] of Object.entries(camelCaseFields || {})) {
    if (reverse[camel]) out[reverse[camel]] = val;
  }
  return out;
}

app.post("/api/profile/update", async (req, res) => {
  try {
    const { email, ...fields } = req.body;
    if (!email || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "Valid email is required." });
    }
    const updateRes = await fetch(`${CRUD_API_BASE}/api/profile/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
      body: JSON.stringify({ email: email.toLowerCase().trim(), ...toCrudProfileFields(fields) }),
    });
    const data = await updateRes.json();
    if (!updateRes.ok) return res.status(updateRes.status).json(data);
    res.json(toFrontendProfileFields(data));
  } catch (err) {
    console.error("profile/update error:", err.message);
    res.status(500).json({ error: "Could not save profile. Please try again." });
  }
});

// ─── CONTACT US ───────────────────────────────────────────────────────────────
// Emails the submitted message to the support inbox via Resend, reply-to set
// to the submitter so replying in the inbox goes straight back to them.
const CONTACT_TO_EMAIL = "crewmealplans@nutricrew.ca";
const MAX_CONTACT_MESSAGE_LENGTH = 4000;

app.post("/api/contact", async (req, res) => {
  try {
    const { name, email, message } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Name is required." });
    }
    if (!email || typeof email !== "string" || !EMAIL_REGEX.test(email.trim())) {
      return res.status(400).json({ error: "A valid email is required." });
    }
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Message is required." });
    }
    if (message.length > MAX_CONTACT_MESSAGE_LENGTH) {
      return res.status(400).json({ error: "Message is too long." });
    }
    if (!process.env.RESEND_API_KEY) {
      return res.status(503).json({ error: "Contact form is not configured." });
    }

    const safeName = name.trim().slice(0, 200);
    const safeEmail = email.trim();
    const safeMessage = message.trim();

    const emailResult = await resend.emails.send({
      from: FROM_EMAIL,
      to: [CONTACT_TO_EMAIL],
      reply_to: safeEmail,
      subject: `NutriCrew contact form: ${safeName}`,
      html: `<p><strong>From:</strong> ${safeName} (${safeEmail})</p><p style="white-space:pre-wrap">${safeMessage.replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</p>`,
    });
    if (emailResult.error) {
      console.error("Contact form email error:", emailResult.error);
      return res.status(502).json({ error: "Could not send your message. Please try again." });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("contact error:", err.message);
    res.status(500).json({ error: "Could not send your message. Please try again." });
  }
});

// ─── REFERRAL ─────────────────────────────────────────────────────────────────

app.get("/api/referral/code", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "email is required" });
    const r = await fetch(`${CRUD_API_BASE}/api/referral/code?email=${encodeURIComponent(email)}`, {
      headers: { "x-internal-key": INTERNAL_API_KEY },
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (err) {
    console.error("referral/code error:", err.message);
    res.status(500).json({ error: "Failed to get referral code." });
  }
});

app.post("/api/referral/use", async (req, res) => {
  try {
    const { email, referralCode } = req.body;
    if (!email || !referralCode) return res.status(400).json({ error: "email and referralCode are required" });
    const r = await fetch(`${CRUD_API_BASE}/api/referral/use`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
      body: JSON.stringify({ email, referralCode }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (err) {
    console.error("referral/use error:", err.message);
    res.status(500).json({ error: "Failed to apply referral code." });
  }
});

// ─── PLAN GENERATION ──────────────────────────────────────────────────────────

// ── MEAL CACHE HELPERS ────────────────────────────────────────────

// Bump this whenever MEAL_SCHEMA gains a new required field or the prompt
// changes in a way that makes an old cached meal invalid/incomplete (e.g.
// adding "ingredients" — every previously-cached meal was missing it).
// Folded into every cache key so old entries become unreachable and get
// freshly regenerated under the current schema/prompt.
const CACHE_SCHEMA_VERSION = "v3";

function buildCacheKey(data, ctx, lang) {
  const diets = (Array.isArray(data.diets) ? data.diets : (data.diet ? [data.diet] : [])).filter(Boolean).sort();
  const goals = (data.goals || []).slice().sort();
  const perDay = ctx.perDayBudget;
  const budgetLevel = !perDay ? "none" : perDay > 50 ? "high" : perDay > 20 ? "medium" : "low";
  // For multi-day plans each day may have a different kitchen; include all of
  // them in the key so mixed kitchens never collide in cache.
  const kitchen = Array.isArray(data.kitchen_by_day) && data.kitchen_by_day.length > 0
    ? data.kitchen_by_day.map(k => (Array.isArray(k) ? k.slice().sort() : (k ? [k] : [])).join("+") || "full_kitchen").join("|")
    : (data.kitchen || []).slice().sort().join(",") || "full_kitchen";
  const ct = ctx.calorieTarget
    ? String(Math.round(ctx.calorieTarget / 100) * 100)
    : ctx.gainTarget
      ? `gain${Math.round(ctx.gainTarget / 100) * 100}`
      : ctx.maintenanceTarget
        ? `maint${Math.round(ctx.maintenanceTarget / 200) * 200}`
        : "none";
  const dietKeyBase = diets.join(",") || "none";
  return {
    dietKey: `${dietKeyBase}|${CACHE_SCHEMA_VERSION}`,
    goalKey: goals.join(",") || "none",
    budgetLevel,
    kitchenKey: kitchen,
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
  // Tracks whether reservePairingUsage actually consumed a non-premium
  // user's free slot for THIS request, so a later failure (calorie_deficit
  // gate, AI/generation error) can give it back instead of silently
  // burning their one free pairing on a request that never produced a plan.
  let reservedFreeSlot = false;
  let reservedEmail = null;
  try {
    const { data, lang } = req.body;
    if (!data) return res.status(400).json({ error: "Missing 'data' in request body" });

    const email = (data.email || "").toLowerCase().trim();
    if (!email) return res.status(400).json({ error: "Missing 'email' in request data" });
    if (!EMAIL_REGEX.test(email)) return res.status(400).json({ error: "Invalid 'email' format" });
    reservedEmail = email;

    const pairingDays = Math.min(Math.max(parseInt(data.pairing_days, 10) || 1, 1), MAX_PAIRING_DAYS);
    const ctx = buildContext(data, lang, pairingDays);
    const cacheKey = buildCacheKey(data, ctx, lang);
    const extrasKey = buildExtrasCacheKey(data, ctx, lang, pairingDays);
    const reqDiets = Array.isArray(data.diets) ? data.diets : (data.diet ? [data.diet] : []);

    // ── Bank check (sync, in-memory, ~0ms) ───────────────────────
    // Returns a pre-generated plan instantly for common combos before
    // touching the DB or calling the AI.
    const bankLookupKey = [
      cacheKey.dietKey, cacheKey.goalKey, cacheKey.budgetLevel,
      cacheKey.kitchenKey, cacheKey.calorieTargetKey, cacheKey.cookingKey,
      cacheKey.lang, pairingDays,
    ].join("|");
    // Skip the bank when any restricted border is in the pairing — bank entries were
    // generated without carried-food constraints and may include prohibited items.
    const bankEntries = ctx.restrictedBorders.length === 0 ? (PLAN_BANK_MAP[bankLookupKey] || []) : [];
    if (bankEntries.length > 0) {
      // Atomic check-and-consume: closes the race where two concurrent
      // requests could both read "allowed" before either had incremented.
      const usage = await reservePairingUsage(email, data.name, req.ip);
      if (!usage.allowed) {
        return res.status(403).json({
          error: "premium_required",
          message: "A Premium subscription is required to generate plans. Start your free month for unlimited plans.",
          pairingCount: usage.pairingCount,
        });
      }
      reservedFreeSlot = !usage.isPremium;
      if (reqDiets.includes("calorie_deficit") && !usage.isPremium) {
        await releasePairingUsage(email).catch(e => console.error("release failed:", e.message));
        reservedFreeSlot = false;
        return res.status(403).json({
          error: "premium_required",
          message: "Calorie Deficit plans are a Premium feature. Upgrade to Premium to unlock this and unlimited plans.",
          pairingCount: usage.pairingCount - 1,
        });
      }
      const entry = bankEntries[Math.floor(Math.random() * bankEntries.length)];
      // Bank entries predate the allergen guard — check them too before serving.
      const guardedBankDays = await applyAllergenGuard(entry.days, data, ctx);
      // Fire-and-forget: seed the DB cache so repeat requests get fresh AI variety
      storeCachedDays(guardedBankDays, cacheKey)
        .then(r => { if (r.ids?.length) markDaysSeen(email, r.ids); })
        .catch(() => {});
      console.log(`[bank] HIT for ${email}: ${bankLookupKey}`);
      return res.json({
        summary: entry.summary,
        days: guardedBankDays,
        groceryList: entry.groceryList,
        foodRestrictions: entry.foodRestrictions,
        performanceAdvisory: getCognitivePerfRules(data),
        hydration: computeHydration(data),
        pairingCount: usage.pairingCount,
        isPremium: usage.isPremium,
        hasPassword: usage.hasPassword,
      });
    }

    // ── Normal flow (bank miss) ───────────────────────────────────
    // Run auth check, meal cache query, and extras cache query all in parallel.
    // reservePairingUsage atomically checks-and-consumes in one DB operation —
    // closes the race where two concurrent requests could both read
    // "allowed" before either had incremented.
    const [usage, { days: cachedDays }, cachedExtras] = await Promise.all([
      reservePairingUsage(email, data.name, req.ip),
      queryCachedDays(email, cacheKey, pairingDays),
      queryExtrasCache(extrasKey),
    ]);

    if (!usage.allowed) {
      return res.status(403).json({
        error: "premium_required",
        message: "A Premium subscription is required to generate plans. Start your free month for unlimited plans.",
        pairingCount: usage.pairingCount,
      });
    }
    reservedFreeSlot = !usage.isPremium;

    if (reqDiets.includes("calorie_deficit") && !usage.isPremium) {
      await releasePairingUsage(email).catch(e => console.error("release failed:", e.message));
      reservedFreeSlot = false;
      return res.status(403).json({
        error: "premium_required",
        message: "Calorie Deficit plans are a Premium feature. Upgrade to Premium to unlock this and unlimited plans.",
        pairingCount: usage.pairingCount - 1,
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
        hydrationNote: null,
        meals: d.meals,
        totalCalories: d.totalCalories,
      }));
      console.log(`[meal-cache] HIT for ${email}: days=cache extras=${cachedExtras ? "cache" : "ai"}`);
    } else {
      // Partial or full cache miss — generate each missing day in parallel (EXTRAS also runs in parallel)
      const missing = pairingDays - cachedDays.length;
      const missingData = { ...data, pairing_days: missing };
      const missingCtx = buildContext(missingData, lang, missing);
      console.log(`[calorie-debug] gender=${missingData.gender} weight=${missingData.weight} dob=${missingData.dob} age=${missingData.age} → maintenanceTarget=${missingCtx.maintenanceTarget} calorieTarget=${missingCtx.calorieTarget} gainTarget=${missingCtx.gainTarget} cacheKey.calorieTargetKey=${buildCacheKey(missingData, missingCtx, lang).calorieTargetKey}`);

      const generateOneDay = (dayIndex) => {
        const overallDayNum = cachedDays.length + dayIndex + 1;
        // Use per-day kitchen if provided; fall back to the shared kitchen setting.
        // Always coerce to array: kitchen_by_day[i] might be a string if the
        // client serialized a single-element array as a scalar.
        const rawKitchen = Array.isArray(missingData.kitchen_by_day)
          ? (missingData.kitchen_by_day[overallDayNum - 1] || missingData.kitchen || [])
          : (missingData.kitchen || []);
        const dayKitchen = Array.isArray(rawKitchen) ? rawKitchen : (rawKitchen ? [rawKitchen] : []);
        const dayData = { ...missingData, kitchen: dayKitchen };
        const dayCtx = buildContext(dayData, lang, 1);
        // 3200 tokens: multi-country customs tips can be verbose; 2200 caused
        // the API to return a minimal 1-meal response when the output hit the cap.
        return runStructured(
          buildAllDaysPrompt(dayData, 1, dayCtx, overallDayNum),
          DAYS_SCHEMA, 3200, FAST_MODEL
        ).then(r => {
          const meals = r?.days?.[0]?.meals;
          if (!meals || meals.length < 3) {
            throw new Error(`Day ${overallDayNum} returned only ${meals?.length ?? 0} meals`);
          }
          return r;
        });
      };

      const dayResults = await Promise.all(
        Array.from({ length: missing }, async (_, i) => {
          try {
            return await generateOneDay(i);
          } catch (e) {
            console.warn(`[generate-plan] Day ${cachedDays.length + i + 1} attempt 1 failed: ${e.message} — retrying`);
            try {
              return await generateOneDay(i);
            } catch (e2) {
              console.error(`[generate-plan] Day ${cachedDays.length + i + 1} failed after retry: ${e2.message}`);
              return null;
            }
          }
        })
      );

      if (dayResults.every(r => r === null)) {
        throw Object.assign(new Error("Failed to generate meal plan after retries"), { status: 503 });
      }

      // Server-side calorie guard: if the model's meal sum drifts outside the
      // target ± 15 % we proportionally rescale all macros so the total is
      // guaranteed to land within the band, without an extra AI call.
      const guardTarget = missingCtx.calorieTarget ?? missingCtx.gainTarget ?? missingCtx.maintenanceTarget;
      const guardTolerance = missingCtx.maintenanceTarget ? 0.15 : 0.10;
      const aiDays = dayResults.map(r => {
        if (!r) return null;
        const raw = r.days[0];
        const { meals, totalCalories } = guardTarget
          ? rescaleMealsToTarget(raw.meals, guardTarget, guardTolerance)
          : { meals: raw.meals, totalCalories: raw.meals.reduce((s, m) => s + m.calories, 0) };
        return { meals, totalCalories, label: raw.label, jetlagNote: raw.jetlagNote, hydrationNote: raw.hydrationNote ?? null };
      });

      const successfulAiDays = aiDays.filter(d => d !== null);
      const stored = successfulAiDays.length > 0
        ? await storeCachedDays(successfulAiDays, cacheKey)
        : { ids: [] };
      newDayIds = stored.ids || [];

      const allDays = [
        ...cachedDays.map(d => ({ meals: d.meals, totalCalories: d.totalCalories, label: null, jetlagNote: null, hydrationNote: null })),
        ...aiDays,
      ];
      days = allDays.slice(0, pairingDays).map((d, i) => {
        const dayNum = i + 1;
        // Model generates each day individually (pairingDays=1 per call) so it
        // always labels itself "Day 1 — ...". Correct the prefix to match position.
        const rawLabel = d?.label || `Day ${dayNum}`;
        const label = rawLabel.replace(/^Day\s+\d+/i, `Day ${dayNum}`);
        return {
          day: dayNum,
          label,
          jetlagNote: d?.jetlagNote || null,   // || catches empty string from model
          hydrationNote: d?.hydrationNote || null,
          meals: d?.meals || null,
          totalCalories: d?.totalCalories || null,
          failed: d === null,
        };
      });
      const failedCount = aiDays.filter(d => d === null).length;
      console.log(`[meal-cache] MISS for ${email}: generated ${missing} day(s), ${failedCount} failed extras=${cachedExtras ? "cache" : "ai"}`);
    }

    days = await applyAllergenGuard(days, data, ctx);

    const extras = await extrasPromise;

    // Inject the server-computed carried-food note (deterministic, not from the model).
    const carriedNote = buildCarriedFoodNote(ctx.restrictedBorders);
    if (carriedNote) {
      extras.foodRestrictions = { ...extras.foodRestrictions, carried: carriedNote };
    }

    // Fire-and-forget: doesn't gate anything. The pairing count itself was
    // already atomically consumed by reservePairingUsage above.
    markDaysSeen(email, [...cachedDayIds, ...newDayIds]);

    const failedDays = days.filter(d => d.failed).map(d => d.day);
    const planResponse = {
      summary: extras.summary,
      days,
      groceryList: extras.groceryList,
      foodRestrictions: extras.foodRestrictions,
      performanceAdvisory: getCognitivePerfRules(data),
      hydration: computeHydration(data),
      pairingCount: usage.pairingCount,
      isPremium: usage.isPremium,
      hasPassword: usage.hasPassword,
      ...(failedDays.length ? { failedDays } : {}),
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
    // A reserved free slot must not be burned by a failed generation attempt —
    // give it back before reporting the error.
    if (reservedFreeSlot && reservedEmail) {
      await releasePairingUsage(reservedEmail).catch(e => console.error("release failed:", e.message));
    }
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

    let calorieTimerId;
    const message = await Promise.race([
      client.messages.create({
        model: FAST_MODEL,
        max_tokens: 1024,
        output_config: { format: { type: "json_schema", schema: CALORIE_SCHEMA } },
        messages: [{ role: "user", content: prompt }],
      }),
      new Promise((_, rej) => {
        calorieTimerId = setTimeout(
          () => rej(Object.assign(new Error("Request timed out"), { status: 504 })),
          30000
        );
      }),
    ]).finally(() => clearTimeout(calorieTimerId));

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

    let mealTimerId;
    const message = await Promise.race([
      client.messages.create({
        model: FAST_MODEL,
        max_tokens: 1024,
        output_config: { format: { type: "json_schema", schema: AIRPLANE_MEAL_SCHEMA } },
        messages: [{ role: "user", content: prompt }],
      }),
      new Promise((_, rej) => {
        mealTimerId = setTimeout(
          () => rej(Object.assign(new Error("Request timed out"), { status: 504 })),
          30000
        );
      }),
    ]).finally(() => clearTimeout(mealTimerId));

    if (message.stop_reason === "refusal") {
      return res.status(502).json({ error: "The model declined to check this meal." });
    }

    res.json(extractJSON(message));
  } catch (err) {
    handleAnthropicError(err, res);
  }
});

// Manual, user-triggered version of the automatic allergen guard: a crew
// member taps a specific ingredient on a generated meal (e.g. one that isn't
// covered by any of their selected allergy checkboxes) and this regenerates
// just that meal without it. Free for everyone — this is a safety
// correction, not a premium feature.
app.post("/api/regenerate-meal", apiLimiter, async (req, res) => {
  try {
    const { meal, excludeIngredient, data, lang } = req.body;
    if (!meal || typeof meal !== "object" || !meal.type || !meal.name) {
      return res.status(400).json({ error: "Missing or invalid 'meal'" });
    }
    if (!excludeIngredient || typeof excludeIngredient !== "string" || excludeIngredient.length > 100) {
      return res.status(400).json({ error: "Missing or invalid 'excludeIngredient'" });
    }
    if (!data || typeof data !== "object") {
      return res.status(400).json({ error: "Missing 'data'" });
    }

    const pairingDays = Math.min(Math.max(parseInt(data.pairing_days, 10) || 1, 1), MAX_PAIRING_DAYS);
    const ctx = buildContext(data, lang, pairingDays);
    const personalNote = `${ctx.dietRules}\n\nPERSONAL ALLERGY: The crew member has personally flagged "${excludeIngredient}" as something they cannot eat, separate from the diet rules above. Do not include it in any form.`;
    const replacement = await regenerateCompliantMeal(
      meal, [{ diet: "personal allergy", term: excludeIngredient }], personalNote, ctx.kitchenAccessBlock
    );
    res.json({ meal: replacement });
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
    const { images, homeBase, email } = req.body;
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
    const { email, name, pairingDate, destinations, confirmToken } = req.body;
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
  { name: "Push-Up",               muscle: "Chest",       vid: "IODxDxX7oi4", eq: "bw" },
  { name: "Diamond Push-Up",       muscle: "Triceps",     vid: "J0DXBSpghaI", eq: "bw" },
  { name: "Pike Push-Up",          muscle: "Shoulders",   vid: "oMhDeQd7tYU", eq: "bw" },
  { name: "Squat",                 muscle: "Legs",        vid: "ultWZbUMPL8", eq: "bw" },
  { name: "Jump Squat",            muscle: "Legs",        vid: "CVaEhXotL7M", eq: "bw" },
  { name: "Lunge",                 muscle: "Legs",        vid: "QOVaHwm-Q6U", eq: "bw" },
  { name: "Reverse Lunge",         muscle: "Legs",        vid: "wrwwXE_x-pQ", eq: "bw" },
  { name: "Glute Bridge",          muscle: "Glutes",      vid: "OUgsJ8-Vi0E", eq: "bw" },
  { name: "Calf Raise",            muscle: "Calves",      vid: "gwLzBJYoWlA", eq: "bw" },
  { name: "Wall Sit",              muscle: "Legs",        vid: "y-wV4Venusw",  eq: "bw" },
  { name: "Plank",                 muscle: "Core",        vid: "pSHjTRaRanQ",  eq: "bw" },
  { name: "Side Plank",            muscle: "Core",        vid: "K2VljzCC16g",  eq: "bw" },
  { name: "Crunch",                muscle: "Core",        vid: "Xyd_fa5zoEU",  eq: "bw" },
  { name: "Bicycle Crunch",        muscle: "Core",        vid: "9FGilxCbdz8",  eq: "bw" },
  { name: "Leg Raise",             muscle: "Core",        vid: "JB2oyawG9KI",  eq: "bw" },
  { name: "Russian Twist",         muscle: "Core",        vid: "wkD8rjkodUI",  eq: "bw" },
  { name: "Superman",              muscle: "Back",        vid: "cc6UVNTKZAA",  eq: "bw" },
  { name: "Mountain Climber",      muscle: "Cardio",      vid: "nmwgirgXLYM",  eq: "bw" },
  { name: "Burpee",                muscle: "Cardio",      vid: "dZgVxmf6jkA",  eq: "bw" },
  { name: "Jumping Jack",          muscle: "Cardio",      vid: "c4DAnQ6DtF8",  eq: "bw" },
  { name: "High Knee",             muscle: "Cardio",      vid: "8opcQdC-V-U",  eq: "bw" },
  { name: "Tricep Dip",            muscle: "Triceps",     vid: "0326dy_-CzM",  eq: "bw" },
  { name: "Dumbbell Curl",         muscle: "Biceps",      vid: "ykJmrZ5v0Oo",  eq: "db" },
  { name: "Dumbbell Shoulder Press",muscle: "Shoulders",  vid: "qEwKCR5JCog",  eq: "db" },
  { name: "Dumbbell Row",          muscle: "Back",        vid: "pYcpY20QaE8",  eq: "db" },
  { name: "Dumbbell Squat",        muscle: "Legs",        vid: "Dy55_GsGGvU",  eq: "db" },
  { name: "Dumbbell Lunge",        muscle: "Legs",        vid: "L8fvypPrzzs",  eq: "db" },
  { name: "Hip Flexor Stretch",    muscle: "Flexibility", vid: "gX7I-j2JkCE",  eq: "bw" },
  { name: "Hamstring Stretch",     muscle: "Flexibility", vid: "7kFJtCJMqRs",  eq: "bw" },
  { name: "Child's Pose",          muscle: "Flexibility", vid: "qZ_KahQm4ac",  eq: "bw" },
  { name: "Cat-Cow",               muscle: "Flexibility", vid: "kqnua4rHVVA",  eq: "bw" },
  { name: "Downward Dog",          muscle: "Flexibility", vid: "j97SSGsnCAQ",  eq: "bw" },
  { name: "Pigeon Pose",           muscle: "Flexibility", vid: "Qq4MJMoaEWM",  eq: "bw" },
  { name: "Neck Roll",             muscle: "Flexibility", vid: "Zp-JfaLPMOk",  eq: "bw" },
  { name: "Shoulder Roll",         muscle: "Flexibility", vid: "y7s3BfObUPM",  eq: "bw" },
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
    const { email, pairings, profile } = req.body;
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
    const gender = profile?.gender || "female";
    const kitchen = [].concat(profile?.kitchen || []);
    // Crew without a home kitchen (hotel or airplane food only) have no gym equipment
    const hasEquipment = kitchen.length > 0 && !kitchen.every(k => ["hotel_no_kitchen", "airplane_food"].includes(k));
    const availableExercises = hasEquipment
      ? EXERCISE_NAME_LIST
      : EXERCISE_LIBRARY.filter(e => e.eq === "bw").map(e => e.name).join(", ");
    const equipmentNote = hasEquipment
      ? "Equipment: home gym access allowed — dumbbells permitted on off days."
      : "Equipment: NO gym equipment available. Use ONLY bodyweight exercises on ALL days. Never suggest dumbbells or machines.";

    const pairingLines = pairings.map(p => {
      const start = p.pairingDate ? new Date(p.pairingDate).toISOString().split("T")[0] : "?";
      const end   = p.returnDate  ? new Date(p.returnDate).toISOString().split("T")[0]  : "?";
      return `  - ${start} to ${end}: ${p.departure} → ${(p.destinations||[]).join(" → ")} (${p.pairingDays || 1} days)`;
    }).join("\n");

    const prompt = `You are a fitness coach for flight crew. Create a monthly gym plan tailored to their roster.

Gender: ${gender}
Goals: ${goals}
Position: ${profile?.position || "cabin"}
${equipmentNote}

Roster schedule:
${pairingLines}

Rules:
- "off" days (not in any pairing): 40-50 min full workout, 5-6 exercises — bodyweight circuits unless equipment is available
- "layover" days (hotel, mid-pairing): 20 min hotel room circuit, 4-5 bodyweight exercises only, no equipment
- "pairing" days (departure/arrival day of a trip): 15 min stretch/mobility only, 3-4 exercises from Flexibility
- "rest" days (day after long trip): rest — set workout to null

Use ONLY these exercise names (exact spelling): ${availableExercises}

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
    const normalizedEmail = (email || "").toLowerCase().trim();
    if (!email || !EMAIL_REGEX.test(normalizedEmail)) {
      return res.status(400).json({ error: "Missing or invalid email" });
    }
    if (!stripe) {
      return res.status(503).json({ error: "Payments not configured" });
    }
    const isAnnual = plan === "annual";

    // Trial abuse guard: an email that already has a Stripe customer on file
    // has been through checkout before (trial or paid) — reuse that customer
    // and skip trial_period_days so they can't restart the free trial by
    // simply upgrading again. Same-card-different-email abuse is handled by
    // Stripe Radar's built-in "block if card used for a trial before" rule
    // (configured in the Stripe dashboard, not here).
    const existingCustomerId = await getExistingStripeCustomerId(normalizedEmail);
    const isReturningCustomer = !!existingCustomerId;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      payment_method_collection: "always", // card required up front, even during a trial
      ...(isReturningCustomer
        ? { customer: existingCustomerId }
        : { customer_email: normalizedEmail }),
      metadata: { email: normalizedEmail },
      subscription_data: {
        metadata: { email: normalizedEmail },
        ...(isReturningCustomer ? {} : { trial_period_days: TRIAL_DAYS }),
      },
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: isAnnual ? 6712 : 799, // annual $67.12 = 30% off 12×$7.99 ($95.88); monthly $7.99
          recurring: { interval: isAnnual ? "year" : "month" },
          product_data: {
            name: isAnnual ? "NutriCrew Premium (Annual)" : "NutriCrew Premium (Monthly)",
            description: "Unlimited meal plans, gym plans, roster automation, calorie deficit & jetlag meal plans.",
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

// Redirects an existing subscriber to Stripe's hosted billing portal so they
// can update payment methods, view invoices, or cancel — self-service, no
// custom cancellation UI to build or dispute-prone dark patterns to avoid.
app.post("/api/create-portal-session", async (req, res) => {
  try {
    const { email } = req.body;
    const normalizedEmail = (email || "").toLowerCase().trim();
    if (!email || !EMAIL_REGEX.test(normalizedEmail)) {
      return res.status(400).json({ error: "Missing or invalid email" });
    }
    if (!stripe) {
      return res.status(503).json({ error: "Payments not configured" });
    }
    const customerId = await getExistingStripeCustomerId(normalizedEmail);
    if (!customerId) {
      return res.status(404).json({ error: "No subscription found for this account." });
    }
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: FRONTEND_URL,
    });
    res.json({ url: portalSession.url });
  } catch (err) {
    console.error("Stripe portal session error:", err.message);
    res.status(500).json({ error: "Could not open billing portal." });
  }
});

// Switches an existing subscriber's active subscription to annual billing in
// place (proration, not a new checkout) — reuses whatever product the
// subscription is already on, so this never creates a new Stripe product.
app.post("/api/switch-to-annual", async (req, res) => {
  try {
    const { email } = req.body;
    const normalizedEmail = (email || "").toLowerCase().trim();
    if (!email || !EMAIL_REGEX.test(normalizedEmail)) {
      return res.status(400).json({ error: "Missing or invalid email" });
    }
    if (!stripe) {
      return res.status(503).json({ error: "Payments not configured" });
    }
    const customerId = await getExistingStripeCustomerId(normalizedEmail);
    if (!customerId) {
      return res.status(404).json({ error: "No subscription found for this account." });
    }
    const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 1 });
    const subscription = subs.data[0];
    if (!subscription || !["active", "trialing", "past_due"].includes(subscription.status)) {
      return res.status(404).json({ error: "No active subscription found." });
    }
    const item = subscription.items.data[0];
    if (item.price.recurring?.interval === "year") {
      return res.json({ alreadyAnnual: true });
    }

    await stripe.subscriptions.update(subscription.id, {
      items: [{
        id: item.id,
        price_data: {
          currency: "usd",
          unit_amount: 6712, // matches the paywall's annual price ($67.12 = 30% off 12×$7.99)
          recurring: { interval: "year" },
          product: typeof item.price.product === "string" ? item.price.product : item.price.product.id,
        },
      }],
      proration_behavior: "create_prorations",
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("Switch to annual error:", err.message);
    res.status(500).json({ error: "Could not switch to annual billing." });
  }
});

// --- Error handling ---

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Catches malformed JSON bodies and anything else that escapes a route's own
// try/catch, so Express's default handler (which can include stack traces
// when NODE_ENV isn't "production") never sends raw error details to clients.
app.use((err, req, res, _next) => {
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
