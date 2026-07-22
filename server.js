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
// this every 5 min to keep the Vercel function instance warm (Fluid Compute
// reuses instances across requests, but an idle one still eventually recycles).
app.get("/health", (_req, res) => res.json({ ok: true }));

// Lets the frontend mirror the trial feature flag instead of hardcoding it,
// so flipping TRIAL_ENABLED here is the ONLY change needed to switch the
// whole product (checkout behavior + paywall copy) between the launch model
// and the trial campaign. No auth — this is a non-sensitive display flag.
app.get("/api/config", (_req, res) => res.json({ trialEnabled: TRIAL_ENABLED }));

// Observability for the Wall: which rules fire most often tells you exactly
// where the GENERATION PROMPT is weak, so it gets tightened with evidence
// instead of guessing. Internal-key gated (same shared-secret convention as
// every other service-to-service call in this file) since it exposes recent
// violation detail, not meant for the public frontend. Reflects only THIS
// serverless instance's in-memory log since its last cold start — see
// WALL_VIOLATION_LOG's own comment for why that's a debugging aid, not a
// durable cross-invocation analytics store.
app.get("/api/wall-stats", (req, res) => {
  if (!INTERNAL_API_KEY || req.headers["x-internal-key"] !== INTERNAL_API_KEY) {
    return res.status(403).json({ error: "forbidden" });
  }
  const counts = {};
  for (const v of WALL_VIOLATION_LOG) {
    const key = v.ruleId || v.code || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  const topRules = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([ruleId, count]) => ({ ruleId, count }));
  res.json({
    instanceTotalLogged: WALL_VIOLATION_LOG.length,
    topRules,
    recent: WALL_VIOLATION_LOG.slice(-50),
  });
});

// Default express.json() body limit is 100kb — far too small for the roster
// upload endpoint, which sends up to 4 base64-encoded photos in one request.
// A single real phone-camera photo alone can exceed 100kb by 10-50x.
app.use(express.json({ limit: "8mb" }));

const client = new Anthropic();
const FAST_MODEL = "claude-haiku-4-5-20251001";

// Conditional construction, same pattern as `stripe` below — every call site
// already checks process.env.RESEND_API_KEY before touching `resend` (see
// sendPlanEmail, send-otp, contact form, kitchen-select email), so this is
// safe. Unconditional construction here used to crash the process at
// startup with no RESEND_API_KEY set ("Missing API key"), which meant the
// [DEV] OTP-to-console fallback below was actually unreachable in any local
// dev setup that didn't also have a real Resend key configured.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = process.env.FROM_EMAIL || "NutriCrew <crewmealplans@nutricrew.ca>";

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://nutricrew.ca";
// Free trial length before the first real charge — change this one constant to adjust it.
const TRIAL_DAYS = 30;

// Launch monetization model: 1 free pairing (see FREE_PAIRING_LIMIT in
// NutriCrew/server.js), then an immediate paid subscription — no trial. All
// trial mechanics below (trial_period_days at checkout, the webhook's
// trialEnd bookkeeping, the frontend's trial UI copy) stay fully intact and
// are simply skipped while this is false, so setting TRIAL_ENABLED=true
// later (e.g. for a re-engagement campaign) restores the trial flow without
// any code changes. GET /api/config exposes this to the frontend so its
// copy stays in sync with actual checkout behavior.
const TRIAL_ENABLED = process.env.TRIAL_ENABLED === "true";
// The frontend never renders this string (it routes on the "premium_required"
// error code and shows its own localized PremiumScreen copy) — kept flag-
// aware anyway so no trial language survives anywhere a client might log or
// display it verbatim.
const PREMIUM_REQUIRED_MESSAGE = TRIAL_ENABLED
  ? "A Premium subscription is required to generate plans. Start your free month for unlimited plans."
  : "Subscribe for unlimited plans — $7.99/month.";

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

// The 14 EU/UK major-allergen categories (crustaceans+molluscs collapsed into
// one "shellfish" tag to match how this app already models shellfish_free as
// a single diet/allergy checkbox). Used both as the model's own self-report
// (MEAL_SCHEMA.allergens_present) and as the canonical key set the hard
// validator's ingredient/derivative matcher (see ALLERGEN_DERIVATIVES) is
// built around — the two must stay in the same vocabulary so the validator
// can cross-check the model's self-report against its own independent scan.
const ALLERGEN_TAGS = [
  "peanuts", "tree_nuts", "milk", "eggs", "fish", "shellfish", "soy",
  "wheat_gluten", "sesame", "mustard", "celery", "lupin", "sulphites",
];

// Defined here (rather than down with the rest of the title-validation logic
// in the TITLES section) because MEAL_SCHEMA's "name" field description
// needs it at module-load time, before that section runs.
const MAX_TITLE_CONTENT_WORDS = 6;

const MEAL_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["Breakfast", "Lunch", "Dinner", "Snack"] },
    name: {
      type: "string",
      description: `Short, plain menu-style dish name — max ${MAX_TITLE_CONTENT_WORDS} content words (connector words like "with"/"and"/"&"/"the" don't count). Say what the dish IS, not the diet it satisfies (that's a separate tag). Pick ONE distinguishing detail, not two — listing a prep style plus two garnishes almost always overflows the limit. BAD (7 words): "Grilled Chicken Breast with Roasted Zucchini & Olive Tapenade". GOOD (4 words): "Grilled Chicken with Zucchini". GOOD (4 words): "Chicken Breast with Olive Tapenade". Drop a word (protein cut detail, a second garnish, a redundant adjective) whenever a name is running long — the full ingredient list is already shown separately, the name doesn't need to enumerate everything.
NEVER put ANY diet/allergy qualifier in the name — not the current diet, and not a DIFFERENT one either (a common mistake: renaming "Gluten-Free Toast" to "Dairy-Free Toast" still fails, because the fix isn't to swap qualifiers, it's to drop them entirely). BAD: "Scrambled Eggs with Gluten-Free Toast". GOOD (4 words): "Scrambled Eggs with Toast". The bread being gluten-free is already covered by the diet tag — the name only needs to say it's toast.`,
    },
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
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short ingredient name, e.g. \"eggs\", \"spinach\", \"feta cheese\" — specific enough for a crew member to spot a personal allergen." },
          quantity: { type: "number" },
          unit: { type: "string", description: "e.g. g, ml, tbsp, cup, piece, slice" },
        },
        required: ["name", "quantity", "unit"],
        additionalProperties: false,
      },
      description: "EVERY distinct ingredient in this meal, listed separately — never omit one because it seems minor; a crew member's allergy safety and the cost/allergen checks below depend on this list being complete.",
    },
    hero_ingredient: {
      type: "string",
      description: "The single defining main component of this dish, in one or two words, e.g. \"salmon\", \"oats\", \"chicken\", \"tofu\" — what you'd say if someone asked \"what IS this, in one word?\". This is the actual PROTEIN OR PRIMARY COMPONENT of the dish, never the diet name. Used to guarantee real variety across days — a plan that names oats as breakfast twice in three days is exactly the failure mode this field exists to catch.",
    },
    estimated_cost: {
      type: "number",
      description: "Estimated USD-equivalent cost of this meal's ingredients for the crew member's own single portion (not a whole recipe/family size).",
    },
    allergens_present: {
      type: "array",
      items: { type: "string", enum: ALLERGEN_TAGS },
      description: "EVERY major allergen category this meal's ingredients touch, including hidden/derivative sources (e.g. Worcestershire sauce -> fish; soy sauce -> wheat + soy; pesto -> tree_nuts). Empty array only if genuinely none apply. This is cross-checked against the ingredients list — it is not a substitute for keeping ingredients accurate, it's an independent second signal.",
    },
    diet_tags: {
      type: "array",
      items: { type: "string" },
      description: "Diet/lifestyle labels this exact meal fully satisfies, from: vegan, vegetarian, halal, kosher, gluten_free, dairy_free, lactose_free, nut_free, egg_free, shellfish_free, soy_free, sesame_free, low_carb, keto, paleo, carnivore, mediterranean, fodmap. Only include a tag if the meal genuinely, completely satisfies it — do not tag optimistically.",
    },
    prep_method: {
      type: "string",
      enum: ["no_cook", "microwave", "stove_oven", "airplane_provided"],
      description: "The ONE realistic way this meal actually gets made: no_cook = pure assembly/cold, no heating of any kind; microwave = needs a microwave (no stove/oven); stove_oven = needs a stove, oven, or grill; airplane_provided = airline-catered, the crew member doesn't prepare it at all. Must match the KITCHEN ACCESS constraint given above for this meal.",
    },
    tip: { type: "string" },
    recyclingTip: { type: "string" },
    emoji: { type: "string" },
    container: { type: "string", description: "Recommended Tupperware/container size and shape for packing this meal, e.g. '500ml rectangular container' or '300ml round container with dividers'. Only include if a lunch bag size was provided." },
  },
  required: ["type", "name", "description", "prep", "calories", "protein", "carbs", "fat", "tip", "emoji", "ingredients", "hero_ingredient", "estimated_cost", "allergens_present", "diet_tags", "prep_method"],
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

// ── HARD VALIDATOR ──────────────────────────────────────────────────────
// Architecture: the model PROPOSES a plan (structured JSON — see MEAL_SCHEMA,
// which requires ingredients/allergens_present/diet_tags/estimated_cost/
// prep_method so every constraint below is inspectable in code, not prose),
// and this section VALIDATES every constraint deterministically. No plan is
// ever served unless it passes validatePlan() — an LLM follows instructions
// probabilistically and cannot be trusted alone to hard-enforce a
// life-threatening allergy, a diet rule, a calorie/budget target, or a meal
// landing in the right slot. The old approach here (a single best-effort
// regex check + one regeneration attempt, then "serving anyway" if it still
// failed) is exactly the failure mode this replaces.

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── A. ALLERGENS (zero tolerance) ───────────────────────────────────────
// Each pattern covers the obvious word AND its common derivatives/hidden
// sources — the part a prompt-only approach structurally cannot guarantee,
// because it has to catch every alias, not just the ones the model thinks of.
const ALLERGEN_DERIVATIVES = {
  // "satay" is included because it's an opaque name for a peanut-based sauce
  // (Indonesian/Malaysian) — an ingredient literally named "satay sauce" or
  // a dish named "Chicken Satay" contains no other peanut-derivative keyword
  // for this pattern to catch, even though the dish itself is peanut-based.
  peanuts: /\b(peanuts?|peanut butter|groundnuts?|arachis|satay)\b/i,
  tree_nuts: /\b(almonds?|almond butter|walnuts?|cashews?|cashew butter|pecans?|pistachios?|hazelnuts?|filberts?|macadamias?|brazil nuts?|pine nuts?|pignoli|chestnuts?|nutella|marzipan|praline|nut butter|gianduja|frangipane|pesto)\b/i,
  // "butter" excludes nut/seed/fruit "___ butter" compounds (peanut butter,
  // almond butter, apple butter, ...) — those are correctly caught by the
  // tree_nuts/peanuts patterns instead, not dairy; a bare \bbutter\b match
  // was flagging "peanut butter" as a MILK violation, a false positive for
  // any allergen combo that doesn't actually include dairy.
  // Named cheese varieties (parmesan, cheddar, ...) don't contain the literal
  // word "cheese" and were previously missed by the bare `cheeses?` term —
  // verification found "Chicken Caesar Wrap ... parmesan" passing a
  // dairy-allergy check clean. Added explicitly rather than relying on the
  // generic word.
  // "milk" and "yogh?urt" exclude a plant-based qualifier right before them
  // (coconut, oat, almond, soy, cashew, rice, hemp, pea, macadamia) — those
  // are common, everyday dairy-free staples, not dairy in disguise, unlike
  // bare "milk"/"yogurt" which defaults to dairy. Confirmed live 2026-07-20:
  // "oat milk", "unsweetened almond milk", "coconut milk (canned)", and
  // "coconut yogurt" were all BLOCKed as milk allergens for a dairy-free
  // user with zero repair chance — every one of them was the CORRECT,
  // safe choice for that exact restriction.
  milk: /\b(buttermilk|creams?|(?<!(?:peanut|almond|cashew|walnut|pecan|pistachio|hazelnut|macadamia|cocoa|cacao|shea|sunflower|apple|nut|seed|coconut)\s)butter|cheeses?|parmesan|cheddar|mozzarella|brie|feta|gouda|provolone|camembert|gruy[eè]re|halloumi|manchego|goat cheese|cream cheese|cottage cheese|blue cheese|whey|caseinates?|casein|lactose|ghee|custard|gelato|ricotta|mascarpone|paneer|quark|curds?|milk powder|milk solids|condensed milk|evaporated milk|half-and-half)\b|(?<!(?:coconut|oat|almond|soy|cashew|rice|hemp|pea|macadamia)[- ])\b(milk|yogh?urts?)\b/i,
  eggs: /\b(eggs?|egg whites?|egg yolks?|albumin|albumen|ovalbumin|mayonnaise|mayo|hollandaise|b[ée]arnaise|meringue|frittata|quiche|french toast|egg wash|aioli)\b/i,
  fish: /\b(fish|anchov(?:y|ies)|fish sauce|worcestershire(?: sauce)?|bonito|dashi|salmon|tuna|cod|tilapia|sardines?|surimi|imitation crab)\b/i,
  shellfish: /\b(shrimps?|prawns?|crabs?|lobsters?|crayfish|crawfish|clams?|mussels?|oysters?|scallops?|squid|octopus|calamari|shellfish|oyster sauce|shrimp paste)\b/i,
  soy: /\b(soy|soya|soybeans?|edamame|tofu|tempeh|miso|soy sauce|tamari|soy milk|soy lecithin|textured vegetable protein|TVP|natto)\b/i,
  // noodles/crackers/tortillas exclude a "corn"/"rice" qualifier right
  // before them — those are genuinely, factually not wheat-based (corn
  // tortillas, rice noodles, rice crackers are common everyday gluten-free
  // staples), unlike bread/pasta/flour/wraps which have no such common
  // non-wheat default. Confirmed live 2026-07-20: "corn tortilla" was
  // BLOCKed as a wheat_gluten allergen for a gluten-free user with zero
  // repair chance (BLOCK severity never gets repaired) — a false positive
  // on a dish that was correctly, safely gluten-free to begin with.
  // "flour" excludes a common gluten-free flour qualifier right before it
  // (chickpea, almond, coconut, rice, oat, corn, quinoa, cassava, tapioca,
  // potato, sorghum) — those are genuinely gluten-free flour alternatives,
  // not wheat flour in disguise. Confirmed live 2026-07-20: "chickpea
  // flour" (used for vegan pancakes) was BLOCKed as wheat_gluten.
  // "wraps?" was previously missing entirely — a genuinely wheat-based wrap
  // went completely undetected by the ingredient scan, while a "gluten-free
  // wrap" (correctly safe) still got BLOCKed via the self-report signal
  // with no ingredient-level match to contradict it. Added as an always-
  // checked term (like bread/pasta) since, unlike tortillas, there's no
  // common non-wheat "default" wrap the way there is a corn tortilla.
  wheat_gluten: /\b(wheat|breads?|breadcrumbs?|panko|pasta|semolina|couscous|seitan|bulgur|farro|spelt|barley|rye|malt|soy sauce|wraps?)\b|(?<!(?:chickpea|almond|coconut|rice|oat|corn|quinoa|cassava|tapioca|potato|sorghum)\s)\bflour\b|(?<!(?:corn|rice)[- ])\b(noodles?|crackers?|tortillas?)\b/i,
  sesame: /\b(sesame|tahini|halva|za'?\s?atar|benne|gomashio|hummus|baba ganoush)\b/i,
  mustard: /\b(mustard|dijon)\b/i,
  celery: /\b(celery|celeriac)\b/i,
  lupin: /\b(lupine?|lupini)\b/i,
  sulphites: /\b(sulphites?|sulfites?|sulf?ur dioxide)\b/i,
};

// Maps this app's existing allergy/diet checkboxes to the canonical allergen
// tags above. dairy_free is intentionally the zero-tolerance "milk" tag;
// lactose_free is deliberately NOT mapped here — see LACTOSE_PATTERN below.
// Lactose intolerance is dose-dependent and this app's own diet rules
// explicitly allow hard aged cheese and butter for it, so treating it as a
// zero-tolerance allergen would reject perfectly compliant meals.
const USER_ALLERGY_TO_TAGS = {
  nut_free: ["peanuts", "tree_nuts"],
  dairy_free: ["milk"],
  egg_free: ["eggs"],
  shellfish_free: ["shellfish"],
  soy_free: ["soy"],
  gluten_free: ["wheat_gluten"],
  sesame_free: ["sesame"],
};

// Self-compliance phrases (e.g. "gluten-free tamari") that would otherwise
// trip a bare keyword match — checked against ingredient NAMES (discrete
// data) as well as the free-text name/description/tip scan.
// wheat_gluten additionally tolerates underscore/space separators (the model
// sometimes writes "gluten_free bread" instead of "gluten-free bread") and a
// "no ... wheat" negation window (e.g. "almond butter, no added sugar or
// wheat") — confirmed live 2026-07-20: both variants were tripping a
// zero-repair BLOCK on ingredients that were actually, correctly safe.
const ALLERGEN_SELF_LABEL_QUALIFIER = {
  peanuts: /nut-free/i, tree_nuts: /nut-free/i, milk: /dairy-free|milk-free|lactose-free|plant-based/i,
  eggs: /egg-free/i, soy: /soy-free/i,
  wheat_gluten: /gluten[-_ ]free|wheat[-_ ]free|\bno\b(?:(?!\.).){0,40}\bwheat\b/i,
  sesame: /sesame-free|tahini-free/i, shellfish: /shellfish-free/i, fish: /fish-free/i,
};

// Loose, lookbehind-free version of ALLERGEN_DERIVATIVES for the two tags
// (wheat_gluten, milk) whose pattern has a "safe qualifier right before it"
// exemption baked in as a negative lookbehind (corn/rice tortillas, plant
// milks/yogurts) — those exemptions mean a genuinely safe ingredient like
// "gluten-free corn tortilla" produces ZERO matches against the strict
// pattern at all, not a "matched but qualified" case. Used ONLY to judge
// whether a self-reported allergen tag is corroborated/contradicted by the
// ingredient list (see findMealAllergenViolations below) — the strict
// pattern + qualifier stay authoritative for actual pass/fail everywhere
// else. Confirmed live 2026-07-20: "gluten-free corn tortilla" still
// tripped a wheat_gluten self-report BLOCK because the strict pattern's
// corn/rice lookbehind meant patternMatches never saw it at all.
const ALLERGEN_CATEGORY_HINT = {
  wheat_gluten: /\b(wheat|flour|breads?|breadcrumbs?|panko|pasta|semolina|couscous|seitan|bulgur|farro|spelt|barley|rye|malt|soy sauce|noodles?|crackers?|tortillas?|wraps?)\b/i,
  milk: /\b(buttermilk|creams?|butter|cheeses?|parmesan|cheddar|mozzarella|brie|feta|gouda|provolone|camembert|gruy[eè]re|halloumi|manchego|goat cheese|cream cheese|cottage cheese|blue cheese|whey|caseinates?|casein|lactose|ghee|custard|gelato|ricotta|mascarpone|paneer|quark|curds?|milk powder|milk solids|condensed milk|evaporated milk|half-and-half|milk|yogh?urts?)\b/i,
};

// The diet rules explicitly instruct the model to write a cross-
// contamination/safety-check warning in the tip for allergen-adjacent items
// (e.g. "Add a cross-contamination warning in the tip for any seafood...
// item" for shellfish_free, similar wording for nut_free/sesame_free) — the
// resulting advisory sentence ("confirm no sesame-containing ingredients",
// "verify no sesame or sesame-oil in dressing") mentions the allergen word
// as part of a NEGATION, not a stated ingredient, but the bare free-text
// scan can't tell the difference. Confirmed live 2026-07-20: 6/6
// sesame_free test runs BLOCKed a genuinely sesame-free meal purely because
// its own dutifully-written tip said "sesame" in a verification sentence
// ("Scrambled Eggs with Toast" had zero sesame ingredients — the tip just
// said "confirm no sesame-containing ingredients"). Checked as "a negation
// word appears shortly before the match" — the same technique already used
// for wheat_gluten's "no ... wheat" qualifier, generalized here to the
// free-text scan for every tag. Only applied to the free-text scan
// (ingredients are discrete data and don't get this advisory phrasing).
function hasNegationBeforeMatch(text, matchIndex) {
  const before = text.slice(Math.max(0, matchIndex - 40), matchIndex);
  return /\b(no|not|without|free of|zero)\b/i.test(before);
}

function getUserRequiredAllergenAvoidance(data) {
  const rawDiets = Array.isArray(data.diets) ? data.diets : (data.diet ? [data.diet] : []);
  const tags = new Set();
  for (const d of rawDiets) for (const tag of (USER_ALLERGY_TO_TAGS[d] || [])) tags.add(tag);
  const customAllergyTerm = rawDiets.includes("allergy_other")
    ? (data.allergy_other_text || "").trim().slice(0, 100)
    : "";
  return { tags, customAllergyTerm };
}

// Checks ONE meal against the user's required allergen avoidance. Three
// independent signals, any one of which is a hard fail:
//   1. the model's own allergens_present self-report intersecting the
//      required-avoid tags (cheapest, catches honest self-reports the
//      ingredient scan alone might miss),
//   2. a structured ingredient NAME matching a derivative pattern — the
//      primary, most reliable signal, since ingredients are discrete data
//      rather than prose,
//   3. the meal's free-text name/description/tip matching a derivative
//      pattern (catches a hidden allergen the model named in prose but
//      didn't list as a discrete ingredient).
function findMealAllergenViolations(meal, requiredTags, customAllergyTerm) {
  const violations = [];
  const ingredientNames = (meal.ingredients || []).map(i => (typeof i === "string" ? i : i?.name)).filter(Boolean);
  const selfReported = new Set(meal.allergens_present || []);

  for (const tag of requiredTags) {
    const pattern = ALLERGEN_DERIVATIVES[tag];
    const qualifier = ALLERGEN_SELF_LABEL_QUALIFIER[tag];
    // Verification found "gluten-free flour" / "gluten-free rice crackers" as
    // discrete ingredient NAMES still tripping the wheat_gluten ban — the
    // qualifier exemption below only ever ran against the free-text scan, not
    // against the ingredient string itself, even though the qualifying phrase
    // was right there in the same ingredient name.
    const patternMatches = pattern ? ingredientNames.filter(n => pattern.test(n)) : [];
    // Beyond the tag-specific "-free" qualifier, also honor a generic
    // negation right in the ingredient string itself — "fruit jam (no
    // sesame)", "granola (no honey/egg)" — the model routinely writes these
    // instead of "sesame-free"/"egg-free", and previously only wheat_gluten
    // had this covered (via its own qualifier regex). Confirmed live
    // 2026-07-20: both sesame_free and egg_free BLOCKed a meal purely
    // because its own safety-labeled ingredient name used "no X" phrasing.
    const ingHit = patternMatches.find(n => {
      if (qualifier && qualifier.test(n)) return false;
      const m = n.match(pattern);
      return !(m && hasNegationBeforeMatch(n, m.index));
    });
    if (ingHit) {
      violations.push({ code: "ALLERGEN", tag, source: "ingredient", detail: ingHit });
      continue;
    }
    if (selfReported.has(tag)) {
      // Live verification (2026-07-20) found the model reliably self-reporting
      // a tag its OWN ingredient list already clears — e.g. allergens_present
      // includes "wheat_gluten" while the only matching ingredient is
      // "gluten-free bread"/"gluten-free tortilla". This was the single
      // dominant cause of "Day X couldn't be generated": BLOCK severity never
      // gets a repair chance, so one careless self-report tag killed the
      // whole day outright. Only trust the self-report when the ingredient
      // list gives it no explanation to contradict — checked via the loose
      // category hint (falls back to the strict pattern for tags with no
      // hint entry) so a corn/rice-exempted tortilla or a plant-milk/yogurt
      // still counts as "explained", not just a qualifier-exempted match.
      // That's still how a genuinely hidden/derivative allergen (e.g.
      // Worcestershire -> fish, not spelled out as a discrete ingredient)
      // keeps getting caught.
      const hint = ALLERGEN_CATEGORY_HINT[tag];
      const hasIngredientExplanation = hint ? ingredientNames.some(n => hint.test(n)) : patternMatches.length > 0;
      if (hasIngredientExplanation) continue;
      violations.push({ code: "ALLERGEN", tag, source: "self_report", detail: `model self-reported allergens_present includes "${tag}"` });
      continue;
    }
    if (!pattern) continue;
    // Only run the free-text scan as an INDEPENDENT check when the ingredient
    // list said nothing about this pattern at all. If it did (and every match
    // was self-qualified, e.g. "gluten-free rice crackers"), a bare restatement
    // in the dish's own name/description (e.g. a meal literally named "Rice
    // Crackers") is just that same already-cleared ingredient, not a newly
    // discovered hidden allergen — verification found "Rice Crackers" tripping
    // this exact false positive via its own name.
    // Deliberately excludes meal.tip — the diet rules explicitly instruct
    // the model to write cross-contamination/logistics advisories INTO the
    // tip field ("Add a cross-contamination warning in the tip..."), so tip
    // content is systematically about safety verification, not stated dish
    // content. Confirmed live 2026-07-20: even with the negation-window
    // check above, tip phrasings kept slipping through in shapes it didn't
    // catch ("avoid cross-contact with shellfish-handling surfaces", "your
    // shellfish allergy does not affect this snack", "given your shellfish
    // allergy profile") — none of these state the meal contains shellfish,
    // they're all restating the user's OWN restriction back at them. A
    // genuine hidden allergen (e.g. Worcestershire -> fish) would still show
    // up in name/description, which describe the dish itself.
    if (patternMatches.length === 0) {
      const text = [meal.name, meal.description].filter(Boolean).join(" ");
      const match = text.match(pattern);
      if (match) {
        if (qualifier && qualifier.test(text)) continue;
        if (hasNegationBeforeMatch(text, match.index)) continue;
        violations.push({ code: "ALLERGEN", tag, source: "text", detail: match[0] });
      }
    }
  }

  if (customAllergyTerm) {
    // "s?" tolerates a simple plural (e.g. "kiwi" also catches "kiwis") — not
    // full stemming, but cheap insurance against the most common miss.
    const re = new RegExp(`\\b${escapeRegExp(customAllergyTerm)}s?\\b`, "i");
    const ingHit = ingredientNames.find(n => re.test(n));
    const text = [meal.name, meal.description].filter(Boolean).join(" ");
    const match = ingHit ? [ingHit] : text.match(re);
    if (match) violations.push({ code: "ALLERGEN", tag: "allergy_other", source: ingHit ? "ingredient" : "text", detail: match[0] });
  }

  return violations;
}

// ─── C. DIET COMPLIANCE (ingredient-prohibition diets, non-allergen) ────
const MEAT_WORDS = /\b(beef|chicken|turkey|lamb|veal|duck|goose|pork|sausages?|bacon|hams?|pastrami|salami|jerky|meat|poultry|prosciutto|pepperoni|chorizo)\b/i;
const HONEY_GELATIN_WORDS = /\b(honey|gelatine?)\b/i;
// bacon/ham/pepperoni/chorizo/salami/sausage are ambiguous — every one of
// them has a common, everyday non-pork version (turkey bacon, chicken
// sausage, beef pepperoni, beef salami) and halal/kosher meal prompts
// routinely produce exactly those. Only exempt when explicitly qualified by
// a non-pork species word right before it; "sausage" alone with no
// qualifier stays banned (ambiguous defaults to pork in most food contexts,
// so still needs a repair). pork/lard/prosciutto/pancetta have no non-pork
// variant and are always banned. Confirmed live 2026-07-20: "Turkey
// Sausage" / "Halal Sausage" / "Chicken Sausage" were all rejected purely
// for containing the word "sausage", regardless of the explicit qualifier.
const PORK_WORDS = /\b(pork|lard|prosciutto|pancetta)\b|(?<!(?:turkey|chicken|beef|lamb|veal|duck|goose|halal)[- ])\b(bacon|hams?|pepperoni|chorizo|salami|sausages?)\b/i;
// Excludes "___ vinegar" compounds (red wine vinegar, sherry vinegar, rice
// wine vinegar, ...) — vinegar-making converts the alcohol to acetic acid,
// so it isn't the alcoholic beverage the halal ban is about. Found via
// verification: a chimichurri's red wine vinegar was tripping a false
// halal violation on an otherwise completely halal-compliant sauce.
const ALCOHOL_WORDS = /\b(wine|beer|rum|vodka|whisk(?:e)?y|sake|sherry|marsala|liqueur|alcohol|brandy|champagne)\b(?!\s*vinegar)/i;
const LACTOSE_PATTERN = /\b(milk|creams?|soft cheese|ice cream|yogh?urt)\b/i;
// "butter" excludes nut/seed "___ butter" compounds — paleo explicitly
// allows nuts/seeds (and their butters), so a bare \bbutter\b would wrongly
// flag "almond butter" as the banned dairy butter.
const PALEO_PROHIBITED = /\b(wheat|breads?|pasta|rice|oats|corn|barley|rye|beans?|lentils?|chickpeas?|peanuts?|soy|tofu|milk|creams?|(?<!(?:peanut|almond|cashew|walnut|pecan|pistachio|hazelnut|macadamia|sunflower|seed)\s)butter|cheeses?|yogh?urt|refined sugar|white sugar|brown sugar|corn syrup)\b/i;
const FODMAP_PROHIBITED = /\b(onions?|garlic|wheat|beans?|lentils?|apples?|pears?|mango(?:es)?|watermelon|honey|high[- ]fructose corn syrup|soft cheese|cashews?|pistachios?)\b/i;
// "salad" excludes tuna/chicken/egg/ham/salmon salad — common mayo-based
// dish names with zero actual vegetables (tuna + mayo is fully carnivore-
// compliant). Confirmed live 2026-07-20: "Canned Tuna Salad with Mayo" (no
// vegetable ingredient anywhere in the meal) was rejected purely because
// the word "salad" appeared in the name, looping the same false-positive
// rejection across every repair attempt since the model correctly kept
// insisting the dish — genuinely compliant — didn't need to change.
const CARNIVORE_PLANT_HINT = /\b(vegetables?|fruit|grains?|rice|breads?|pasta|beans?|lentils?|nuts?|seeds?|sugar|vegetable oil|olive oil|potatoes?|greens?)\b|(?<!(?:tuna|chicken|egg|ham|salmon|crab|shrimp)\s)\bsalad\b/i;

// diet checkbox id -> banned-ingredient regex. Deliberately excludes
// gluten_free/dairy_free/nut_free/egg_free/shellfish_free/soy_free/
// sesame_free — those are handled with zero-tolerance ALLERGEN severity
// above (section A), not here, so a violation isn't checked twice.
const DIET_PROHIBITED = {
  vegan: new RegExp([MEAT_WORDS.source, ALLERGEN_DERIVATIVES.fish.source, ALLERGEN_DERIVATIVES.shellfish.source, ALLERGEN_DERIVATIVES.milk.source, ALLERGEN_DERIVATIVES.eggs.source, HONEY_GELATIN_WORDS.source].join("|"), "i"),
  vegetarian: new RegExp([MEAT_WORDS.source, ALLERGEN_DERIVATIVES.fish.source, ALLERGEN_DERIVATIVES.shellfish.source, "gelatine?"].join("|"), "i"),
  halal: new RegExp([PORK_WORDS.source, ALCOHOL_WORDS.source].join("|"), "i"),
  lactose_free: LACTOSE_PATTERN,
  paleo: PALEO_PROHIBITED,
  fodmap: FODMAP_PROHIBITED,
  carnivore: CARNIVORE_PLANT_HINT,
};

// Same self-label false-positive class as ALLERGEN_SELF_LABEL_QUALIFIER
// above, for DIET_PROHIBITED: "Sugar-Free Beef Jerky" — a meal explicitly
// labeled to comply with the diet — was still tripping carnivore's bare
// "sugar" ban on its own self-declaration. Confirmed live 2026-07-20 that
// the model, when told exactly to write "sugar-free beef jerky" (per the
// carnivore diet prompt's own trap-avoidance guidance), got flagged anyway
// and looped on the same violation across repair attempts.
const DIET_SELF_LABEL_QUALIFIER = {
  carnivore: /sugar-free|sugar free|no sugar added|unsweetened/i,
};

// Kosher's core rule isn't "banned ingredient present" like an allergy — it's
// "meat and dairy never in the SAME meal", plus the usual no-pork/no-shellfish.
const KOSHER_DAIRY_WORDS = /\b(cheeses?|milk|creams?|butter|yogh?urt|whey|ghee)\b/i;

function findMealDietViolations(meal, activeDietTags) {
  const violations = [];
  const ingredientNames = (meal.ingredients || []).map(i => (typeof i === "string" ? i : i?.name)).filter(Boolean);
  const text = [meal.name, meal.description, ...ingredientNames].filter(Boolean).join(" ");

  for (const diet of activeDietTags) {
    const pattern = DIET_PROHIBITED[diet];
    if (!pattern) continue;
    const match = text.match(pattern);
    if (match) {
      const qualifier = DIET_SELF_LABEL_QUALIFIER[diet];
      if (qualifier && qualifier.test(text)) continue;
      violations.push({ code: "DIET", dietTag: diet, detail: match[0] });
    }
  }

  if (activeDietTags.includes("kosher")) {
    if (MEAT_WORDS.test(text) && KOSHER_DAIRY_WORDS.test(text)) {
      violations.push({ code: "DIET", dietTag: "kosher", detail: "meat and dairy combined in one meal" });
    }
    const porkMatch = text.match(PORK_WORDS);
    if (porkMatch) violations.push({ code: "DIET", dietTag: "kosher", detail: porkMatch[0] });
    const shellfishMatch = text.match(ALLERGEN_DERIVATIVES.shellfish);
    if (shellfishMatch) violations.push({ code: "DIET", dietTag: "kosher", detail: shellfishMatch[0] });
  }

  return violations;
}

const LOW_CARB_DAILY_LIMIT_G = 50;

// ─── B. MEAL SLOT / STRUCTURE ─────────────────────────────────────────────
// "Dinner should be a substantial main, not an appetizer" and "no dinner-
// style dish under Breakfast" survived repeated explicit prompt prohibition
// and still recurred (production example: canned sardines served as
// "Mediterranean Greek Yogurt Parfait" breakfast, twice in one pairing) —
// a keyword check on the actual proposed content is the only way to catch
// it deterministically instead of trusting the model to self-police its
// own slot. The model optimizes for constraint satisfaction (diet tag +
// macros) with no concept of what a human eats at a given time of day;
// this table encodes that concept explicitly, per slot, in code.
const APPETIZER_MEAL_PATTERN = /\b(carpaccio|charcuterie|antipasto|tartare|crudo)\b|\b(cheese|charcuterie|cured meat|cold cuts?)\s+(plate|platter|board)\b|\bprosciutto-wrapped\b/i;
// Canned/oily fish, shellfish, dense red meat, and dinner-format plated
// dishes (stews, curries, pasta, rice-and-meat, casseroles) are never a
// normal breakfast, regardless of how well they otherwise satisfy the
// diet/macro targets — "smoked salmon on a bagel" IS a normal breakfast, so
// salmon is deliberately NOT on this list; sardines/anchovies/mackerel/tuna
// (typically eaten as a savory lunch/dinner protein or canned pantry item,
// not a breakfast one) are.
const DINNER_STYLE_AT_BREAKFAST_PATTERN = /\b(shawarma|kebabs?|curr(?:y|ies)|stir-?fry|burgers?|steaks?|schnitzel|tagine|casserole|lasagn?a|risotto|rice bowl|burritos?|tacos?|fajitas?|chili|pot pie|meatballs?|gyros?|sardines?|anchov(?:y|ies)|mackerel|tuna|shrimps?|prawns?|crabs?|lobsters?|scallops?|mussels?|oysters?|calamari|squid|roasts?|pot roasts?|stews?|pastas?|spaghettis?|penne|fettuccine|linguine|rice and (?:chicken|beef|pork|meat)|soups?)\b/i;
// Congee (savory rice porridge) is a legitimate, common breakfast format —
// exempt it from the bare "soup(s)" match above.
const BREAKFAST_SOUP_EXEMPT_PATTERN = /congee/i;
const BREAKFAST_STYLE_AT_DINNER_PATTERN = /\b(pancakes?|waffles?|cereal|granola bowl|oatmeal|overnight oats|porridge|bagel (?:with|and) (?:cream cheese|lox)|smoothie bowl|french toast)\b/i;
// Dessert standing in as the ENTIRE meal (not a side/snack) isn't a lunch
// or dinner, regardless of calories/macros. "cakes" excludes a "rice"
// qualifier right before it — rice cakes are a common savory snack/side
// (e.g. "Tuna Salad with Rice Cakes"), not a dessert. Confirmed live
// 2026-07-20: this was a recurring cross-day-repair failure that never
// converged because the model kept reaching for rice cakes as a plain,
// GF-safe side and the bare "cakes" match rejected it every time.
const DESSERT_AS_MEAL_PATTERN = /\b(pies?|ice cream|cookies?|brownies?|cupcakes?)\b|(?<!rice[- ])\bcakes?\b/i;
// A "snack" that's actually a full dinner-format plated main defeats the
// point of the slot — this is the inverse problem of the appetizer-as-
// dinner check above (there, small-plate content in a main-meal slot is
// wrong; here, main-meal content in a snack slot is wrong).
const HEAVY_MAIN_AS_SNACK_PATTERN = /\b(roasts?|stews?|curr(?:y|ies)|casserole|lasagn?a|risotto|pot pie)\b/i;

function findMealSlotContentViolation(meal) {
  const text = [meal.name, meal.description].filter(Boolean).join(" ");
  if (meal.type === "Lunch" || meal.type === "Dinner") {
    const m = text.match(APPETIZER_MEAL_PATTERN);
    if (m) return { code: "MEAL_SLOT_CONTENT", detail: `"${m[0]}" is appetizer/small-plate scale, not a complete ${meal.type}` };
    const bm = text.match(BREAKFAST_STYLE_AT_DINNER_PATTERN);
    if (bm) return { code: "MEAL_SLOT_CONTENT", detail: `"${bm[0]}" is a breakfast-style dish, not appropriate for ${meal.type}` };
    const dm = text.match(DESSERT_AS_MEAL_PATTERN);
    if (dm) return { code: "MEAL_SLOT_CONTENT", detail: `"${dm[0]}" is dessert standing in as the entire meal, not appropriate for ${meal.type}` };
  }
  if (meal.type === "Breakfast") {
    const m = text.match(DINNER_STYLE_AT_BREAKFAST_PATTERN);
    if (m && !(/^soups?$/i.test(m[0]) && BREAKFAST_SOUP_EXEMPT_PATTERN.test(text))) {
      return { code: "MEAL_SLOT_CONTENT", detail: `"${m[0]}" is a lunch/dinner-style dish, not appropriate for Breakfast` };
    }
  }
  if (meal.type === "Snack") {
    const m = text.match(HEAVY_MAIN_AS_SNACK_PATTERN);
    if (m) return { code: "MEAL_SLOT_CONTENT", detail: `"${m[0]}" is a full dinner-format main, not appropriate for a Snack` };
  }
  return null;
}

// Structural slot counts expected per day — kept in sync with the same goal
// logic buildAllDaysPrompt itself is built from.
function getExpectedMealStructure(ctx) {
  if (!ctx.calorieTarget && !ctx.gainTarget && ctx.maintenanceTarget) {
    return { breakfast: 1, lunch: 1, dinner: 1, snackMin: 2, snackMax: 2 };
  }
  if (ctx.gainTarget) return { breakfast: 1, lunch: 1, dinner: 1, snackMin: 2, snackMax: 4 };
  return { breakfast: 1, lunch: 1, dinner: 1, snackMin: 1, snackMax: 2 };
}

function findDayStructureViolations(meals, expected) {
  const violations = [];
  const counts = { Breakfast: 0, Lunch: 0, Dinner: 0, Snack: 0 };
  for (const m of meals || []) { if (counts[m.type] !== undefined) counts[m.type]++; }
  if (counts.Breakfast !== expected.breakfast) violations.push({ code: "MEAL_SLOT_STRUCTURE", detail: `expected ${expected.breakfast} Breakfast, got ${counts.Breakfast}` });
  if (counts.Lunch !== expected.lunch) violations.push({ code: "MEAL_SLOT_STRUCTURE", detail: `expected ${expected.lunch} Lunch, got ${counts.Lunch}` });
  if (counts.Dinner !== expected.dinner) violations.push({ code: "MEAL_SLOT_STRUCTURE", detail: `expected ${expected.dinner} Dinner, got ${counts.Dinner}` });
  if (counts.Snack < expected.snackMin || counts.Snack > expected.snackMax) {
    violations.push({ code: "MEAL_SLOT_STRUCTURE", detail: `expected ${expected.snackMin}-${expected.snackMax} Snack(s), got ${counts.Snack}` });
  }
  return violations;
}

// ─── CROSS-DAY VARIETY ─────────────────────────────────────────────────────
// The sardines-at-breakfast bug repeated on consecutive days precisely
// because nothing checked ACROSS days — each day is generated and validated
// independently (in parallel, for latency). This is a deliberately small,
// ordered list of PROTEIN/defining-component categories, checked by name
// first (the most reliable "what this dish actually is" signal) and falling
// back to ingredients — good enough to catch "the same hero twice in a row,"
// which is the actual failure mode, without needing to solve general dish
// classification.
const HERO_CATEGORY_PATTERNS = [
  ["sardines", /\bsardines?\b/i],
  ["anchovy", /\banchov(?:y|ies)\b/i],
  ["mackerel", /\bmackerel\b/i],
  ["tuna", /\btuna\b/i],
  ["salmon", /\bsalmon\b/i],
  ["shellfish", ALLERGEN_DERIVATIVES.shellfish],
  ["bacon", /\bbacon\b/i],
  ["sausage", /\bsausages?\b/i],
  ["ham", /\bhams?\b/i],
  ["chicken", /\bchicken\b/i],
  ["turkey", /\bturkey\b/i],
  ["beef_steak", /\b(beef|steaks?)\b/i],
  ["pork", /\bpork\b/i],
  ["lamb", /\blamb\b/i],
  ["tofu_tempeh", /\b(tofu|tempeh)\b/i],
  ["eggs", /\b(eggs?|omelett?e|frittata|shakshuka)\b/i],
  ["yogurt", /\byogh?urt\b/i],
  ["oats", /\b(oats?|oatmeal|overnight oats|porridge|granola)\b/i],
  ["cheese", /\bcheeses?\b/i],
  ["beans_lentils", /\b(beans?|lentils?|chickpeas?)\b/i],
  ["fish_generic", /\bfish\b/i],
];

function getMealHeroCategory(meal) {
  const name = meal.name || "";
  for (const [category, pattern] of HERO_CATEGORY_PATTERNS) {
    if (pattern.test(name)) return category;
  }
  const ingredientText = (meal.ingredients || []).map(i => (typeof i === "string" ? i : i?.name)).filter(Boolean).join(" ");
  for (const [category, pattern] of HERO_CATEGORY_PATTERNS) {
    if (pattern.test(ingredientText)) return category;
  }
  return null;
}

function extractWithClause(title) {
  const m = (title || "").match(/\bwith\s+(.+)$/i);
  return m ? m[1].trim().toLowerCase() : null;
}

// Catches "... with Sardines & Olive Oil Drizzle" repeating verbatim (or a
// fully identical title) across days, even on the rare occasion the hero
// category heuristic above doesn't line up the same way.
function titlesShareSignificantPattern(titleA, titleB) {
  if (!titleA || !titleB) return false;
  if (titleA.trim().toLowerCase() === titleB.trim().toLowerCase()) return true;
  const wa = extractWithClause(titleA);
  const wb = extractWithClause(titleB);
  return !!(wa && wb && wa === wb);
}

// Runs across the WHOLE assembled plan (all days), not per-day — days are
// generated independently/in parallel for latency, so this is the only
// place a same-slot repeat across consecutive days can be caught at all.
// Only Breakfast/Lunch/Dinner are compared (exactly one per day, so "same
// slot on consecutive days" is unambiguous); Snacks are excluded since a
// day can have 1-4 of them with no fixed ordering to compare against.
function findCrossDayVarietyViolations(days) {
  const violations = [];
  const slots = ["Breakfast", "Lunch", "Dinner"];
  const bySlot = Object.fromEntries(slots.map(s => [s, []]));
  for (const day of days || []) {
    if (!day || day.failed || !Array.isArray(day.meals)) continue;
    for (const slot of slots) {
      const mealIndex = day.meals.findIndex(m => m.type === slot);
      if (mealIndex === -1) continue;
      bySlot[slot].push({ dayNum: day.day, mealIndex, meal: day.meals[mealIndex] });
    }
  }
  for (const slot of slots) {
    const entries = bySlot[slot];
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1];
      const cur = entries[i];
      const prevHero = getMealHeroCategory(prev.meal);
      const curHero = getMealHeroCategory(cur.meal);
      if (prevHero && curHero && prevHero === curHero) {
        violations.push({
          code: "CROSS_DAY_VARIETY", day: cur.dayNum, mealIndex: cur.mealIndex, mealType: slot, mealName: cur.meal.name,
          detail: `hero ingredient "${curHero}" repeats in ${slot} from Day ${prev.dayNum} ("${prev.meal.name}") to Day ${cur.dayNum}`,
        });
      } else if (titlesShareSignificantPattern(prev.meal.name, cur.meal.name)) {
        violations.push({
          code: "CROSS_DAY_VARIETY", day: cur.dayNum, mealIndex: cur.mealIndex, mealType: slot, mealName: cur.meal.name,
          detail: `title pattern repeats in ${slot} from Day ${prev.dayNum} ("${prev.meal.name}") to Day ${cur.dayNum} ("${cur.meal.name}")`,
        });
      }
    }
  }
  return violations;
}

// ─── PORTION SCALE ──────────────────────────────────────────────────────────
// A "snack" that's calorie/component-heavy enough to be a full meal, or a
// Lunch/Dinner light enough to be a snack, defeats the slot just as much as
// serving the wrong FORMAT of food does.
const SNACK_MAX_CALORIE_SHARE = 0.20;
const MAIN_MIN_CALORIE_SHARE = 0.15;
const SNACK_MAX_INGREDIENTS = 6;
const MAIN_MIN_INGREDIENTS = 2;

function findMealPortionScaleViolation(meal, dailyTarget) {
  const ingredientCount = (meal.ingredients || []).length;
  if (meal.type === "Snack") {
    if (dailyTarget && meal.calories > dailyTarget * SNACK_MAX_CALORIE_SHARE) {
      return { code: "PORTION_SCALE", detail: `${meal.calories} kcal is ${Math.round((meal.calories / dailyTarget) * 100)}% of the daily target — too large to be a Snack (full-meal scale)` };
    }
    if (ingredientCount > SNACK_MAX_INGREDIENTS) {
      return { code: "PORTION_SCALE", detail: `${ingredientCount} ingredients is too many components for a Snack` };
    }
  }
  if (meal.type === "Lunch" || meal.type === "Dinner") {
    if (dailyTarget && meal.calories < dailyTarget * MAIN_MIN_CALORIE_SHARE) {
      return { code: "PORTION_SCALE", detail: `${meal.calories} kcal is only ${Math.round((meal.calories / dailyTarget) * 100)}% of the daily target — too small to be a complete ${meal.type}` };
    }
    if (ingredientCount < MAIN_MIN_INGREDIENTS) {
      return { code: "PORTION_SCALE", detail: `only ${ingredientCount} ingredient(s) — too sparse to be a complete ${meal.type}` };
    }
  }
  return null;
}

// ─── TITLES ─────────────────────────────────────────────────────────────────
// Titles were reading as diet-compliance statements ("Mediterranean Greek
// Yogurt Parfait with Sardines...") instead of what a menu would say. The
// diet is already shown as a tag chip elsewhere — the title's only job is to
// say what the dish IS.
// MAX_TITLE_CONTENT_WORDS is defined earlier, near ALLERGEN_TAGS — MEAL_SCHEMA
// needs it before this section runs.
// Connector words don't count toward the length cap — "Greek Yogurt Parfait
// with Berries & Granola" is 5 content words (Greek/Yogurt/Parfait/Berries/
// Granola), not 7.
const TITLE_STOPWORDS = new Set(["with", "and", "&", "in", "of", "the", "a", "an", "on", "over", "topped"]);
const DIET_NAME_IN_TITLE_PATTERN = /\b(mediterranean|vegan|vegetarian|keto|paleo|halal|kosher|carnivore|fodmap|gluten[- ]free|dairy[- ]free|lactose[- ]free|nut[- ]free|egg[- ]free|shellfish[- ]free|soy[- ]free|sesame[- ]free|low[- ]carb|calorie deficit)\b/i;

function findMealTitleViolation(meal) {
  const name = (meal.name || "").trim();
  if (!name) return { code: "TITLE", detail: "meal has no name" };
  const contentWordCount = name.split(/\s+/).filter(w => w && !TITLE_STOPWORDS.has(w.toLowerCase())).length;
  if (contentWordCount > MAX_TITLE_CONTENT_WORDS) {
    return { code: "TITLE", detail: `"${name}" is ${contentWordCount} content words, over the ${MAX_TITLE_CONTENT_WORDS}-word limit` };
  }
  const dietMatch = name.match(DIET_NAME_IN_TITLE_PATTERN);
  if (dietMatch) {
    // Confirmed live 2026-07-20: told only "don't name the diet," the model
    // reliably swapped ONE diet-name violation for ANOTHER instead of
    // dropping the qualifier — "Scrambled Eggs with Gluten-Free Toast" ->
    // repair -> "Scrambled Eggs with Dairy-Free Toast" -> repair (still
    // violates) -> back to "...Gluten-Free Toast", exhausting
    // REPAIR_ATTEMPTS in a loop that never converges. Computing and handing
    // over the EXACT corrected string (diet term stripped, whitespace
    // collapsed) removes the guessing entirely, same fix class as the
    // 6-word-limit BAD/GOOD examples below.
    const suggestedName = name.replace(dietMatch[0], "").replace(/\s{2,}/g, " ").trim();
    return {
      code: "TITLE",
      detail: `"${name}" names the diet ("${dietMatch[0]}") — the diet is already shown as a tag, the title should just say what the dish is`,
      suggestedName,
    };
  }
  return null;
}

// ─── ICON SANITY ────────────────────────────────────────────────────────────
// Production example: a Day 2 Breakfast displayed a fish emoji (accurately —
// the meal's hero WAS a tin of sardines, itself the underlying bug). Once
// the hero-ingredient check above blocks that content, a mismatched icon
// mostly can't happen for the same meal — this catches the residual case of
// a raw-fish/sushi/shellfish-style icon on a Breakfast even when the
// ingredients text alone didn't trip the slot-content check.
// Breakfast-only, NOT Snack: DINNER_STYLE_AT_BREAKFAST_PATTERN above (and the
// prompt itself, for carnivore/keto/paleo) treats canned sardines/tuna/salmon
// as a perfectly normal Snack — banning the fish emoji there too put this
// rule in direct conflict with content the model is explicitly told to
// generate, so a fish-based Snack could never pass repair: the model kept
// proposing the (correct) fish emoji, this rule kept rejecting it, on repeat
// across unrelated production requests until REPAIR_ATTEMPTS ran out and the
// whole day failed. Confirmed live 2026-07-20 against "Canned Sardines in
// Oil" / "Canned Salmon with Butter" Snacks failing this exact way.
const SEAFOOD_ICON_PATTERN = /[🐟🐠🦐🦀🦞🐙🦑🍣🍤]/u;
function findMealIconViolation(meal) {
  if (meal.type !== "Breakfast") return null;
  const emoji = meal.emoji || "";
  if (!SEAFOOD_ICON_PATTERN.test(emoji)) return null;
  const text = [meal.name, meal.description].filter(Boolean).join(" ");
  if (/smoked salmon|lox/i.test(text)) return null; // smoked salmon bagel is a normal breakfast
  return { code: "ICON", detail: `emoji "${emoji}" is a seafood/sushi icon, not appropriate for ${meal.type}` };
}

// ─── F. KITCHEN ACCESS ────────────────────────────────────────────────────
const KITCHEN_PREP_METHOD_ALLOW = {
  full_kitchen: ["no_cook", "microwave", "stove_oven"],
  hotel: ["no_cook"],
  microwave: ["no_cook", "microwave"],
  fridge: ["no_cook"],
  airplane_food: ["airplane_provided"],
};

function findMealKitchenViolation(meal, kitchenList) {
  const list = (Array.isArray(kitchenList) ? kitchenList : [kitchenList]).filter(Boolean);
  if (list.length === 0) return null;
  // Multi-access days (e.g. hotel + airplane_food) — a meal is fine as long
  // as its prep_method is realistic under AT LEAST ONE of the day's access
  // types (matches the "apply whichever single type fits" prompt rule).
  const allowedAcrossDay = new Set(list.flatMap(k => KITCHEN_PREP_METHOD_ALLOW[k] || []));
  if (allowedAcrossDay.size === 0) return null;
  if (!allowedAcrossDay.has(meal.prep_method)) {
    return {
      code: "KITCHEN",
      detail: `prep_method "${meal.prep_method}" isn't achievable with kitchen access [${list.join(", ")}]`,
      allowedMethods: [...allowedAcrossDay],
    };
  }
  return null;
}

// ─── G. CUSTOMS / CARRIED FOOD ────────────────────────────────────────────
// Deliberately conservative: only the categories that are unambiguous across
// every BORDER_COUNTRY_RULES entry (fresh produce, raw meat, raw egg). A
// meal is exempt if its own tip matches the "buy locally / consume before
// next flight" phrasing the prompt already instructs the model to use for
// same-stop, non-carried meals (see buildCarriedFoodPromptBlock).
// "___ juice" excluded from the fruit-name group — orange/apple/grape juice
// are processed, typically shelf-stable/pasteurized liquid products, not
// the whole fresh fruit the ban is actually about. Confirmed live
// 2026-07-22: "orange juice" and "orange juice, commercially packaged"
// both still tripped this ban and survived a repair attempt unresolved.
const CARRIED_BAN_CATEGORY_PATTERNS = [
  /\bfresh (fruit|vegetables?|produce)\b/i,
  // "peach(?:es)?" not "peaches?" — the latter only matches "peache"/"peaches",
  // never singular "peach" (the "?" only makes the trailing "s" optional).
  /\b(apples?|oranges?|mangoe?s?|bananas?|grapes?|berr(?:y|ies)|peach(?:es)?|pears?)\b(?!\s+juice)/i,
  /\braw (chicken|beef|pork|meat|fish|eggs?)\b/i,
  /\b(uncooked|unpasteurized) (meat|dairy|milk|cheese)\b/i,
];
const LOCALLY_PURCHASED_TIP_PATTERN = /buy locally|consume before|do not pack|eat before the next flight/i;
// The prompt explicitly instructs the model to use "ONLY commercially
// packaged/sealed, canned, dried, or shelf-stable ingredients" for carried
// items (see buildCarriedFoodPromptBlock) — a compliant "canned peaches in
// light syrup" is exactly what it's supposed to produce, not a violation.
// Production 504: this false positive triggered an unnecessary repair round
// that pushed a real request over Vercel's function timeout.
// "commercially packaged/sealed", "pasteurized", "boxed", "bottled" added
// 2026-07-22 — the model was using this EXACT phrasing (as the prompt
// itself instructs) but it wasn't recognized as a qualifier, so a
// genuinely compliant "orange juice, commercially packaged" still failed.
const SHELF_STABLE_QUALIFIER = /\b(canned|tinned|dried|dehydrated|jarred|vacuum-sealed|shelf-stable|freeze-dried|preserved|pickled|commercially packaged|commercially sealed|pasteurized|boxed|bottled)\b/i;

function findMealCustomsViolation(meal, restrictedBorders, kitchenList) {
  if (!restrictedBorders || restrictedBorders.length === 0) return null;
  if (meal.prep_method === "airplane_provided") return null; // airline-catered, not personally carried
  if (LOCALLY_PURCHASED_TIP_PATTERN.test(meal.tip || "")) return null;
  // A meal cooked with full home-kitchen access is presumed eaten fresh at
  // home, not packed into the travel bag — except Snacks, which are the one
  // meal type genuinely likely to be packed along regardless of kitchen
  // access (that's what "pack a snack for the flight" means). Verification
  // found this flagging an entirely ordinary home-cooked "banana in oatmeal"
  // Breakfast for any pairing that merely touched a restricted border at
  // all (which is nearly every pairing with a Canadian home base, since the
  // crew member's own return home already counts) — the check needs to
  // distinguish "cooked and eaten at home" from "packed for the trip."
  const isHomeCookedNonSnack = meal.type !== "Snack"
    && Array.isArray(kitchenList) && kitchenList.length === 1 && kitchenList[0] === "full_kitchen";
  if (isHomeCookedNonSnack) return null;
  const ingredientNames = (meal.ingredients || []).map(i => (typeof i === "string" ? i : i?.name)).filter(Boolean);
  for (const pattern of CARRIED_BAN_CATEGORY_PATTERNS) {
    const hit = ingredientNames.find(n => pattern.test(n) && !SHELF_STABLE_QUALIFIER.test(n));
    if (hit) return { code: "CUSTOMS", detail: `"${hit}" likely can't be carried across this pairing's restricted borders` };
  }
  return null;
}

function computeMealCost(meal) {
  return typeof meal.estimated_cost === "number" ? meal.estimated_cost : 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── THE WALL — LAYER 1: DETERMINISTIC RULE REGISTRY ────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// Design principle: the model PROPOSES a plan, this registry VERIFIES it, and
// nothing unverified reaches a user. Rules live here as a REGISTRY, not an
// if-chain — the whole point is that a new production bug becomes ONE new
// entry, permanently, instead of another prompt tweak the model complies
// with only probabilistically (see git history: this exact bug class —
// sardines-for-breakfast — recurred through three separate prompt-only
// fixes before this file existed).
//
// Rule shape: { id, severity, scope, check(subject, ruleCtx) -> {pass, violations[]}, message(violation) -> string }
//   scope "meal": subject = one meal object. Called once per meal.
//   scope "day":  subject = that day's meals array. Called once per day.
//   scope "plan": subject = the whole assembled `days` array. Called once.
//   ruleCtx bundles the raw user profile plus every DERIVED value a rule
//   might need (allergen tags, active diet tags, calorie/budget targets,
//   kitchen access, restricted borders) — richer than "userProfile" alone,
//   since most checks depend on values computed from it, not the raw fields.
//
// SEVERITY governs what happens next (see runWallOnMeal/generateOneDay):
//   BLOCK  = never show, never repair-loop past it. Fail closed immediately.
//            Reserved for allergens — a missing plan is an inconvenience,
//            an allergen violation is a medical emergency.
//   REPAIR = send the violation back to the model and regenerate (bounded
//            retries — see REPAIR_ATTEMPTS). Still refuses to serve if every
//            attempt still fails.
//   WARN   = logged for observability, never blocks or triggers repair. Used
//            sparingly — currently only hero_ingredient_agreement, since the
//            independent-inference check is heuristic and can disagree with
//            a genuinely correct model answer.
// Two specific carnivore traps, and three specific vegan traps, get a
// concrete substitution instruction instead of the generic message —
// confirmed live 2026-07-20 that a prose warning several paragraphs up in
// the diet rules wasn't reliably stopping the model from reaching for
// "beef jerky" (usually sugared) / oil-packed canned fish / butter / egg /
// dairy again on the VERY NEXT repair attempt for the SAME meal; naming the
// exact fix at the point of the violation is far more directive than a
// general rule stated once, up front. Shared between the WALL_RULES
// message() (used when validateDay pre-computes wallMessage) and
// describeMealViolation's DIET fallback (used by the cross-day-repair and
// /api/regenerate-meal paths, which call runWallOnMeal directly and never
// get a wallMessage attached).
function describeDietViolation(v) {
  if (v.dietTag === "carnivore" && /sugar/i.test(v.detail)) {
    return `Contains "${v.detail}" which violates the "carnivore" diet rule — retail beef jerky/dried meat almost always has added sugar in the cure. Replace with "sugar-free beef jerky" or "unsweetened dried beef" explicitly, or swap to a different protein entirely (canned meat/fish, cheese, hard-boiled eggs).`;
  }
  if (v.dietTag === "carnivore" && /olive oil|vegetable oil|oil\b/i.test(v.detail)) {
    return `Contains "${v.detail}" which violates the "carnivore" diet rule — canned fish packed in olive/vegetable oil is not carnivore-compliant. Specify fish packed in water (drained) instead, or fish packed in its own oil/broth, or add the fat separately as butter/tallow.`;
  }
  if (v.dietTag === "vegan" && /\bbutter\b/i.test(v.detail)) {
    return `Contains "${v.detail}" which violates the "vegan" diet rule. Replace with "vegan butter" or "plant-based margarine" explicitly, or use olive/coconut oil instead.`;
  }
  // "mayo"/"mayonnaise"/"aioli"/"hollandaise" are all egg-based by default —
  // confirmed live 2026-07-21 that the model reliably reached for "mayo" or
  // "dairy-free mayo" (still egg-based; dairy-free doesn't touch the egg
  // content) as if it were a vegan-safe swap.
  if (v.dietTag === "vegan" && /\begg|mayo|aioli|hollandaise/i.test(v.detail)) {
    return `Contains "${v.detail}" which violates the "vegan" diet rule — this is egg-based by default (a "dairy-free" label doesn't change that). Replace it entirely — use "vegan mayo"/"eggless mayo" explicitly if a spread is needed, or a tofu scramble/chickpea flour ("besan") scramble if it's the egg dish itself, not a real egg in any form.`;
  }
  if (v.dietTag === "vegan" && /\b(cheese|milk|cream|yogh?urt)\b/i.test(v.detail)) {
    return `Contains "${v.detail}" which violates the "vegan" diet rule. Replace with the named plant-based alternative explicitly (e.g. "vegan cheese"/"nutritional yeast", "oat milk"/"almond milk", "coconut cream", "coconut yogurt") — never the real dairy version.`;
  }
  // Live verification (2026-07-21) found garlic/onion the dominant recurring
  // fodmap trip-up, reintroduced across repair attempts on multiple meals in
  // the same day — the generic message never named the standard FODMAP-safe
  // substitute (the flavor compounds that trigger FODMAP symptoms aren't
  // fat-soluble, so garlic/onion-infused oil carries the flavor without them).
  if (v.dietTag === "fodmap" && /\b(garlic|onions?)\b/i.test(v.detail)) {
    return `Contains "${v.detail}" which violates the "fodmap" diet rule. Replace with "garlic-infused oil" and/or "the green tops of scallions/spring onions" explicitly — both carry the flavor without the FODMAP-triggering compounds (which aren't fat-soluble), unlike whole garlic/onion.`;
  }
  if (v.dietTag === "fodmap" && /high[- ]fructose corn syrup/i.test(v.detail)) {
    return `Contains "${v.detail}" which violates the "fodmap" diet rule. Replace with a low-FODMAP sweetener explicitly (maple syrup, table sugar/sucrose, or a small amount of stevia) — never high-fructose corn syrup or honey.`;
  }
  return `Contains "${v.detail}" which violates the "${v.dietTag}" diet rule.`;
}

const WALL_RULES = [
  {
    id: "no_allergens",
    severity: "BLOCK",
    scope: "meal",
    check: (meal, ruleCtx) => {
      const violations = findMealAllergenViolations(meal, ruleCtx.requiredAllergenTags, ruleCtx.customAllergyTerm);
      return { pass: violations.length === 0, violations };
    },
    message: (v) => v.source === "user"
      ? `Contains "${v.detail}" — the crew member has personally flagged this as something they cannot eat.`
      : `Contains/implies "${v.detail}" (detected via ${v.source}) which matches the user's required allergen avoidance "${v.tag}" — strictly forbidden, including this hidden/derivative form.`,
  },
  {
    id: "diet_compliance",
    severity: "REPAIR",
    scope: "meal",
    check: (meal, ruleCtx) => {
      const violations = findMealDietViolations(meal, ruleCtx.activeDietTags);
      return { pass: violations.length === 0, violations };
    },
    message: describeDietViolation,
  },
  {
    id: "meal_slot_appropriateness",
    severity: "REPAIR",
    scope: "meal",
    check: (meal) => {
      const v = findMealSlotContentViolation(meal);
      return { pass: !v, violations: v ? [v] : [] };
    },
    message: (v) => `${v.detail} — a normal person wouldn't recognize this as ${v.mealType} and eat it at that time of day. Replace it with a genuinely typical ${v.mealType} dish. If a protein/macro target is hard to hit with ${v.mealType}-appropriate foods, that's fine — the DAILY total across all meals is what matters, not this one meal in isolation.`,
  },
  {
    id: "portion_scale",
    severity: "REPAIR",
    scope: "meal",
    check: (meal, ruleCtx) => {
      const v = findMealPortionScaleViolation(meal, ruleCtx.calorieTarget);
      return { pass: !v, violations: v ? [v] : [] };
    },
    message: (v) => `${v.detail}. Rebuild this ${v.mealType} at the right scale for its slot.`,
  },
  {
    id: "title_quality",
    severity: "REPAIR",
    scope: "meal",
    check: (meal) => {
      const v = findMealTitleViolation(meal);
      return { pass: !v, violations: v ? [v] : [] };
    },
    message: (v) => v.suggestedName
      ? `Title problem: ${v.detail}. Use exactly this corrected name: "${v.suggestedName}" — do NOT swap in a different diet name (e.g. "Dairy-Free" instead of "Gluten-Free"); drop the diet qualifier entirely, since it's already shown separately as a tag.`
      : `Title problem: ${v.detail}. Rename it to a short, plain menu-style name (max ${MAX_TITLE_CONTENT_WORDS} content words) that says what the dish IS — never the diet name (that's already shown separately as a tag).`,
  },
  {
    id: "icon_match",
    severity: "REPAIR",
    scope: "meal",
    check: (meal) => {
      const v = findMealIconViolation(meal);
      return { pass: !v, violations: v ? [v] : [] };
    },
    message: (v) => `${v.detail}. Pick an emoji that matches the meal's actual ingredients and slot.`,
  },
  {
    id: "kitchen_access",
    severity: "REPAIR",
    scope: "meal",
    check: (meal, ruleCtx) => {
      const v = findMealKitchenViolation(meal, ruleCtx.kitchenList);
      return { pass: !v, violations: v ? [v] : [] };
    },
    // Live verification (2026-07-20) found kitchen_access repairs failing
    // repeatedly on hotel/no-kitchen days — the bare v.detail only restates
    // WHAT's wrong (wrong prep_method), unlike the initial-generation prompt
    // which always names the exact allowed methods (see buildKitchenAccessBlock).
    // Same fix class as title_quality's suggestedName: hand over the exact
    // allowed set instead of leaving the model to guess a replacement.
    message: (v) => `${v.detail}. Rebuild this meal (different dish if needed) with prep_method set to exactly one of: ${v.allowedMethods.join(", ")} — no other value is achievable with this kitchen access.`,
  },
  {
    id: "customs_carried_food",
    severity: "REPAIR",
    scope: "meal",
    check: (meal, ruleCtx) => {
      const v = findMealCustomsViolation(meal, ruleCtx.restrictedBorders, ruleCtx.kitchenList);
      return { pass: !v, violations: v ? [v] : [] };
    },
    // Live verification (2026-07-22) found customs repairs failing to
    // converge across multiple unrelated diets — the model kept reaching
    // for fresh banana/apple/orange juice again on the very next repair
    // attempt because the bare v.detail only restated the problem, never
    // naming a fix. Same fix class as kitchen_access/title_quality.
    message: (v) => `${v.detail}. Either swap in a commercially packaged/canned/dried/shelf-stable version of this exact food, replace it with a different already-shelf-stable ingredient entirely, or — if it's actually prepared and eaten at the current stop, not carried onward — say so explicitly in the tip ("buy locally, consume before next flight").`,
  },
  // NEW — the model now self-declares hero_ingredient (see MEAL_SCHEMA); this
  // rule independently infers a hero via the same regex table used for
  // cross-day variety detection (getMealHeroCategory) and flags disagreement.
  // WARN, not REPAIR: the inference is a heuristic bucket list, so a
  // disagreement is a useful signal to review, not proof the model is wrong.
  {
    id: "hero_ingredient_agreement",
    severity: "WARN",
    scope: "meal",
    check: (meal) => {
      const declared = (meal.hero_ingredient || "").trim().toLowerCase();
      const inferred = getMealHeroCategory(meal);
      if (!declared || !inferred) return { pass: true, violations: [] };
      const inferredWords = inferred.replace(/_/g, " ").split(" ");
      const agrees = inferredWords.some(w => declared.includes(w)) || declared.split(/\s+/).some(w => inferred.includes(w));
      if (agrees) return { pass: true, violations: [] };
      return { pass: false, violations: [{ code: "HERO_MISMATCH", detail: `model declared hero_ingredient="${meal.hero_ingredient}" but independent inference from name/ingredients suggests "${inferred}"` }] };
    },
    message: (v) => v.detail,
  },
  {
    id: "day_structure",
    severity: "REPAIR",
    scope: "day",
    check: (meals, ruleCtx) => {
      const violations = findDayStructureViolations(meals, ruleCtx.expectedStructure);
      return { pass: violations.length === 0, violations };
    },
    message: (v) => `Day structure problem: ${v.detail}.`,
  },
  {
    id: "calorie_accuracy",
    severity: "REPAIR",
    scope: "day",
    // The displayed total is always the actual sum of meals
    // (rescaleMealsToTarget guarantees this by construction before this ever
    // runs) — this checks that sum lands within tolerance of the target.
    check: (meals, ruleCtx) => {
      if (!ruleCtx.calorieTarget) return { pass: true, violations: [] };
      const total = (meals || []).reduce((s, m) => s + (m.calories || 0), 0);
      const diff = Math.abs(total - ruleCtx.calorieTarget) / ruleCtx.calorieTarget;
      if (diff <= ruleCtx.calorieTolerance) return { pass: true, violations: [] };
      return { pass: false, violations: [{ code: "CALORIES", detail: `total ${total} kcal vs target ${ruleCtx.calorieTarget} kcal (${(diff * 100).toFixed(1)}% off, tolerance ${(ruleCtx.calorieTolerance * 100).toFixed(0)}%)` }] };
    },
    message: (v) => `${v.detail}. Rebalance portions across the day so the SUM of meal calories lands on target — the daily total is what's checked.`,
  },
  {
    id: "budget",
    severity: "REPAIR",
    scope: "day",
    check: (meals, ruleCtx) => {
      if (!ruleCtx.perDayBudget) return { pass: true, violations: [] };
      const totalCost = (meals || []).reduce((s, m) => s + computeMealCost(m), 0);
      // 10% tolerance, same philosophy as the calorie check just above:
      // estimated_cost is the model's per-ingredient estimate, not a real
      // receipt, so a hard $0.01-precision cutoff on an inherently
      // approximate number was causing real failures — confirmed live
      // 2026-07-20 that a restrictive diet with no cheap-staple offsets
      // (e.g. carnivore) can miss a tight budget by a couple dollars even
      // after repair specifically targets the overage, and a day/whole-
      // pairing failing outright is a much worse outcome than the plan
      // costing slightly more than requested.
      if (totalCost <= ruleCtx.perDayBudget * 1.10) return { pass: true, violations: [] };
      return { pass: false, violations: [{ code: "BUDGET", detail: `total $${totalCost.toFixed(2)} exceeds day budget $${ruleCtx.perDayBudget.toFixed(2)} (10% tolerance)` }] };
    },
    message: (v) => `${v.detail}. Use more affordable ingredients so the day's total cost fits the budget.`,
  },
  {
    id: "low_carb_daily_limit",
    severity: "REPAIR",
    scope: "day",
    check: (meals, ruleCtx) => {
      if (!ruleCtx.activeDietTags.includes("low_carb")) return { pass: true, violations: [] };
      const totalCarbs = (meals || []).reduce((s, m) => s + (m.carbs || 0), 0);
      if (totalCarbs <= LOW_CARB_DAILY_LIMIT_G + 5) return { pass: true, violations: [] };
      return { pass: false, violations: [{ code: "DIET", dietTag: "low_carb", detail: `total ${totalCarbs}g carbs exceeds ${LOW_CARB_DAILY_LIMIT_G}g/day limit` }] };
    },
    message: (v) => `Contains "${v.detail}" which violates the "${v.dietTag}" diet rule.`,
  },
  {
    id: "variety",
    severity: "REPAIR",
    scope: "plan",
    // Runs across the WHOLE assembled plan, not per-day — days generate
    // independently (parallel, for latency), so a same-slot repeat across
    // consecutive days can only be caught here, after assembly.
    check: (days) => {
      const violations = findCrossDayVarietyViolations(days);
      return { pass: violations.length === 0, violations };
    },
    message: (v) => `${v.detail}. Replace this meal with a genuinely different dish — different hero ingredient AND different title pattern from the other day.`,
  },
  {
    id: "customs_matches_destination",
    severity: "REPAIR",
    scope: "plan",
    // Doesn't trust ruleCtx.restrictedBorders (what generation actually used)
    // as ground truth — RE-DERIVES the expected country set fresh from the
    // pairing's raw destinations/departure, the exact same way
    // detectRestrictedBorders always has. If the two disagree, the
    // airport->country lookup silently broke somewhere between prompt-build
    // time and now (wrong country, or a border that should have fired but
    // didn't) — a plan generated under the wrong/missing ruleset can't be
    // patched meal-by-meal, so the whole day(s) touching the missing
    // country are marked for full regeneration instead. Independently of
    // that, every meal in every day NOT already being regenerated is
    // re-checked against the union of the recomputed border set, exactly
    // mirroring customs_carried_food's per-meal check but against fresh
    // data — this is the safety net for the case where restrictedBorders'
    // ID set matched but its content (carriedBans) somehow didn't.
    check: (days, ruleCtx = {}) => {
      const violations = [];
      const expected = detectRestrictedBorders(ruleCtx.destinations, ruleCtx.departure);
      const expectedIds = expected.map(b => b.id).sort().join(",");
      const appliedBorders = ruleCtx.restrictedBorders || [];
      const appliedIds = appliedBorders.map(b => b.id).sort().join(",");
      const mismatchedDayNums = new Set();

      if (expectedIds !== appliedIds) {
        const missing = expected.filter(b => !appliedBorders.some(a => a.id === b.id));
        for (const b of missing) {
          b.days.forEach(d => mismatchedDayNums.add(d));
          if (b.onReturn) { const last = days[days.length - 1]; if (last) mismatchedDayNums.add(last.day); }
        }
        // A mismatch was detected but couldn't be pinned to a specific day
        // (shouldn't happen given detectRestrictedBorders' own contract) —
        // fail every day rather than let anything ship unchecked.
        if (missing.length > 0 && mismatchedDayNums.size === 0) days.forEach(d => mismatchedDayNums.add(d.day));
        for (const dayNum of mismatchedDayNums) {
          violations.push({
            code: "CUSTOMS_MISMATCH", day: dayNum,
            detail: `derived destination countries [${expectedIds || "none"}] don't match the customs rules actually applied to this plan [${appliedIds || "none"}]`,
          });
        }
      }

      // Independent per-meal re-check against the RECOMPUTED border set —
      // skips days already flagged above (they're being fully regenerated,
      // and checking meals about to be discarded just races the day-failure
      // write below with a meal-index write on the same day).
      for (const day of days) {
        if (mismatchedDayNums.has(day.day) || !Array.isArray(day.meals)) continue;
        const rawKitchen = Array.isArray(ruleCtx.kitchen_by_day)
          ? (ruleCtx.kitchen_by_day[(day.day || 1) - 1] || ruleCtx.kitchen || [])
          : (ruleCtx.kitchen || []);
        const kitchenList = Array.isArray(rawKitchen) ? rawKitchen : (rawKitchen ? [rawKitchen] : []);
        day.meals.forEach((meal, mealIndex) => {
          const v = findMealCustomsViolation(meal, expected, kitchenList);
          if (v) violations.push({ ...v, code: "CUSTOMS_UNION", day: day.day, mealIndex, mealType: meal.type, mealName: meal.name });
        });
      }

      return { pass: violations.length === 0, violations };
    },
    message: (v) => v.code === "CUSTOMS_MISMATCH"
      ? `${v.detail}. Regenerate this day so it's built under the correct cross-border carried-food constraints for its actual destination country.`
      : `${v.detail}. This item can't be packed/carried given the full set of restricted countries in this pairing — swap it for a commercially sealed/shelf-stable alternative.`,
  },
];

// ─── OBSERVABILITY ───────────────────────────────────────────────────────
// Every violation the Wall ever finds gets logged here, structured, whether
// or not it ends up blocking/repairing anything — this is how the Wall gets
// smarter over time: query which rules fire most often and tighten the
// GENERATION PROMPT with evidence, instead of guessing. console.warn/.error
// calls are captured durably by Vercel's runtime logs regardless of instance
// lifetime; the in-memory ring buffer below additionally powers a live
// same-instance summary via GET /api/wall-stats, but — because Vercel
// serverless instances are not guaranteed to persist or be shared across
// invocations — it should be treated as a debugging aid, not a durable
// analytics store. A DB-backed table (via the CRUD backend) would be the
// right follow-up for true cross-invocation aggregation.
const WALL_LOG_MAX_ENTRIES = 1000;
const WALL_VIOLATION_LOG = [];
function logWallViolation(entry) {
  const record = {
    ruleId: entry.ruleId, severity: entry.severity, code: entry.code,
    day: entry.day, mealIndex: entry.mealIndex, mealType: entry.mealType, mealName: entry.mealName,
    detail: entry.detail, attempt: entry.attempt ?? 0, source: entry.source || "layer1",
    timestamp: new Date().toISOString(),
  };
  WALL_VIOLATION_LOG.push(record);
  if (WALL_VIOLATION_LOG.length > WALL_LOG_MAX_ENTRIES) WALL_VIOLATION_LOG.shift();
  console.warn(`[wall] ${record.severity} ${record.ruleId} day=${record.day ?? "-"} attempt=${record.attempt} meal="${record.mealName ?? ""}" detail="${record.detail}"`);
}

// ─── ORCHESTRATOR ────────────────────────────────────────────────────────
// The ONLY place each scope's rules get iterated — add a rule to WALL_RULES
// above with the right `scope` and it starts running automatically here, no
// other code change required. Every violation is tagged with ruleId/severity
// so callers (generateOneDay's repair loop, the bank filter, the judge
// layer) can branch on severity without re-deriving it. wallMessage is
// deliberately NOT computed here — a rule's message() often references
// mealType/mealName (e.g. "not appropriate for ${v.mealType}"), which for
// meal-scope rules isn't attached until validateDay assembles the full
// violation below; computing it here would bake in "undefined". See
// computeWallMessage, called once the full violation shape exists.
function runWallOnMeal(meal, ruleCtx) {
  const violations = [];
  for (const rule of WALL_RULES) {
    if (rule.scope !== "meal") continue;
    const { violations: ruleViolations } = rule.check(meal, ruleCtx);
    for (const v of ruleViolations) violations.push({ ...v, ruleId: rule.id, severity: rule.severity });
  }
  return violations;
}

function runWallOnDayScope(meals, ruleCtx) {
  const violations = [];
  for (const rule of WALL_RULES) {
    if (rule.scope !== "day") continue;
    const { violations: ruleViolations } = rule.check(meals, ruleCtx);
    for (const v of ruleViolations) violations.push({ ...v, ruleId: rule.id, severity: rule.severity });
  }
  return violations.map(v => ({ ...v, wallMessage: computeWallMessage(v) }));
}

function runWallOnPlanScope(days, ruleCtx) {
  const violations = [];
  for (const rule of WALL_RULES) {
    if (rule.scope !== "plan") continue;
    const { violations: ruleViolations } = rule.check(days, ruleCtx);
    for (const v of ruleViolations) violations.push({ ...v, ruleId: rule.id, severity: rule.severity });
  }
  // Plan-scope violations already carry day (and, where meal-repairable,
  // mealType/mealName) from their own check() above, so the full shape
  // exists already — no deferred-assembly step needed like meal/day scope.
  return violations.map(v => ({ ...v, wallMessage: computeWallMessage(v) }));
}

function hasBlockingViolation(violations) {
  return (violations || []).some(v => v.severity === "BLOCK");
}
function repairableViolations(violations) {
  return (violations || []).filter(v => v.severity === "REPAIR");
}

// Looks up the rule that produced a violation and calls its message() now
// that the violation carries its full shape (mealType/mealName included) —
// this is the single point wallMessage ever gets computed, so every caller
// sees the same, correctly-filled-in text.
function computeWallMessage(v) {
  const rule = WALL_RULES.find(r => r.id === v.ruleId);
  return rule ? rule.message(v) : v.detail;
}

// Validates ONE already-generated day's meals against every registered
// meal-scope and day-scope rule. Violations with a mealIndex are individually
// repairable (swap just that meal); violations without one are about the
// COMBINATION of meals (slot counts, day total) and need a full day
// regeneration. Same name/signature as before the Wall existed — every
// existing call site (bank filter, tests) keeps working unchanged; the
// REGISTRY is what's new, not this function's contract.
function validateDay(meals, ruleCtx) {
  const violations = [];
  (meals || []).forEach((meal, mealIndex) => {
    for (const v of runWallOnMeal(meal, ruleCtx)) {
      const full = { ...v, mealIndex, mealType: meal.type, mealName: meal.name };
      violations.push({ ...full, wallMessage: computeWallMessage(full) });
    }
  });
  for (const v of runWallOnDayScope(meals, ruleCtx)) violations.push(v);
  return { valid: violations.length === 0, violations };
}

// Public entry point: validatePlan(plan, userProfile). `plan` = { days: [{
// meals }, ...] }. `userProfile` = the raw request `data` object (same shape
// /api/generate-plan receives) — this is the single source of truth for
// whether a plan is allowed to reach a client. Every code path that returns
// plan content to a user routes through this (or validateDay directly, for
// the per-day generation loop) — see the call-site audit in
// test-the-wall.mjs for the full enumeration.
function validatePlan(plan, userProfile, lang = "en") {
  const days = plan?.days || [];
  const pairingDays = days.length || 1;
  const ctx = buildContext(userProfile, lang, pairingDays);
  const { tags: requiredAllergenTags, customAllergyTerm } = getUserRequiredAllergenAvoidance(userProfile);
  const rawDiets = Array.isArray(userProfile.diets) ? userProfile.diets : (userProfile.diet ? [userProfile.diet] : []);
  const activeDietTags = rawDiets.filter(d => DIET_PROHIBITED[d] || d === "kosher" || d === "low_carb");
  const expectedStructure = getExpectedMealStructure(ctx);
  const calorieTarget = ctx.calorieTarget ?? ctx.gainTarget ?? ctx.maintenanceTarget ?? null;
  const calorieTolerance = ctx.maintenanceTarget && !ctx.calorieTarget && !ctx.gainTarget ? 0.15 : 0.10;

  const allViolations = [];
  days.forEach((day, i) => {
    const dayNum = day.day || i + 1;
    const rawKitchen = Array.isArray(userProfile.kitchen_by_day)
      ? (userProfile.kitchen_by_day[dayNum - 1] || userProfile.kitchen || [])
      : (userProfile.kitchen || []);
    const kitchenList = Array.isArray(rawKitchen) ? rawKitchen : (rawKitchen ? [rawKitchen] : []);
    const { violations } = validateDay(day.meals, {
      requiredAllergenTags, customAllergyTerm, activeDietTags, expectedStructure,
      calorieTarget, calorieTolerance, perDayBudget: ctx.perDayBudget, kitchenList,
      restrictedBorders: ctx.restrictedBorders,
    });
    for (const v of violations) allViolations.push({ ...v, day: dayNum });
  });

  const planRuleCtx = {
    destinations: userProfile.destinations, departure: userProfile.departure,
    restrictedBorders: ctx.restrictedBorders,
    kitchen_by_day: userProfile.kitchen_by_day, kitchen: userProfile.kitchen,
  };
  for (const v of runWallOnPlanScope(days, planRuleCtx)) allViolations.push(v);

  return { valid: allViolations.length === 0, violations: allViolations };
}

// ─── Repair ────────────────────────────────────────────────────────────────
// Every violation produced BY the Wall registry already carries its own
// human-readable wallMessage (see each rule's `message()` in WALL_RULES
// above) — this fallback only exists for the rare violation constructed
// ad-hoc outside the registry (e.g. /api/regenerate-meal's manually-flagged
// { code: "ALLERGEN", source: "user", detail: excludeIngredient }, which
// isn't a registry match, it's a crew member tapping one specific ingredient).
function describeMealViolation(v) {
  if (v.wallMessage) return v.wallMessage;
  switch (v.code) {
    case "ALLERGEN":
      return v.source === "user"
        ? `Contains "${v.detail}" — the crew member has personally flagged this as something they cannot eat.`
        : `Contains/implies "${v.detail}" (detected via ${v.source}) which matches the user's required allergen avoidance "${v.tag}" — strictly forbidden, including this hidden/derivative form.`;
    case "DIET": return describeDietViolation(v);
    case "MEAL_SLOT_CONTENT": return `${v.detail} — a normal person wouldn't recognize this as ${v.mealType} and eat it at that time of day. Replace it with a genuinely typical ${v.mealType} dish. If a protein/macro target is hard to hit with ${v.mealType}-appropriate foods, that's fine — the DAILY total across all meals is what matters, not this one meal in isolation.`;
    case "PORTION_SCALE": return `${v.detail}. Rebuild this ${v.mealType} at the right scale for its slot.`;
    case "TITLE": return v.suggestedName
      ? `Title problem: ${v.detail}. Use exactly this corrected name: "${v.suggestedName}" — do NOT swap in a different diet name; drop the diet qualifier entirely, since it's already shown separately as a tag.`
      : `Title problem: ${v.detail}. Rename it to a short, plain menu-style name (max ${MAX_TITLE_CONTENT_WORDS} content words) that says what the dish IS — never the diet name (that's already shown separately as a tag).`;
    case "ICON": return `${v.detail}. Pick an emoji that matches the meal's actual ingredients and slot.`;
    case "CROSS_DAY_VARIETY": return `${v.detail}. Replace this meal with a genuinely different dish — different hero ingredient AND different title pattern from the other day.`;
    case "JUDGE_ODD": return `A skeptical human-plausibility review flagged this meal: ${v.detail}. Replace it with something a real person would recognize and want to eat.`;
    case "KITCHEN": return v.allowedMethods
      ? `${v.detail}. Rebuild this meal (different dish if needed) with prep_method set to exactly one of: ${v.allowedMethods.join(", ")} — no other value is achievable with this kitchen access.`
      : v.detail;
    case "CUSTOMS": return `${v.detail}. Either swap in a commercially packaged/canned/dried/shelf-stable version of this exact food, replace it with a different already-shelf-stable ingredient entirely, or — if it's actually prepared and eaten at the current stop, not carried onward — say so explicitly in the tip ("buy locally, consume before next flight").`;
    default: return v.detail;
  }
}

// Regenerates ONE meal that failed validation, naming every specific problem
// found so the correction is targeted rather than a generic "try again".
// Returns null (not the stale meal) on failure, so the caller can tell
// "still broken" apart from "unchanged" — the repair loop must never
// silently keep serving a violating meal just because regeneration errored.
// carriedFoodBlock is optional (customs-restricted pairings only) but was
// missing at every call site until 2026-07-20: fixing an UNRELATED problem
// (e.g. a cross-day variety repeat) with zero customs context routinely
// produced a fresh customs violation instead — "Oatmeal with Berries" kept
// coming back as the swap-in for a repeated Breakfast, because the model
// regenerating it had no idea fresh berries couldn't cross this pairing's
// border. The cross-day path in particular gets exactly one shot with no
// retry, so introducing a brand-new violation there fails the whole day.
async function regenerateMealForViolations(meal, violations, dietRules, kitchenAccessBlock, carriedFoodBlock = "") {
  const problems = violations.map((v, i) => `${i + 1}. ${describeMealViolation(v)}`).join("\n");
  const prompt = `Revise this ONE meal — it failed automated validation and must be replaced.

ORIGINAL MEAL: ${JSON.stringify({ name: meal.name, description: meal.description })}

PROBLEMS FOUND (fix EVERY one of them):
${problems}

${dietRules}

${kitchenAccessBlock}
${carriedFoodBlock ? `\n${carriedFoodBlock}\n` : ""}
Generate a REPLACEMENT ${meal.type} meal that fixes every problem above, still fully complies with the diet and kitchen constraints, and keeps calories close to ${meal.calories} kcal. List EVERY ingredient (nothing omitted, however small) in "ingredients", and make sure "allergens_present" and "diet_tags" accurately reflect the NEW ingredients — do not carry over the old meal's values. Return ONLY the meal JSON.`;
  try {
    const replacement = await runStructured(prompt, MEAL_SCHEMA, 900, FAST_MODEL);
    return { ...replacement, type: meal.type };
  } catch (e) {
    console.error(`[validator-repair] regeneration failed for "${meal.name}": ${e.message}`);
    return null;
  }
}

// A title_quality violation's suggestedName is the exact, algorithmically-
// correct fix (diet term stripped, whitespace collapsed) — trusting the
// model to apply it verbatim via another regeneration round-trip is
// unreliable (see suggestedName's own comment: it reliably swaps ONE diet
// qualifier for ANOTHER instead of dropping it). Confirmed live 2026-07-20:
// this churn survived even the directive repair message and exhausted
// REPAIR_ATTEMPTS in a cross-day repair. When title_quality is the ONLY
// thing wrong with a meal, skip the model call and apply the known-correct
// name directly instead of gambling another attempt on it.
function deterministicTitleFix(meal, violations) {
  if (violations.length === 1 && violations[0].ruleId === "title_quality" && violations[0].suggestedName) {
    return { ...meal, name: violations[0].suggestedName };
  }
  return null;
}

// FODMAP garlic/onion is the single most persistent repair failure in
// production — even a strengthened initial prompt (explicit "check every
// seasoning blend" warning) AND a directive repair message (use garlic-
// infused oil / scallion greens instead) don't reliably stop the model
// from reaching for it again on the very next attempt. Confirmed live
// 2026-07-22: "Rotisserie/Grilled Chicken with Rice" style meals kept
// failing on "garlic" across repeated attempts and a strengthened prompt.
// When it's the ONLY remaining problem, strip the word out of the
// ingredient list and text fields directly — garlic/onion is a minor
// seasoning ingredient, not a hero, so removing it doesn't break the dish
// the way stripping a main protein would.
function deterministicFodmapGarlicFix(meal, violations) {
  if (violations.length !== 1) return null;
  const v = violations[0];
  if (v.ruleId !== "diet_compliance" || v.dietTag !== "fodmap" || !/\b(garlic|onions?)\b/i.test(v.detail)) return null;
  // Non-global pattern for .test() — a shared global regex's lastIndex
  // state would corrupt repeated .test() calls across different ingredient
  // strings in the filter below. stripWord's inline /gi literal is safe
  // since a fresh RegExp is instantiated on every call.
  const testPattern = /\b(garlic|onions?)\b/i;
  const stripWord = (text) => (text ? text.replace(/\b(garlic|onions?)\b/gi, "").replace(/\s{2,}/g, " ").replace(/\s+([,.])/g, "$1").trim() : text);
  return {
    ...meal,
    ingredients: (meal.ingredients || []).filter(i => {
      const n = typeof i === "string" ? i : i?.name;
      return !(n && testPattern.test(n));
    }),
    name: stripWord(meal.name),
    description: stripWord(meal.description),
    tip: stripWord(meal.tip),
  };
}

// General-purpose version of the fodmap-garlic fix above, for ANY single
// diet_compliance violation whose detail is a bare ingredient/flavor term
// (not a structural sentence like kosher's "meat and dairy combined in one
// meal", which can't be fixed by removing a word). This is the LAST-RESORT
// escape hatch — called only after the model has already had its normal
// REPAIR_ATTEMPTS chances to fix things properly, right before a day would
// otherwise be marked "couldn't be generated" over one stuck ingredient.
// Getting a mostly-right meal with one flavor ingredient quietly dropped is
// a far better outcome for the crew member than losing the whole day.
function isStrippableIngredientDetail(detail) {
  if (!detail || typeof detail !== "string") return false;
  const trimmed = detail.trim();
  if (!trimmed || trimmed.length > 30) return false;
  if (/[.!?]/.test(trimmed)) return false; // a hand-written sentence, not a matched word/phrase
  if (trimmed.split(/\s+/).length > 3) return false; // e.g. "meat and dairy combined in one meal"
  return true;
}
function deterministicIngredientStripFix(meal, violations) {
  if (violations.length !== 1) return null;
  const v = violations[0];
  if (v.ruleId !== "diet_compliance" || !isStrippableIngredientDetail(v.detail)) return null;
  const escaped = escapeRegExp(v.detail.trim());
  const testPattern = new RegExp(`\\b${escaped}\\b`, "i");
  const stripWord = (text) => (text ? text.replace(new RegExp(`\\b${escaped}\\b`, "gi"), "").replace(/\s{2,}/g, " ").replace(/\s+([,.])/g, "$1").trim() : text);
  const strippedIngredients = (meal.ingredients || []).filter(i => {
    const n = typeof i === "string" ? i : i?.name;
    return !(n && testPattern.test(n));
  });
  // Removing every ingredient would leave an empty/nonsensical meal — bail
  // out rather than ship that (the caller's normal failure path takes over).
  if (strippedIngredients.length === 0) return null;
  return {
    ...meal,
    ingredients: strippedIngredients,
    name: stripWord(meal.name),
    description: stripWord(meal.description),
    tip: stripWord(meal.tip),
  };
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

// Every prep_method value the schema allows — used below to spell out the
// FULL forbidden list, not just one example of it.
const ALL_PREP_METHODS = ["no_cook", "microwave", "stove_oven", "airplane_provided"];

function buildKitchenAccessBlock(kitchen) {
  const normalized = Array.isArray(kitchen) ? kitchen : (kitchen ? [kitchen] : []);
  const list = normalized.length ? normalized : ["full_kitchen"];
  const rules = list.map((k) => KITCHEN_ACCESS_RULES[k]).filter(Boolean);
  if (!rules.length) return "";

  let block = `KITCHEN ACCESS (${list.join(", ")}):\n` + rules.map((r) => `- ${r}`).join("\n");

  if (list.length > 1) {
    block += `\nMULTIPLE ACCESS TYPES: for each meal, apply whichever single type fits realistically (e.g. dinner on flying day → airplane_food; ground-day breakfast → hotel/microwave). Never blend constraints across types in one meal.`;
  }

  // Explicit, deterministic allow/forbid list for the "prep_method" schema
  // field — derived from the SAME KITCHEN_PREP_METHOD_ALLOW map the
  // validator checks against, so it can never drift out of sync. Production
  // logs showed the model reliably avoiding stove_oven on hotel-only days
  // (the one example named in the general diet-rules footer) but still
  // reaching for microwave or airplane_provided — neither was ever named as
  // forbidden, so naming ALL of them, not just one, closes that gap.
  const allowedMethods = [...new Set(list.flatMap(k => KITCHEN_PREP_METHOD_ALLOW[k] || []))];
  const forbiddenMethods = ALL_PREP_METHODS.filter(m => !allowedMethods.includes(m));
  if (allowedMethods.length) {
    block += `\nprep_method MUST be exactly one of: ${allowedMethods.join(", ")}.${forbiddenMethods.length ? ` NEVER use: ${forbiddenMethods.join(", ")} — none of these are achievable with this kitchen access.` : ""}`;
  }

  return block;
}

// Returns the rule block for a single diet key.
function getSingleDietBlock(diet, calorieTarget, data) {
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
- "Dairy-free" alone does NOT make something vegan-safe if it's egg-based — standard mayo/aioli/hollandaise are egg-based regardless of dairy content. Use "vegan mayo"/"eggless mayo" explicitly, never plain "dairy-free mayo".
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
- All meat/poultry must be halal-certified — say so in "description" or "tip" (e.g. "Use halal-certified chicken"), NEVER in "name". The word "Halal" must never appear in the dish title — same rule as every other diet name (see TITLES rule) — "Grilled Halal Chicken" is WRONG, "Grilled Chicken with Lemon" is RIGHT; the halal tag is already shown separately.
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
- Make up calories from protein and fat. Verify total daily carbs ≤50g. Before finalizing the day, SUM the carbs across all meals — if the total is even close to 50g, cut a higher-carb item (fruit, a starchy garnish, a sauce with added sugar) rather than shipping it over.
- Being low-carb is never an excuse to serve a cheese plate, charcuterie board, or cold cured-meat-and-cheese platter as an entire Lunch or Dinner — that's a snack board, not a meal. On a day with COOKING access, build the low-carb main around a cooked protein (steak, chicken, salmon, etc.) plus a cooked non-starchy vegetable side; use cheese/nuts/olives as a garnish or the snack meals, not as the main course itself.
- On a NO-COOK day (hotel/fridge-only), "cooked protein" isn't achievable — the low-carb main instead needs a COLD, ready-to-eat protein at real portion size: rotisserie/deli chicken, cold cuts, canned tuna or salmon, hard-boiled eggs, a pre-made protein salad (no bread/croutons), or a Greek-yogurt-and-nuts bowl — paired with raw non-starchy veg (cucumber, cherry tomatoes, bell pepper strips, snap peas), not a sandwich or wrap (the bread alone can burn most of the day's 50g budget).`;
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
- Name the egg-free alternative explicitly (e.g. "egg-free mayo" not "mayo"). "Dairy-free mayo" does NOT make it egg-free — standard mayonnaise (dairy-free or not) is egg-based by default; the label must say "egg-free"/"vegan mayo" specifically, dairy-free alone changes nothing about the egg content.`;
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
- GARLIC/ONION ARE BANNED IN EVERY FORM — this is the single most common mistake, so check for it explicitly every time: garlic powder, onion powder, granulated garlic, and pre-made seasoning blends/marinades/rotisserie-chicken seasoning/canned soups/jarred sauces almost always contain garlic and/or onion by default. Don't just avoid whole garlic cloves — verify every seasoning, sauce, and "seasoned"/"marinated" ingredient by name.
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
    case "paleo":
      return `DIET: PALEO — STRICT RULES:
- NO grains (wheat, rice, oats, corn), legumes (beans, lentils, peanuts, soy), dairy, refined sugar, or processed/packaged foods.
- YES: meat, poultry, fish/seafood, eggs, vegetables, fruit, nuts, seeds, and healthy fats/oils (olive, coconut, avocado).
- Use natural sweeteners sparingly if needed (honey, maple syrup) — never refined sugar or artificial sweeteners.
- Watch for hidden grains/legumes/dairy: soy sauce, most breads/pastas/tortillas, peanut butter, cheese, yogurt, breaded/battered items.
- Build meals around a protein plus vegetables; use starchy vegetables (sweet potato, squash) in place of grains.`;
    case "carnivore":
      return `DIET: CARNIVORE — STRICT RULES:
- ONLY animal products: meat, fish, eggs, butter/tallow/lard/ghee.
- Include organ meat (liver, heart) at least once per pairing.
- ZERO plant ingredients: no veg, fruit, grains, legumes, nuts, seeds, sugar, or plant oils.
- Dairy optional: full-fat only (butter, heavy cream, hard cheese). Add tip that some carnivores exclude dairy.
- Include an electrolyte tip (bone broth, salt, sugar-free electrolytes) in at least one meal.
- Grocery produce + pantry categories: empty (carnivore only — no plant items).
- TWO SPECIFIC TRAPS, because the realistic commercial version of these products breaks carnivore-strictness and you will default to it if not told otherwise: canned fish (sardines/tuna/salmon) is normally sold packed in olive oil or vegetable oil — that oil IS a plant ingredient and violates this diet, so specify "packed in water" or "packed in olive oil, drained" only if you then add "drained, oil discarded" (or use fish packed in its own oil/broth); and retail beef jerky almost always has added sugar in the cure — you must specify "sugar-free beef jerky" or "unsweetened dried beef" explicitly, never just "beef jerky".`;
    case "calorie_deficit":
      return `DIET: CALORIE DEFICIT — see CALORIE DEFICIT GOAL below for daily kcal target.
- No food-type restrictions. Prioritize high-protein, high-fiber, high-volume, low-calorie-density foods for satiety.${calorieTarget ? `\n- Daily target: ${calorieTarget} kcal — meal calories must sum to ±50 kcal of this.` : ""}`;
    case "other":
      return `DIET: Custom (see Diet field in CREW PROFILE above). Follow stated preferences closely; when in doubt, avoid anything that might conflict.`;
    case "allergy_other": {
      const term = (data?.allergy_other_text || "").trim().slice(0, 100) || "the ingredient noted in the crew profile";
      return `DIET: CUSTOM ALLERGY — STRICT RULES (treat as a real, potentially life-threatening allergy, zero tolerance):
- The crew member is allergic to "${term}". NEVER include it, any dish made primarily from it, or any common hidden/derivative form of it (sauces, oils, flours, extracts, garnishes, or cross-contaminated preparations).
- If uncertain whether an ingredient is related to "${term}", exclude it — err on the side of caution.
- Add a cross-contamination warning in the "tip" field for any packaged, restaurant, or airplane-catered item that could plausibly contain it.`;
    }
    default:
      return `DIET: No restrictions. Balanced, nutritious meals with variety.`;
  }
}

// Accepts a single diet string or an array of diets (multi-select).
function getDietRules(rawDiet, calorieTarget, data) {
  // This prompt text is a SUPPORT for the server-side hard validator
  // (validatePlan / findMealAllergenViolations etc.), not a substitute for
  // it — every meal is checked deterministically after generation, and
  // rejected/regenerated if it violates anything below, regardless of how
  // well this text is followed. Being explicit here just reduces how often
  // that repair loop has to run.
  const FOOTER = `\nCRITICAL — READ CAREFULLY:
- Check every ingredient against the rules above before finalizing each meal. Replace any violating item. Full compliance required — no partial exceptions.
- Allergies/intolerances above are ABSOLUTE PROHIBITIONS, not preferences — this includes HIDDEN and DERIVATIVE forms, not just the obvious word. Examples: dairy/milk -> also butter, cream, cheese, yogurt, whey, casein, ghee, custard, ricotta, mascarpone. Egg -> also mayonnaise, meringue, hollandaise, aioli. Soy -> also tofu, edamame, miso, soy sauce, tamari, soy lecithin. Wheat/gluten -> also flour, breadcrumbs, panko, semolina, couscous, seitan, bulgur, farro, regular soy sauce. Shellfish -> also oyster sauce, shrimp paste, fish sauce made with shellfish. Tree nuts/peanuts -> also marzipan, praline, nut butters, pesto, nutella. Sesame -> also tahini, halva, hummus. If in doubt whether an ingredient is a hidden source of a banned allergen, LEAVE IT OUT.
- List EVERY distinct ingredient in "ingredients", however minor (a sauce, a garnish, a seasoning blend) — an incomplete ingredients list is itself treated as a failure, because it's the primary signal used to check for allergens.
- "allergens_present" must be the complete, honest set of major allergens this meal's ingredients touch (including hidden sources) — do not leave it empty just because the allergen isn't the main ingredient.
- "estimated_cost" must be a realistic USD-equivalent estimate for this single portion, consistent with the BUDGET guidance above.
- "prep_method" must accurately reflect what this exact meal needs (no_cook / microwave / stove_oven / airplane_provided) and must be achievable under the KITCHEN ACCESS constraints above — do not pick stove_oven for a meal assigned to a no-kitchen day.`;

  const diets = Array.isArray(rawDiet) ? rawDiet : (rawDiet ? [rawDiet] : []);
  const filtered = diets.filter(d => d && d !== "none");

  if (filtered.length === 0) {
    return `DIET: No restrictions. Aim for balanced meals with proteins, complex carbs, healthy fats, and vegetables.` + FOOTER;
  }

  if (filtered.length === 1) {
    return getSingleDietBlock(filtered[0], calorieTarget, data) + FOOTER;
  }

  const blocks = filtered.map(d => getSingleDietBlock(d, calorieTarget, data)).join("\n\n");
  return `COMBINED DIET — user follows ALL of these simultaneously. Apply ALL rules from every diet listed below:

${blocks}

COMBINED COMPLIANCE: Where rules conflict, apply the MOST RESTRICTIVE. If one diet allows dairy but another forbids it, exclude dairy entirely. Every single meal must satisfy every selected diet.` + FOOTER;
}

// ─── FLIGHT DIRECTION (derived, never asked) ───────────────────────────────
// The app used to ask crew to pick "eastbound"/"westbound" by hand (Duty
// Schedule step) — unreliable and pointless, since departure/destination
// airport codes are already on hand and the direction is fully determined by
// their real UTC offsets. Production example of the old approach failing:
// YVR->FLL was hand-labeled "Westbound" when it's eastbound (PST -8 -> EST
// -5 is +3, i.e. losing hours). Computed per LEG (this day's departure ->
// this day's destination), not once for the whole pairing — a multi-day
// pairing can cross several genuinely different legs.
//
// IANA zone per major airport code, used with Intl's DST-aware offset
// lookup below rather than a hardcoded static UTC offset (which would be
// wrong half the year for any zone that observes DST). Not exhaustive —
// covers the same North America/Europe/Middle East/Asia-Pacific breadth as
// the roster-parsing IATA reference elsewhere in this file; airports not
// listed here simply produce no computed direction (jetlag guidance is
// skipped for that leg rather than guessed).
const AIRPORT_TIMEZONE = {
  // Canada
  YYZ: "America/Toronto", YUL: "America/Toronto", YOW: "America/Toronto", YQB: "America/Toronto",
  YTZ: "America/Toronto", YHM: "America/Toronto", YKF: "America/Toronto", YXU: "America/Toronto",
  YQG: "America/Toronto", YSB: "America/Toronto", YTS: "America/Toronto", YAM: "America/Toronto",
  YTR: "America/Toronto", YYB: "America/Toronto",
  YVR: "America/Vancouver", YYJ: "America/Vancouver", YXX: "America/Vancouver",
  YYC: "America/Edmonton", YEG: "America/Edmonton",
  YWG: "America/Winnipeg", YQT: "America/Winnipeg", YQM: "America/Moncton",
  YXE: "America/Regina", YQR: "America/Regina",
  YHZ: "America/Halifax", YFC: "America/Moncton",
  YYT: "America/St_Johns", YZF: "America/Yellowknife",
  // USA — Eastern
  JFK: "America/New_York", EWR: "America/New_York", LGA: "America/New_York", BOS: "America/New_York",
  PHL: "America/New_York", IAD: "America/New_York", DCA: "America/New_York", BWI: "America/New_York",
  BDL: "America/New_York", PVD: "America/New_York", ALB: "America/New_York", SYR: "America/New_York",
  BUF: "America/New_York", ROC: "America/New_York", PIT: "America/New_York",
  MIA: "America/New_York", FLL: "America/New_York", MCO: "America/New_York", TPA: "America/New_York",
  RSW: "America/New_York", PBI: "America/New_York", SRQ: "America/New_York", JAX: "America/New_York",
  SAV: "America/New_York", CLT: "America/New_York", RDU: "America/New_York", ORF: "America/New_York",
  RIC: "America/New_York", DTW: "America/New_York", CLE: "America/New_York", CMH: "America/New_York",
  CVG: "America/New_York", IND: "America/New_York", ATL: "America/New_York",
  // USA — Central
  ORD: "America/Chicago", MDW: "America/Chicago", MSP: "America/Chicago", STL: "America/Chicago",
  MKE: "America/Chicago", DFW: "America/Chicago", IAH: "America/Chicago", HOU: "America/Chicago",
  DAL: "America/Chicago", AUS: "America/Chicago", SAT: "America/Chicago", MSY: "America/Chicago",
  BNA: "America/Chicago", MEM: "America/Chicago", BHM: "America/Chicago", OMA: "America/Chicago",
  MCI: "America/Chicago", DSM: "America/Chicago",
  // USA — Mountain
  DEN: "America/Denver", SLC: "America/Denver", ABQ: "America/Denver", BOI: "America/Boise",
  PHX: "America/Phoenix", TUS: "America/Phoenix", // Arizona: no DST
  // USA — Pacific
  LAX: "America/Los_Angeles", SFO: "America/Los_Angeles", SJC: "America/Los_Angeles",
  OAK: "America/Los_Angeles", SAN: "America/Los_Angeles", SEA: "America/Los_Angeles",
  PDX: "America/Los_Angeles", SMF: "America/Los_Angeles", BUR: "America/Los_Angeles",
  LAS: "America/Los_Angeles", RNO: "America/Los_Angeles",
  ANC: "America/Anchorage", HNL: "Pacific/Honolulu", OGG: "Pacific/Honolulu",
  // Mexico / Caribbean / Central & South America
  CUN: "America/Cancun", MEX: "America/Mexico_City", GDL: "America/Mexico_City", MTY: "America/Mexico_City",
  SJD: "America/Mazatlan", PVR: "America/Bahia_Banderas",
  NAS: "America/Nassau", MBJ: "America/Jamaica", KIN: "America/Jamaica", SJU: "America/Puerto_Rico",
  HAV: "America/Havana", PTY: "America/Panama", BOG: "America/Bogota", MDE: "America/Bogota",
  GRU: "America/Sao_Paulo", GIG: "America/Sao_Paulo", EZE: "America/Argentina/Buenos_Aires",
  SCL: "America/Santiago", LIM: "America/Lima", UIO: "America/Guayaquil",
  // UK / Ireland
  LHR: "Europe/London", LGW: "Europe/London", STN: "Europe/London", LTN: "Europe/London",
  LCY: "Europe/London", MAN: "Europe/London", EDI: "Europe/London", GLA: "Europe/London",
  BHX: "Europe/London", BRS: "Europe/London", NCL: "Europe/London", BFS: "Europe/London",
  DUB: "Europe/Dublin", SNN: "Europe/Dublin",
  // Western/Central Europe
  CDG: "Europe/Paris", ORY: "Europe/Paris", NCE: "Europe/Paris", LYS: "Europe/Paris", MRS: "Europe/Paris",
  FRA: "Europe/Berlin", MUC: "Europe/Berlin", BER: "Europe/Berlin", HAM: "Europe/Berlin", DUS: "Europe/Berlin",
  AMS: "Europe/Amsterdam", BRU: "Europe/Brussels", LUX: "Europe/Luxembourg",
  ZRH: "Europe/Zurich", GVA: "Europe/Zurich", VIE: "Europe/Vienna",
  MAD: "Europe/Madrid", BCN: "Europe/Madrid", PMI: "Europe/Madrid", AGP: "Europe/Madrid",
  LIS: "Europe/Lisbon", OPO: "Europe/Lisbon",
  FCO: "Europe/Rome", MXP: "Europe/Rome", VCE: "Europe/Rome", NAP: "Europe/Rome",
  CPH: "Europe/Copenhagen", ARN: "Europe/Stockholm", OSL: "Europe/Oslo", HEL: "Europe/Helsinki",
  PRG: "Europe/Prague", WAW: "Europe/Warsaw", BUD: "Europe/Budapest", ATH: "Europe/Athens",
  // Middle East
  DXB: "Asia/Dubai", AUH: "Asia/Dubai", SHJ: "Asia/Dubai", DOH: "Asia/Qatar", MCT: "Asia/Muscat",
  KWI: "Asia/Kuwait", BAH: "Asia/Bahrain", RUH: "Asia/Riyadh", JED: "Asia/Riyadh",
  AMM: "Asia/Amman", TLV: "Asia/Jerusalem",
  // South / Southeast Asia
  DEL: "Asia/Kolkata", BOM: "Asia/Kolkata", BLR: "Asia/Kolkata", MAA: "Asia/Kolkata",
  CMB: "Asia/Colombo", DAC: "Asia/Dhaka", KTM: "Asia/Kathmandu",
  BKK: "Asia/Bangkok", DMK: "Asia/Bangkok", SGN: "Asia/Ho_Chi_Minh", HAN: "Asia/Bangkok",
  KUL: "Asia/Kuala_Lumpur", SIN: "Asia/Singapore", CGK: "Asia/Jakarta", MNL: "Asia/Manila",
  // East Asia
  HKG: "Asia/Hong_Kong", PEK: "Asia/Shanghai", PVG: "Asia/Shanghai", CAN: "Asia/Shanghai",
  SZX: "Asia/Shanghai", TPE: "Asia/Taipei",
  NRT: "Asia/Tokyo", HND: "Asia/Tokyo", KIX: "Asia/Tokyo", NGO: "Asia/Tokyo", CTS: "Asia/Tokyo",
  FUK: "Asia/Tokyo", OKA: "Asia/Tokyo",
  ICN: "Asia/Seoul", GMP: "Asia/Seoul",
  // Australia / Pacific
  SYD: "Australia/Sydney", MEL: "Australia/Sydney", CBR: "Australia/Sydney",
  BNE: "Australia/Brisbane", OOL: "Australia/Brisbane", CNS: "Australia/Brisbane",
  PER: "Australia/Perth", ADL: "Australia/Adelaide", AKL: "Pacific/Auckland",
  // Africa
  JNB: "Africa/Johannesburg", CPT: "Africa/Johannesburg", NBO: "Africa/Nairobi",
  CAI: "Africa/Cairo", CMN: "Africa/Casablanca", ACC: "Africa/Accra", LOS: "Africa/Lagos",
};

// Real, DST-aware UTC offset (in minutes) for an IANA timezone at a given
// moment, via Intl — no hardcoded "PST is UTC-8" table that goes wrong for
// half the year. Returns 0 (treated as "unknown") if the zone isn't valid.
function getUtcOffsetMinutes(ianaZone, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: ianaZone, timeZoneName: "shortOffset" }).formatToParts(date);
    const offsetPart = parts.find(p => p.type === "timeZoneName")?.value || "";
    const match = offsetPart.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
    if (!match) return null;
    const hours = parseInt(match[1], 10);
    const minutes = match[2] ? parseInt(match[2], 10) : 0;
    return hours * 60 + (hours < 0 ? -minutes : minutes);
  } catch {
    return null;
  }
}

// Direction + magnitude for ONE leg, computed from real airport UTC offsets
// — destination ahead of departure = eastbound = hours LOST; destination
// behind = westbound = hours GAINED. Normalizes to the shorter way around
// the clock for the date-line case: a raw +17h "ahead" (e.g. YVR->NRT) is
// really a -7h jump the other way around, i.e. westbound/gained, not a
// 17-hour eastbound loss. Returns null if either airport is unknown or the
// legs are in the same zone (no meaningful direction to report).
function computeLegDirection(fromStr, toStr, date = new Date()) {
  const fromCode = extractAirportCode(fromStr);
  const toCode = extractAirportCode(toStr);
  if (!fromCode || !toCode || fromCode === toCode) return null;
  const fromZone = AIRPORT_TIMEZONE[fromCode];
  const toZone = AIRPORT_TIMEZONE[toCode];
  if (!fromZone || !toZone) return null;
  const fromOffset = getUtcOffsetMinutes(fromZone, date);
  const toOffset = getUtcOffsetMinutes(toZone, date);
  if (fromOffset === null || toOffset === null) return null;
  let diffMinutes = toOffset - fromOffset;
  if (diffMinutes > 12 * 60) diffMinutes -= 24 * 60;
  if (diffMinutes < -12 * 60) diffMinutes += 24 * 60;
  const hours = Math.round(diffMinutes / 60);
  if (hours === 0) return null;
  return { direction: hours > 0 ? "east" : "west", hours: Math.abs(hours), fromCode, toCode };
}

// The leg actually flown to reach day N's location: day 1 is departure ->
// destinations[0]; day N (N>=2) is destinations[N-2] -> destinations[N-1].
// This is what makes the computation per-LEG rather than per-pairing or
// "first leg only" — a 3-day pairing with a different destination each day
// has up to 3 distinct legs, each potentially a different direction.
function computeLegForDay(data, dayNum) {
  const destinations = data.destinations || [];
  const prevLocation = dayNum <= 1 ? data.departure : destinations[dayNum - 2];
  const currLocation = destinations[dayNum - 1] || data.departure;
  return computeLegDirection(prevLocation, currLocation);
}

function getCognitivePerfRules(data, leg) {
  const reportTime = (data.report_time || "").trim();
  const dutyHours = parseInt(data.duty_hours, 10) || 0;
  const layoverType = (data.layover_type || "").trim();
  const layoverInBase = data.layover_in_base === "yes";

  if (!reportTime && !dutyHours && !layoverType && !leg) return null;

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
    // Minimum rest before a layover counts as "short" is 10h away from home
    // base, 12h at home base — never shorter.
    const minHours = layoverInBase ? 12 : 10;
    const whereText = layoverInBase ? "at home base" : "away from base";
    rules.push(`SHORT LAYOVER (${minHours}–16h, ${whereText} — sleep opportunity): Nutrition must prioritize RECOVERY SLEEP. Pre-sleep: light tryptophan-rich meal (turkey, banana, warm milk). Avoid alcohol, caffeine, and heavy meals within 3h of sleep. On wake: rapid high-protein snack before next duty block.`);
  } else if (layoverType === "long") {
    rules.push(`LONG LAYOVER (24h+): Full recovery window. Day 1 layover: hydrate aggressively, eat anti-inflammatory foods (berries, omega-3 fish, leafy greens). Day 2: align meal timing with destination time zone. Prioritize recovery sleep nutrition (tryptophan, magnesium-rich foods).`);
  }

  // Direction is now derived from real airport UTC offsets (computeLegDirection),
  // never asked of the crew member — see AIRPORT_TIMEZONE above. "east"/direction
  // words here are internal labels for the model's reasoning only; the
  // user-facing jetlagNote text this feeds is separately instructed (see
  // buildAllDaysPrompt) to phrase everything in local time and gained/lost
  // hours, never "eastward"/"westward".
  if (leg?.direction === "east") {
    rules.push(`LOSING ${leg.hours} HOURS THIS LEG (circadian advance — the harder direction): Circadian advance is harder than delay. At destination: eat melatonin-supporting foods in the evening (tart cherries, kiwi, walnuts). Avoid late-night eating — it delays the advance. Get bright-light exposure in the morning at destination. Expect the crew member to feel hungry/sleepy at times that don't match the local clock for the first couple of days.`);
  } else if (leg?.direction === "west") {
    rules.push(`GAINING ${leg.hours} HOURS THIS LEG (circadian delay — the easier direction): Body adjusts more easily when gaining hours than losing them. Allow slightly later meal timing at destination. Bright light exposure in the evening at destination accelerates adjustment. The crew member may feel wide awake well past their normal bedtime for the first night or two.`);
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
        if (d === "allergy_other") return `allergic to ${data.allergy_other_text || "an unspecified ingredient"}`;
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
  // BUDGET_GUIDANCE.low/medium lean on "pantry staples" (rice, beans, pasta,
  // lentils) to offset pricier proteins — that offset doesn't exist for
  // carnivore (zero plant items allowed by definition), so every calorie has
  // to come from animal protein, which is inherently costlier per-calorie.
  // Without this, the model has no signal that $30/day carnivore needs
  // active steering toward cheap proteins (eggs, whole chicken, ground beef,
  // canned tuna/chicken in water, liver) and away from pricier ones (steak,
  // salmon, sardines, specialty cheese) — confirmed live 2026-07-20: a
  // carnivore day repeatedly landed $32-36 against a $30 budget even after
  // repair attempts specifically flagging the overage.
  const carnivoreBudgetNote = rawDiets.includes("carnivore") && (budgetLevel === "low" || budgetLevel === "medium")
    ? ` Carnivore has NO plant-based staples to offset cost with — every calorie must come from animal protein. Build the day mainly around cheap proteins (eggs, whole chicken/thighs/drumsticks, ground beef, canned tuna or chicken packed in water, beef liver) and use pricier items (steak, salmon, sardines, specialty/aged cheese) sparingly, at most once across the whole day.`
    : "";
  const budgetGuidance = BUDGET_GUIDANCE[budgetLevel] + carnivoreBudgetNote;

  const kitchenAccessBlock = buildKitchenAccessBlock(data.kitchen);
  const dietRules = getDietRules(rawDiets, calorieTarget, data);

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
- Jet lag (timezone diff): ${data.timezone || 0} hours${jetlag ? " -- SIGNIFICANT JET LAG, adjust meal timing for circadian rhythm" : ""}
- Kitchen access: ${(data.kitchen || []).join(", ") || "full_kitchen"} (see KITCHEN ACCESS CONSTRAINTS below for what's actually possible)${lunchBag ? `\n- Lunch bag size: ${lunchBag}` : ""}${airplaneMealDesc ? `\n- Airplane meal (provided on board): ${airplaneMealDesc}` : ""}`;

  // buildContext doesn't know which specific day/leg is being generated (it's
  // shared by many call sites, only some of which are per-day) — this is the
  // pairing-level default (leg 1: departure -> destinations[0]), used as-is
  // for the top-level performanceAdvisory summary field. The per-day
  // generation loop (generateOneDay) overrides ctx.cognitivePerfRules and
  // ctx.leg with the CORRECT leg for whichever day it's actually building —
  // that override, not this default, is what the circadian meal-timing
  // logic and jetlagNote instruction actually consume.
  const firstLeg = computeLegForDay(data, 1);
  const cognitivePerfRules = getCognitivePerfRules(data, firstLeg);
  const restrictedBorders = detectRestrictedBorders(data.destinations, data.departure);

  return { langName, dietLabel, rawDiets, jetlag, destinations, profile, hasBudget, perDayBudget, budgetGuidance, calorieTarget, calorieDeficitAmount, gainTarget, maintenanceTarget, goals, kitchenAccessBlock, dietRules, lunchBag, airplaneMealDesc, cookingGuidance, cognitivePerfRules, restrictedBorders, leg: firstLeg };
}

// day.label is regenerated server-side rather than trusted from the model —
// the model usually translates "Day N — Location" correctly, but sometimes
// leaves the English word "Day" in place even when lang=fr/es (a compliance
// slip, not something a regex fixup on the English word can catch once it's
// already happened). Deterministic construction guarantees the label is
// always in the right language, the same philosophy as the allergen/
// meal-substance guards elsewhere in this file.
const DAY_WORD = { en: "Day", fr: "Jour", es: "Día" };
function buildDayLabel(dayNum, loc, lang) {
  const word = DAY_WORD[lang] || DAY_WORD.en;
  return loc ? `${word} ${dayNum} — ${loc}` : `${word} ${dayNum}`;
}

function buildAllDaysPrompt(data, pairingDays, ctx, startDayNum = 1) {
  const hydration = computeHydration(data);
  const daySpecs = Array.from({ length: pairingDays }, (_, i) => {
    const dayNum = startDayNum + i;
    const loc = ctx.destinations[startDayNum - 1 + i] || data.departure;
    // Gated on THIS day's actual leg (ctx.legDirection/ctx.legHours, set
    // per-day by generateOneDay via computeLegForDay) — not ctx.jetlag &&
    // dayNum === 1, which only ever looked at the first leg of the whole
    // pairing. A 4+ pairing with jet lag only on day 3 must still get a
    // jetlagNote on day 3, not just day 1.
    const jetlagInstr = ctx.legDirection && ctx.legHours >= 3
      ? `jetlagNote: short, practical meal-timing advice for adjusting to ${ctx.legHours === 1 ? "1 hour" : `${ctx.legHours} hours`} ${ctx.legDirection === "east" ? "lost" : "gained"} on this leg. Phrase purely in ${loc} local time and in terms of hours gained/lost (e.g. "you'll lose/gain N hours") — never use the words "eastbound"/"westbound"/"eastward"/"westward". Where useful, name the practical body-clock consequence (e.g. "your body clock will want dinner around 2am local time").`
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
Each meal's food must suit its time of day, even under dietary or kitchen constraints — do not default to a lunch/dinner-style savory main (e.g. a shawarma wrap, kebab, or rice bowl) just because it's convenient for the diet or "order from hotel room service." Breakfast should be typical breakfast fare (eggs, oats, yogurt, toast, smoothies, etc., adapted to the diet); Lunch and Dinner should be fuller mains appropriate to those times.
BREAKFAST HARD RULE — this is checked in code, not just requested: canned/oily fish (sardines, anchovies, mackerel, tuna), shellfish, steaks/roasts/dense red meat, stews, curries, pasta, rice-and-meat plates, and soups (except congee) are NEVER breakfast, no matter how well they satisfy the diet or a protein/omega-3 target. Smoked salmon on a bagel IS a normal breakfast; a tin of sardines on yogurt or oats is not. This applies IDENTICALLY across every diet: Mediterranean breakfast = Greek yogurt with honey/nuts, eggs, olives + feta + bread, or fruit — NOT tinned fish. Keto breakfast = eggs, bacon, avocado, cheese — NOT a steak dinner. Vegan breakfast = tofu scramble, oats, smoothies, nut butter toast — NOT a lentil curry. The test for every meal, every slot: would a normal person recognize this as that meal and want to eat it at that time of day?
CRITICAL — DAILY TOTALS, NOT PER-MEAL OPTIMIZATION: if a protein/omega-3/calorie target is hard to hit using slot-appropriate breakfast foods, meet the REST of it at lunch, dinner, or snacks — the daily total across all meals is what's checked, never force an inappropriate food into a slot just to hit a number for that one meal.
The reverse mistake is equally wrong: do NOT put a breakfast/brunch-style dish (a bagel with cream cheese and lox, a pastry plate, a smoothie bowl, cereal, overnight oats) under Dinner or Lunch just because it's convenient or diet-compliant — smoked salmon and cream cheese belong at Breakfast, not Dinner. Dessert (cake, pie, ice cream, cookies) standing in as the entire Lunch or Dinner is equally wrong.
Dinner (and Lunch) must be a substantial, complete main course — protein + a starch/grain/vegetable side, portioned as a full meal — never a single light salad, a cheese/charcuterie plate, or an appetizer-sized dish (e.g. beef carpaccio, prosciutto-wrapped mozzarella, a small tapas plate) standing in as the entire meal.
A Snack must be snack-scale — a small fraction of the daily calorie target, few components (fruit, nuts, yogurt, a small sandwich, veg + dip) — never a full plated dinner-format main (roast, stew, curry, casserole, risotto).
TITLES: name the actual dish, not a compliance statement — "Greek Yogurt Parfait with Berries & Granola", not "Mediterranean Greek Yogurt Parfait with Sardines & Olive Oil Drizzle." Max ~6 words. NEVER put the diet name (Mediterranean, Vegan, Keto, Halal, Gluten-Free, etc.) in the title — the diet is already shown separately as a tag.
Every meal must include a "hero_ingredient" field: the single defining main component in one or two words (e.g. "salmon", "oats", "tofu") — never the diet name. Do not repeat the same hero_ingredient or the same title pattern in the same meal slot on consecutive days — vary proteins and formats across the pairing.
These meal-timing and portion rules apply IDENTICALLY to every day of a multi-day pairing — Day 1 and the LAST day are held to the exact same standard. When reaching for a new/different dish to satisfy the variety requirement below, never let that novelty pull Breakfast into lunch/dinner territory or shrink Dinner down to an appetizer — pick a different full-sized, time-appropriate dish instead.
The meal "type" field must always be the literal English word "Breakfast", "Lunch", "Dinner", or "Snack" — never translate it — even though every other field must be in ${ctx.langName}.
Every meal must include a "tip" and an "emoji" field with 2–3 food emoji accurately representing the meal. Every meal must also include an "ingredients" array listing each distinct ingredient by short name (e.g. "eggs", "spinach", "feta cheese") — specific enough for a crew member to spot a personal allergen, not full recipe steps.${ctx.lunchBag ? `\nFor every packable meal (not airplane meals), include a "container" field specifying the exact Tupperware size and shape that fits the crew member's ${ctx.lunchBag} lunch bag — e.g. "500ml rectangular container", "300ml round container with clip lid", "2× 200ml sauce containers". Size containers to fit within the bag limits.` : ""}${ctx.airplaneMealDesc ? `\nThe crew member has told us their airplane meal will include: "${ctx.airplaneMealDesc}". For any meal of type "airplane_food", describe how to complement or adapt this specific meal (e.g. add protein, skip the dessert, supplement with a snack). Plan the rest of the day's meals to balance the nutrients already provided by this airplane meal.` : ""}
Vary meal choices across all days — different recipes, ingredients, and combinations each day — but variety must never come at the expense of the meal-timing/portion rules above, especially on the final day(s) of the pairing. For grilled or roasted protein mains (Lunch/Dinner), use fresh herb sauces for variety where they fit the diet and kitchen access — e.g. chimichurri on steak/chicken, salsa verde, or a citrus vinaigrette — rather than defaulting to the same plain seasoning every time.

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
  // Derives which countries this itinerary touches purely from airport codes
  // (same lookup detectRestrictedBorders uses) — no user-supplied flag, no
  // guessing, and a destination that can't be resolved simply contributes
  // nothing here rather than blocking or asking.
  const countries = new Set((destinations || []).map(d => getCountryForAirport(extractAirportCode(d))).filter(Boolean));
  const rules = [];

  const DISCLAIMER = "\n⚠️ Rules can change — always verify with the destination country's official customs/border authority or IATA travel advisories before your pairing.";

  // UK — all major airports including secondary London airports
  if (countries.has("uk")) {
    rules.push(`UNITED KINGDOM CUSTOMS (HMRC/DEFRA):
- NO meat or dairy products from outside the UK (post-Brexit rules; EU products now restricted like non-EU).
- Fresh fruit and vegetables from non-EU countries may require phytosanitary certificates.
- Commercially sealed, fully cooked, or shelf-stable products are generally permitted.
- Alcohol duty-free limit: 1L spirits or 2L wine/beer per adult.
- Declare any food exceeding personal allowance — fines up to £5,000 for violations.${DISCLAIMER}`);
  }

  // EU / Schengen — France, Germany, Benelux, Netherlands, Spain, Italy, Portugal, Austria, Switzerland, Scandinavia, Eastern Europe, Ireland, Greece
  if (countries.has("eu")) {
    rules.push(`EU / SCHENGEN AREA CUSTOMS:
- Travelers from outside the EU: NO meat or dairy products allowed (strict EU animal health rules).
- Fresh fruits and vegetables from non-EU countries prohibited without an official phytosanitary certificate.
- Commercially packaged and sealed food (shelf-stable, hermetically sealed) is generally permitted.
- Duty-free limits from non-EU: 1L spirits, 2L wine, 200 cigarettes per adult.
- Declare all food at customs when arriving from non-EU countries — penalties apply for undeclared items.${DISCLAIMER}`);
  }

  // Japan
  if (countries.has("japan")) {
    rules.push(`JAPAN CUSTOMS (Ministry of Agriculture, Forestry and Fisheries):
- Strict plant quarantine: fresh fruits and vegetables from most countries prohibited; must be inspected and certified.
- Meat products from many countries restricted or banned (especially pork from countries with foot-and-mouth disease).
- Commercially sealed processed foods (chips, cookies, sealed instant meals) are generally permitted.
- No soil or plants with roots allowed.
- Declare ALL food items on the customs form — Japan conducts thorough inspections; undeclared items may be confiscated.
- Allowed: packaged snacks, sealed chocolates, vacuum-sealed processed meats with valid inspection certificate.${DISCLAIMER}`);
  }

  // Australia
  if (countries.has("australia")) {
    rules.push(`AUSTRALIA CUSTOMS (DAFF — Department of Agriculture, Fisheries and Forestry):
- VERY strict biosecurity — one of the strictest in the world.
- ALL fresh or dried fruit, vegetables, meat, eggs, seeds, nuts, and plant material must be declared.
- Many fresh and unprocessed items will be confiscated or treated at your expense.
- Commercially sealed and heat-treated packaged goods (sealed chocolates, chips, biscuits) generally OK.
- Failure to declare carries fines up to AUD $2,220 or criminal prosecution.
- Always declare everything on the Incoming Passenger Card — inspectors use detector dogs.${DISCLAIMER}`);
  }

  // UAE / Gulf States — UAE, Qatar, Oman, Kuwait, Bahrain, Saudi Arabia
  if (countries.has("uae")) {
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
  if (countries.has("mexico")) {
    rules.push(`MEXICO CUSTOMS (SAT / SENASICA):
- Duty-free personal allowance: USD $500 in goods per adult (air travel).
- Fresh fruits, vegetables, and unprocessed meat products from abroad may be restricted — SENASICA inspects for agricultural pests.
- Commercial packaged and sealed food products are generally permitted in reasonable personal quantities.
- Declare amounts of cash exceeding USD $10,000 equivalent.
- Food for personal consumption (sealed, commercially packaged) is usually fine — avoid bulk quantities.${DISCLAIMER}`);
  }

  // Canada
  if (countries.has("canada")) {
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

// name/carriedBans are {en, fr, es} — buildCarriedFoodPromptBlock (feeds the
// AI prompt) always uses .en; buildCarriedFoodNote (feeds the user-facing
// foodRestrictions.carried field) uses the crew member's selected language.
const BORDER_COUNTRY_RULES = [
  {
    id: "australia",
    name: { en: "Australia (DAFF biosecurity)", fr: "Australie (biosécurité DAFF)", es: "Australia (bioseguridad DAFF)" },
    codes: ["SYD","MEL","BNE","PER","ADL","CBR","OOL","CNS","DRW","HBA","TSV","MKY","ROK","LST"],
    carriedBans: [
      { en: "Fresh or dried fruit of any kind", fr: "Fruits frais ou séchés, de toute sorte", es: "Fruta fresca o seca de cualquier tipo" },
      { en: "Fresh or dried vegetables of any kind", fr: "Légumes frais ou séchés, de toute sorte", es: "Verduras frescas o secas de cualquier tipo" },
      { en: "Meat, poultry, or seafood (unless commercially heat-treated and sealed)", fr: "Viande, volaille ou fruits de mer (sauf traités thermiquement et scellés commercialement)", es: "Carne, aves o mariscos (a menos que estén tratados térmicamente y sellados comercialmente)" },
      { en: "Eggs or egg products (unless commercially sealed/pasteurized)", fr: "Œufs ou produits à base d'œufs (sauf scellés/pasteurisés commercialement)", es: "Huevos o productos con huevo (a menos que estén sellados/pasteurizados comercialmente)" },
      { en: "Seeds and nuts (unless commercially sealed/packaged)", fr: "Graines et noix (sauf scellées/emballées commercialement)", es: "Semillas y frutos secos (a menos que estén sellados/empaquetados comercialmente)" },
      { en: "Any unpackaged plant material", fr: "Tout matériel végétal non emballé", es: "Cualquier material vegetal sin empaquetar" },
    ],
  },
  {
    id: "usa",
    name: { en: "USA (CBP/USDA)", fr: "États-Unis (CBP/USDA)", es: "Estados Unidos (CBP/USDA)" },
    codes: [
      "JFK","LAX","ORD","ATL","DFW","DEN","SFO","SEA","MIA","BOS","IAD","IAH",
      "PHX","MCO","LAS","MSP","DTW","FLL","CLT","EWR","PHL","SLC","MDW","BWI",
      "SAN","TPA","HNL","PDX","BNA","AUS","RDU","SJC","OAK","MKE","SMF","MSY",
      "RSW","PIT","CMH","ABQ","ONT","BUF","PVD","JAX","ANC","CLE","IND","CVG",
      "OMA","KCI","GRR","SNA","DAL","HOU","SAT","BDL","ORF","RIC","GEG","MEM",
      "BHM","TUS","ELP","STL",
    ],
    carriedBans: [
      { en: "Any fresh fruit (apples, oranges, mangoes, bananas, grapes, berries, citrus, stone fruits, etc.)", fr: "Tout fruit frais (pommes, oranges, mangues, bananes, raisins, baies, agrumes, fruits à noyau, etc.)", es: "Cualquier fruta fresca (manzanas, naranjas, mangos, plátanos, uvas, bayas, cítricos, frutas de hueso, etc.)" },
      { en: "Any fresh vegetable (tomatoes, peppers, leafy greens, cucumbers, carrots, broccoli, onions, etc.)", fr: "Tout légume frais (tomates, poivrons, légumes-feuilles, concombres, carottes, brocoli, oignons, etc.)", es: "Cualquier verdura fresca (tomates, pimientos, verduras de hoja, pepinos, zanahorias, brócoli, cebollas, etc.)" },
      { en: "Raw or undercooked meat, poultry, or seafood", fr: "Viande, volaille ou fruits de mer crus ou insuffisamment cuits", es: "Carne, aves o mariscos crudos o poco cocidos" },
      { en: "Raw eggs or hard-boiled eggs in the shell", fr: "Œufs crus ou œufs durs avec coquille", es: "Huevos crudos o huevos duros con cáscara" },
      { en: "Unpasteurized dairy or soft fresh cheese in unsealed containers", fr: "Produits laitiers non pasteurisés ou fromage frais à pâte molle dans des contenants non scellés", es: "Lácteos no pasteurizados o queso fresco blando en envases no sellados" },
      { en: "Fresh herbs with roots or soil", fr: "Herbes fraîches avec racines ou terre", es: "Hierbas frescas con raíces o tierra" },
    ],
  },
  {
    id: "japan",
    name: { en: "Japan (MAFF quarantine)", fr: "Japon (quarantaine MAFF)", es: "Japón (cuarentena MAFF)" },
    codes: ["NRT","HND","KIX","NGO","CTS","FUK","OKA","OIT","KMI","KMJ","SDJ"],
    carriedBans: [
      { en: "Fresh fruits and vegetables (strict plant quarantine — most prohibited without inspection certificate)", fr: "Fruits et légumes frais (quarantaine végétale stricte — la plupart interdits sans certificat d'inspection)", es: "Frutas y verduras frescas (cuarentena vegetal estricta — la mayoría prohibidas sin certificado de inspección)" },
      { en: "Unprocessed or uninspected meat/poultry (especially pork from FMD-risk countries)", fr: "Viande/volaille non transformée ou non inspectée (en particulier le porc en provenance de pays à risque de fièvre aphteuse)", es: "Carne/aves no procesadas o no inspeccionadas (especialmente cerdo de países con riesgo de fiebre aftosa)" },
      { en: "Plants with soil or roots", fr: "Plantes avec terre ou racines", es: "Plantas con tierra o raíces" },
    ],
  },
  {
    id: "eu",
    name: { en: "EU/Schengen border", fr: "Frontière UE/Schengen", es: "Frontera UE/Schengen" },
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
      { en: "Meat and meat products from outside the EU", fr: "Viande et produits carnés en provenance de l'extérieur de l'UE", es: "Carne y productos cárnicos de fuera de la UE" },
      { en: "Dairy products from outside the EU", fr: "Produits laitiers en provenance de l'extérieur de l'UE", es: "Productos lácteos de fuera de la UE" },
      { en: "Fresh fruits and vegetables from non-EU countries (without phytosanitary certificate)", fr: "Fruits et légumes frais en provenance de pays hors UE (sans certificat phytosanitaire)", es: "Frutas y verduras frescas de países fuera de la UE (sin certificado fitosanitario)" },
    ],
  },
  {
    id: "uk",
    name: { en: "United Kingdom (HMRC/DEFRA)", fr: "Royaume-Uni (HMRC/DEFRA)", es: "Reino Unido (HMRC/DEFRA)" },
    codes: ["LHR","LGW","LTN","LCY","STN","MAN","EDI","GLA","BHX","BRS","NCL","LBA","ABZ","BFS","BHD","SOU","EXT","CWL"],
    carriedBans: [
      { en: "Meat and dairy from outside the UK (post-Brexit — EU products are also restricted)", fr: "Viande et produits laitiers en provenance de l'extérieur du Royaume-Uni (depuis le Brexit, les produits de l'UE sont également restreints)", es: "Carne y lácteos de fuera del Reino Unido (tras el Brexit, los productos de la UE también están restringidos)" },
      { en: "Fresh fruit and vegetables from non-EU countries without phytosanitary certificates", fr: "Fruits et légumes frais en provenance de pays hors UE sans certificats phytosanitaires", es: "Frutas y verduras frescas de países fuera de la UE sin certificados fitosanitarios" },
    ],
  },
  {
    id: "uae",
    name: { en: "UAE/Gulf States", fr: "EAU/États du Golfe", es: "EAU/Estados del Golfo" },
    codes: ["DXB","AUH","SHJ","DWC","AAN","RKT","FJR","DOH","MCT","SLL","KWI","BAH","RUH","JED","DMM","MED","TUU","AHB","GIZ"],
    carriedBans: [
      { en: "Pork products of any kind", fr: "Produits à base de porc, de toute sorte", es: "Productos de cerdo de cualquier tipo" },
      { en: "Alcoholic beverages", fr: "Boissons alcoolisées", es: "Bebidas alcohólicas" },
    ],
  },
  {
    id: "canada",
    name: { en: "Canada (CBSA/CFIA)", fr: "Canada (ASFC/ACIA)", es: "Canadá (CBSA/CFIA)" },
    codes: ["YYZ","YVR","YUL","YYC","YEG","YOW","YWG","YHZ","YQB","YXE","YQR","YXX","YXU","YHM","YWG","YQM","YFC","YQT","YZF"],
    carriedBans: [
      { en: "Fresh fruits and vegetables without a phytosanitary certificate", fr: "Fruits et légumes frais sans certificat phytosanitaire", es: "Frutas y verduras frescas sin certificado fitosanitario" },
      { en: "Meat, poultry, and meat products (unless commercially canned/pouched and shelf-stable)", fr: "Viande, volaille et produits carnés (sauf en conserve/pochette commerciale et stables à température ambiante)", es: "Carne, aves y productos cárnicos (a menos que estén enlatados/empaquetados comercialmente y sean estables en anaquel)" },
      { en: "Raw or unpasteurized dairy products", fr: "Produits laitiers crus ou non pasteurisés", es: "Productos lácteos crudos o no pasteurizados" },
      { en: "Raw eggs or egg products (unless commercially sealed/pasteurized)", fr: "Œufs crus ou produits à base d'œufs (sauf scellés/pasteurisés commercialement)", es: "Huevos crudos o productos con huevo (a menos que estén sellados/pasteurizados comercialmente)" },
      { en: "Plants, seeds, or soil-bearing plant material", fr: "Plantes, graines ou matériel végétal contenant de la terre", es: "Plantas, semillas o material vegetal con tierra" },
    ],
  },
  {
    id: "mexico",
    name: { en: "Mexico (SAT/SENASICA)", fr: "Mexique (SAT/SENASICA)", es: "México (SAT/SENASICA)" },
    codes: ["MEX","CUN","GDL","MTY","TLC","SJD","PVR","MID","OAX","VER","TAM","ZIH","MZT","HMO","CUU","TIJ","MXL","LAP","MLM","BJX","QRO"],
    carriedBans: [
      { en: "Fresh fruits and vegetables (subject to SENASICA agricultural-pest inspection)", fr: "Fruits et légumes frais (soumis à l'inspection phytosanitaire de la SENASICA)", es: "Frutas y verduras frescas (sujetas a inspección fitosanitaria de SENASICA)" },
      { en: "Raw or unprocessed meat products", fr: "Viande crue ou non transformée", es: "Carne cruda o sin procesar" },
    ],
  },
];

// Fallback country derivation for any airport not in one of the curated
// BORDER_COUNTRY_RULES.codes lists above (those lists cover the major
// airports for each country's customs regime, not every airport on earth).
// Reuses AIRPORT_TIMEZONE — already comprehensive across far more airports
// than any single customs list — so a country is still resolved without
// ever having to ask the crew member to confirm it themselves.
const TIMEZONE_TO_BORDER_COUNTRY = {
  "America/Toronto": "canada", "America/Vancouver": "canada", "America/Edmonton": "canada",
  "America/Winnipeg": "canada", "America/Moncton": "canada", "America/Regina": "canada",
  "America/Halifax": "canada", "America/St_Johns": "canada", "America/Yellowknife": "canada",
  "America/New_York": "usa", "America/Chicago": "usa", "America/Denver": "usa",
  "America/Boise": "usa", "America/Phoenix": "usa", "America/Los_Angeles": "usa",
  "America/Anchorage": "usa", "Pacific/Honolulu": "usa",
  "America/Cancun": "mexico", "America/Mexico_City": "mexico", "America/Mazatlan": "mexico",
  "America/Bahia_Banderas": "mexico",
  "Europe/London": "uk",
  "Europe/Paris": "eu", "Europe/Berlin": "eu", "Europe/Amsterdam": "eu", "Europe/Brussels": "eu",
  "Europe/Luxembourg": "eu", "Europe/Zurich": "eu", "Europe/Vienna": "eu", "Europe/Madrid": "eu",
  "Europe/Lisbon": "eu", "Europe/Rome": "eu", "Europe/Copenhagen": "eu", "Europe/Stockholm": "eu",
  "Europe/Oslo": "eu", "Europe/Helsinki": "eu", "Europe/Prague": "eu", "Europe/Warsaw": "eu",
  "Europe/Budapest": "eu", "Europe/Athens": "eu", "Europe/Dublin": "eu",
  "Asia/Dubai": "uae", "Asia/Qatar": "uae", "Asia/Muscat": "uae", "Asia/Kuwait": "uae",
  "Asia/Bahrain": "uae", "Asia/Riyadh": "uae",
  "Asia/Tokyo": "japan",
  "Australia/Sydney": "australia", "Australia/Brisbane": "australia", "Australia/Perth": "australia",
  "Australia/Adelaide": "australia",
};

// Resolves any airport code to a BORDER_COUNTRY_RULES id (or null if it
// can't be resolved at all) — never asks the crew member, always derives.
// Checks the curated codes lists first (exact customs-regime membership),
// then falls back to the IANA-timezone-based mapping above for broader
// coverage. Returns null (not a guess) for anything unresolvable, which
// callers treat as "no rule applies" rather than blocking the user.
function getCountryForAirport(code) {
  if (!code) return null;
  for (const rule of BORDER_COUNTRY_RULES) {
    if (rule.codes.includes(code)) return rule.id;
  }
  const zone = AIRPORT_TIMEZONE[code];
  return (zone && TIMEZONE_TO_BORDER_COUNTRY[zone]) || null;
}

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
function detectRestrictedBorders(destinations, departure) {
  const dests = destinations || [];
  const found = [];
  for (const rule of BORDER_COUNTRY_RULES) {
    const days = [];
    dests.forEach((d, i) => {
      if (d && getCountryForAirport(extractAirportCode(d)) === rule.id) days.push(i + 1);
    });
    const onReturn = getCountryForAirport(extractAirportCode(departure)) === rule.id;
    if (days.length > 0 || onReturn) found.push({ id: rule.id, name: rule.name, carriedBans: rule.carriedBans, days, onReturn });
  }
  return found;
}

// Union of every banned item across all restricted borders (deduped by the
// English text, regardless of which lang is returned, so the same item
// mentioned by two different border rules doesn't appear twice).
function unionCarriedBans(restrictedBorders, lang = "en") {
  const seen = new Set();
  const bans = [];
  for (const b of restrictedBorders) {
    for (const ban of b.carriedBans) {
      if (!seen.has(ban.en)) { seen.add(ban.en); bans.push(ban[lang] || ban.en); }
    }
  }
  return bans;
}

// Prompt block injected into the DAYS and EXTRAS AI prompts — always English,
// regardless of the crew member's language, since this instructs the model
// rather than being shown to the user (see buildCarriedFoodNote for that).
function buildCarriedFoodPromptBlock(restrictedBorders) {
  if (!restrictedBorders || restrictedBorders.length === 0) return "";
  const countryLines = restrictedBorders.map(b => {
    const parts = [];
    if (b.days.length > 0) parts.push(`Day${b.days.length > 1 ? "s" : ""} ${b.days.join(" & ")}`);
    if (b.onReturn) parts.push("on return home");
    const dayStr = parts.length > 0 ? ` (${parts.join("; ")})` : " (during this pairing)";
    return `  • ${b.name.en}${dayStr}`;
  }).join("\n");
  const banLines = unionCarriedBans(restrictedBorders, "en").map(b => `  ❌ ${b}`).join("\n");
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

// Static template strings for buildCarriedFoodNote, by language.
const CARRIED_NOTE_TEXT = {
  en: {
    day: (nums) => `Day ${nums.join(", ")}`,
    onReturn: "on return home",
    crossesOne: "Your bag crosses a restricted border on this pairing:",
    crossesMany: "Your bag crosses multiple restricted borders on this pairing:",
    mustClear: "Any food packed at home or carried between stops must clear ALL of these customs checkpoints. The following items cannot be packed or carried anywhere on this pairing:",
    locallyPurchased: "Locally-purchased food bought and eaten entirely at one stop (nothing packed for later) does not have these restrictions.",
    safeToCarry: "Safe to pack and carry: commercially packaged and sealed, canned, dried, or shelf-stable items only.",
  },
  fr: {
    day: (nums) => `Jour ${nums.join(", ")}`,
    onReturn: "au retour",
    crossesOne: "Votre bagage traverse une frontière à restrictions durant ce pairing :",
    crossesMany: "Votre bagage traverse plusieurs frontières à restrictions durant ce pairing :",
    mustClear: "Tout aliment emballé à la maison ou transporté entre les escales doit franchir TOUS ces points de contrôle douanier. Les articles suivants ne peuvent être emballés ni transportés à aucun moment durant ce pairing :",
    locallyPurchased: "Les aliments achetés localement et entièrement consommés à une même escale (rien de conservé pour plus tard) ne sont pas soumis à ces restrictions.",
    safeToCarry: "Sûrs à emballer et transporter : uniquement des aliments emballés et scellés commercialement, en conserve, séchés, ou stables à température ambiante.",
  },
  es: {
    day: (nums) => `Día ${nums.join(", ")}`,
    onReturn: "al regreso",
    crossesOne: "Tu equipaje cruza una frontera con restricciones durante este pairing:",
    crossesMany: "Tu equipaje cruza varias fronteras con restricciones durante este pairing:",
    mustClear: "Cualquier alimento empacado en casa o transportado entre escalas debe cumplir con TODOS estos controles aduaneros. Los siguientes artículos no se pueden empacar ni transportar en ningún momento durante este pairing:",
    locallyPurchased: "Los alimentos comprados localmente y consumidos por completo en una sola escala (sin guardar nada para después) no están sujetos a estas restricciones.",
    safeToCarry: "Seguro para empacar y transportar: solo alimentos empaquetados y sellados comercialmente, enlatados, secos, o estables a temperatura ambiente.",
  },
};

// User-facing text added server-side to foodRestrictions.carried — not
// generated by the model, so it needs its own localization (see
// CARRIED_NOTE_TEXT above and the {en,fr,es} shape on BORDER_COUNTRY_RULES).
function buildCarriedFoodNote(restrictedBorders, lang = "en") {
  if (!restrictedBorders || restrictedBorders.length === 0) return null;
  const t = CARRIED_NOTE_TEXT[lang] || CARRIED_NOTE_TEXT.en;
  const countryStrs = restrictedBorders.map(b => {
    const parts = [];
    if (b.days.length > 0) parts.push(t.day(b.days));
    if (b.onReturn) parts.push(t.onReturn);
    const name = b.name[lang] || b.name.en;
    return `${name}${parts.length > 0 ? ` (${parts.join("; ")})` : ""}`;
  });
  const bans = unionCarriedBans(restrictedBorders, lang);
  const crosses = countryStrs.length > 1 ? t.crossesMany : t.crossesOne;
  return `${crosses} ${countryStrs.join("; ")}.\n\n${t.mustClear}\n${bans.map(b => `• ${b}`).join("\n")}\n\n${t.locallyPurchased}\n\n${t.safeToCarry}`;
}

// Per-country customs breakdown for display — deterministic, server-computed
// directly from restrictedBorders (the SAME array the customs_matches_
// destination Wall rule checks against), never from model prose. This is
// what guarantees the displayed rules always match what was actually
// applied to the plan: it's not a description of the rules, it IS the rules.
// One entry per restricted country this pairing touches, day-labeled the
// same way buildCarriedFoodNote already labels them, with the country's
// actual ban list in plain language (BORDER_COUNTRY_RULES.carriedBans).
function buildCustomsByCountry(restrictedBorders, lang = "en") {
  const t = CARRIED_NOTE_TEXT[lang] || CARRIED_NOTE_TEXT.en;
  return (restrictedBorders || []).map(b => {
    const parts = [];
    if (b.days.length > 0) parts.push(t.day(b.days));
    if (b.onReturn) parts.push(t.onReturn);
    return {
      id: b.id,
      name: b.name[lang] || b.name.en,
      dayLabel: parts.length > 0 ? parts.join("; ") : null,
      // Raw days/onReturn alongside the formatted dayLabel — lets the client
      // pin a note to the SPECIFIC day it applies to (e.g. a badge on that
      // day's plan view), not just show the country breakdown in one place.
      days: b.days,
      onReturn: b.onReturn,
      bans: b.carriedBans.map(ban => ban[lang] || ban.en),
    };
  });
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
- "foodRestrictions": "usa" (${ctx.restrictedBorders.some(b => b.id === "usa") ? "practical list of what cannot be brought into the USA and why" : "Not applicable — not traveling to the USA"}), "destination" (summarize the DESTINATION CUSTOMS & FOOD RULES above into practical crew-focused bullet points for ${ctx.destinations.join(", ")}), "general" (general tips for a ${ctx.dietLabel} diet while traveling).`;
}

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "NutriCrew AI backend is running" });
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────

// DEV/TEST-ONLY: in-memory cache of the last OTP issued per email, populated
// ONLY when RESEND_API_KEY is unset — the exact same condition that already
// makes send-otp log the code to the console instead of emailing it (see
// below). Exposed via GET /api/auth/dev-otp so an automated E2E smoke test
// can read the real code without parsing process stdout or needing a live
// inbox. Always 403s in production, where RESEND_API_KEY is always set —
// this introduces no new information disclosure beyond what already prints
// to the console in dev mode.
const DEV_OTP_CACHE = new Map();

app.get("/api/auth/dev-otp", (req, res) => {
  if (process.env.RESEND_API_KEY) return res.status(403).json({ error: "Not available when email sending is configured." });
  const email = (req.query.email || "").toLowerCase().trim();
  const otp = DEV_OTP_CACHE.get(email);
  if (!otp) return res.status(404).json({ error: "No OTP on file for this email." });
  res.json({ otp });
});

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
      DEV_OTP_CACHE.set(email.toLowerCase().trim(), otp);
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
  diets: "diets", diet_other: "dietOther", allergy_other_text: "allergyOtherText", goals: "goals",
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
const CACHE_SCHEMA_VERSION = "v10";

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
  return { ...base, destinationKey: destinations.join(",") || "none", goingUsa: ctx.restrictedBorders.some(b => b.id === "usa") ? "yes" : "no", pairingDays };
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

// ═══════════════════════════════════════════════════════════════════════════
// ─── THE WALL — LAYER 2: JUDGE MODEL (plausibility review) ──────────────────
// ═══════════════════════════════════════════════════════════════════════════
// Runs only once Layer 1 is clean — it's a plausibility/common-sense check
// for what CAN'T be enumerated as a rule (novel absurdity), never a
// substitute for any deterministic rule. NEVER the check for allergens, diet
// compliance, calories, or budget — those stay Layer-1-only, always, and the
// judge is never consulted for them. Best-effort: if the call itself fails
// (timeout, malformed response), log it and proceed WITHOUT a judge opinion
// rather than fail the whole plan on a judge outage — Layer 1 is the actual
// safety net regardless of whether Layer 2 is available this request.
const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          meal_index: { type: "integer", description: "0-based index matching the numbered list in the prompt." },
          verdict: { type: "string", enum: ["ok", "odd"] },
          reason: { type: "string", description: "One sentence. Required even for 'ok' — briefly say why it's normal." },
        },
        required: ["meal_index", "verdict", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
};

async function runJudge(meals) {
  const mealList = meals.map((m, i) => `${i}. [${m.type}] "${m.name}" — ${m.description || ""} (hero ingredient: ${m.hero_ingredient || "unspecified"}, ${m.calories} kcal)`).join("\n");
  const prompt = `You are reviewing a generated meal plan for aviation crew. For each meal below, answer: would a normal person recognize this as its stated meal type (Breakfast/Lunch/Dinner/Snack) and actually want to eat it at that time of day? Flag anything odd, unappetizing, culturally incoherent, implausible, or that a real person would find strange — this includes food that's technically diet-compliant but wrong for the slot (e.g. a canned fish breakfast), a meal that doesn't match its own stated hero ingredient, or a combination no real menu would ever produce. Be skeptical — you are the last check before a paying customer sees this.

MEALS:
${mealList}

Return one verdict per meal, in the same order, using its 0-based index above as meal_index.`;
  try {
    const result = await runStructured(prompt, JUDGE_SCHEMA, 700, FAST_MODEL);
    return result.verdicts || [];
  } catch (e) {
    console.error(`[judge] call failed, proceeding without a judge opinion this request: ${e.message}`);
    return [];
  }
}

// How many extra validate-then-regenerate passes a single day gets before
// generation gives up on it entirely (returns null / marks it failed)
// rather than ever serving a plan that failed validation. BLOCK violations
// (allergens) never reach this loop at all (see generateOneDay:
// hasBlockingViolation fails immediately, no repair attempt).
// Was cut from 2 to 1 on 2026-07-20 as a latency experiment, per the plan
// then: watch prod failure-rate and revert if days that previously
// recovered on the 2nd repair attempt started failing outright instead.
// They did — within hours, tight-constraint combos (e.g. a restrictive diet
// stacked with a tight day budget) that reliably needed both attempts
// started getting marked failed after just one, surfacing as "Day N
// couldn't be generated" for users who'd have gotten a clean plan before.
// Reverted back to 2.
const REPAIR_ATTEMPTS = 2;

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
    const rawBankEntries = ctx.restrictedBorders.length === 0 ? (PLAN_BANK_MAP[bankLookupKey] || []) : [];
    // Bank entries are pre-generated offline (generate-bank.js) and must clear
    // the SAME hard validator as freshly-generated content before they're
    // trusted — being pre-generated is not a validation exemption. Any entry
    // that fails is discarded here, BEFORE reservePairingUsage is called, so
    // execution falls through to normal AI generation exactly as if the bank
    // had missed (no double-reservation risk from validating after the slot
    // is already consumed).
    const bankEntries = rawBankEntries.filter(entry => {
      const { valid, violations } = validatePlan({ days: entry.days.map((d, i) => ({ day: i + 1, meals: d.meals })) }, data, lang);
      if (!valid) {
        console.warn(`[bank] entry for ${bankLookupKey} failed validation, discarding: ${violations.map(v => `${v.code}(day${v.day}${v.mealName ? `,"${v.mealName}"` : ""})`).join(", ")}`);
      }
      return valid;
    });
    if (bankEntries.length > 0) {
      // Atomic check-and-consume: closes the race where two concurrent
      // requests could both read "allowed" before either had incremented.
      const usage = await reservePairingUsage(email, data.name, req.ip);
      if (!usage.allowed) {
        return res.status(403).json({
          error: "premium_required",
          message: PREMIUM_REQUIRED_MESSAGE,
          pairingCount: usage.pairingCount,
          needsPremium: true,
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
      // Already validated (see rawBankEntries filter above) — no per-serve
      // guard pass needed. Relabel deterministically since the bank's static
      // "label" is always plain English regardless of lang.
      const entry = bankEntries[Math.floor(Math.random() * bankEntries.length)];
      const guardedBankDays = entry.days.map((d, i) => ({
        ...d,
        label: buildDayLabel(i + 1, ctx.destinations[i] || data.departure, lang),
      }));
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
        // Premium-only, same reasoning as generateOneDay's dayCtx.cognitivePerfRules below.
        performanceAdvisory: usage.isPremium ? getCognitivePerfRules(data, ctx.leg) : null,
        hydration: computeHydration(data),
        pairingCount: usage.pairingCount,
        isPremium: usage.isPremium,
        needsPremium: usage.needsPremium,
        hasPassword: usage.hasPassword,
      });
    }

    // ── Normal flow (bank miss) ───────────────────────────────────
    // Run auth check, meal cache query, and extras cache query all in parallel.
    // reservePairingUsage atomically checks-and-consumes in one DB operation —
    // closes the race where two concurrent requests could both read
    // "allowed" before either had incremented.
    const [usage, { days: rawCachedDays }, cachedExtras] = await Promise.all([
      reservePairingUsage(email, data.name, req.ip),
      queryCachedDays(email, cacheKey, pairingDays),
      queryExtrasCache(extrasKey),
    ]);

    // A cached plan is still a plan — the Wall runs on READ here too, not
    // just on write (storeCachedDays only ever stores days that already
    // passed Layer 1 at write time — see below — but a rule can be ADDED to
    // WALL_RULES later without a CACHE_SCHEMA_VERSION bump, since no new
    // required MEAL_SCHEMA field is necessarily involved; the version bump
    // alone can't catch that). Any cached day failing the CURRENT registry
    // is dropped here, before the cache-hit/cache-miss branch below decides
    // anything — a dropped day is simply treated as a cache miss for that
    // slot and falls through to normal fresh generation like any other gap.
    // WARN-severity findings (e.g. hero_ingredient_agreement) don't discard
    // a day — only BLOCK/REPAIR do, same bar as everything else in the Wall.
    const { tags: cacheRequiredAllergenTags, customAllergyTerm: cacheCustomAllergyTerm } = getUserRequiredAllergenAvoidance(data);
    const cacheActiveDietTags = reqDiets.filter(d => DIET_PROHIBITED[d] || d === "kosher" || d === "low_carb");
    const cachedDays = rawCachedDays.filter(d => {
      const { violations } = validateDay(d.meals, {
        requiredAllergenTags: cacheRequiredAllergenTags, customAllergyTerm: cacheCustomAllergyTerm,
        activeDietTags: cacheActiveDietTags, expectedStructure: getExpectedMealStructure(ctx),
        calorieTarget: ctx.calorieTarget ?? ctx.gainTarget ?? ctx.maintenanceTarget ?? null,
        calorieTolerance: ctx.maintenanceTarget && !ctx.calorieTarget && !ctx.gainTarget ? 0.15 : 0.10,
        perDayBudget: ctx.perDayBudget, kitchenList: data.kitchen || [], restrictedBorders: ctx.restrictedBorders,
      });
      const blocking = violations.filter(v => v.severity !== "WARN");
      if (blocking.length === 0) return true;
      for (const v of blocking) logWallViolation({ ...v, day: null, attempt: 0, source: "cache-read" });
      console.warn(`[wall] cached day for ${email} failed re-validation on read, discarding (treated as cache miss): ${blocking.map(v => v.ruleId ?? v.code).join(", ")}`);
      return false;
    });

    if (!usage.allowed) {
      return res.status(403).json({
        error: "premium_required",
        message: PREMIUM_REQUIRED_MESSAGE,
        pairingCount: usage.pairingCount,
        needsPremium: true,
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
    // 2000 tokens: raised from 1200 (2026-07-20) — summary + grocery list +
    // foodRestrictions (usa/destination/general prose, each can run long for
    // multi-country or USA-restricted pairings) routinely filled the old cap
    // exactly (out=1200 on every single request for a USA-restricted test
    // scenario, meaning it was truncating every time, not occasionally), so
    // extractJSON reliably threw a SyntaxError on truncated output. The
    // rejection is pre-observed via .catch(() => {}) below so it can't crash
    // the process as an unhandled rejection, but it still surfaced as a
    // clean 500 "Internal server error" once actually awaited — same root
    // cause class as the DAYS_SCHEMA cap raised earlier today.
    const extrasPromise = cachedExtras
      ? Promise.resolve(cachedExtras)
      : runStructured(buildExtrasPrompt(data, pairingDays, ctx), EXTRAS_SCHEMA, 2000, FAST_MODEL)
          .then(result => { storeExtrasCache(extrasKey, result); return result; });
    // extrasPromise isn't awaited until after day generation + guards run, which can
    // take a while — if it rejects (e.g. truncated JSON from the model) before then,
    // Node flags it as an unhandled rejection and kills the whole function process,
    // producing a hard 500 instead of the graceful error handling below. Attaching a
    // no-op .catch() here just marks it "observed" immediately; it doesn't consume
    // the rejection, so the real `await extrasPromise` below still throws normally.
    extrasPromise.catch(() => {});

    if (cachedDays.length >= pairingDays) {
      // Full cache hit — no DAYS API call needed
      days = cachedDays.slice(0, pairingDays).map((d, i) => ({
        day: i + 1,
        label: buildDayLabel(i + 1, ctx.destinations[i] || data.departure, lang),
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
      // Pass the TRUE total pairingDays here, not `missing` — perDayBudget for a
      // "total" budget_type is budgetAmount/pairingDays, and this ctx's calorie/
      // budget numbers feed the guard + prompts for the freshly-generated days,
      // which must still divide the trip's total budget by the whole trip length,
      // not just by how many days happened to miss the cache.
      const missingCtx = buildContext(missingData, lang, pairingDays);
      console.log(`[calorie-debug] gender=${missingData.gender} weight=${missingData.weight} dob=${missingData.dob} age=${missingData.age} → maintenanceTarget=${missingCtx.maintenanceTarget} calorieTarget=${missingCtx.calorieTarget} gainTarget=${missingCtx.gainTarget} cacheKey.calorieTargetKey=${buildCacheKey(missingData, missingCtx, lang).calorieTargetKey}`);

      // Generates ONE day, then validates + repairs it up to REPAIR_ATTEMPTS
      // times before ever handing it back — this is the "model proposes, code
      // validates, nothing unvalidated gets served" gate for freshly-generated
      // content. Returns null only if the day still fails after every repair
      // attempt, which the caller treats as a hard generation failure for
      // that day (never a violating meal silently served).
      const generateOneDay = async (dayIndex) => {
        const overallDayNum = cachedDays.length + dayIndex + 1;
        // Use per-day kitchen if provided; fall back to the shared kitchen setting.
        // Always coerce to array: kitchen_by_day[i] might be a string if the
        // client serialized a single-element array as a scalar.
        const rawKitchen = Array.isArray(missingData.kitchen_by_day)
          ? (missingData.kitchen_by_day[overallDayNum - 1] || missingData.kitchen || [])
          : (missingData.kitchen || []);
        const dayKitchen = Array.isArray(rawKitchen) ? rawKitchen : (rawKitchen ? [rawKitchen] : []);
        const dayData = { ...missingData, kitchen: dayKitchen };
        // Same total-vs-local-count bug as missingCtx above: this ctx's perDayBudget
        // must divide by the whole pairing's day count, not by "1" (this call only
        // generates ONE day's meals) — otherwise a "total trip budget" gets used as
        // if it were a single day's budget, e.g. "$300 total for 5 days" becomes
        // "$300/day" in this day's prompt instead of the correct $60/day.
        const dayCtx = buildContext(dayData, lang, pairingDays);
        // buildContext only knows the pairing-level FIRST leg (see firstLeg
        // there) — override with the leg for the SPECIFIC day being
        // generated here, so a multi-day pairing gets correct, independently
        // computed circadian guidance for every day, not just day 1.
        const dayLeg = computeLegForDay(dayData, overallDayNum);
        // "Cognitive Performance meal timing" (duty-schedule + jetlag-direction
        // optimized food choices) is an advertised premium feature (see the
        // gold-highlighted bullet on the paywall) — gate it on the real
        // subscription (usage.isPremium, closed over from reservePairingUsage
        // above), not on whether this pairing happens to be the free one.
        // legDirection/legHours stay ungated below: those only drive the
        // plain-language jetlagNote ("you'll lose/gain N hours"), a separate,
        // always-free basic feature, not this premium protocol.
        dayCtx.cognitivePerfRules = usage.isPremium ? getCognitivePerfRules(dayData, dayLeg) : null;
        dayCtx.legDirection = dayLeg?.direction || null;
        dayCtx.legHours = dayLeg?.hours || 0;

        // 6000 tokens: the richer per-meal schema (structured ingredients,
        // allergens_present, diet_tags, prep_method) plus verbose multi-country
        // customs tips need more room than the old flat-string schema did.
        // Raised from 4200 (2026-07-20): "Day N returned only 1 meals" was the
        // single most frequent production error over the prior 7 days (28
        // occurrences) — a day with richer-than-usual content (long diet
        // combos, multi-country customs, verbose tips) fills 5 meals'-worth of
        // structured fields and hits the token cap mid-generation, silently
        // truncating the response to whatever meal was in progress. This is a
        // cap, not a fixed spend — raising it costs nothing on the (common)
        // cases that already fit in 4200.
        const requestFreshDay = () => runStructured(
          buildAllDaysPrompt(dayData, 1, dayCtx, overallDayNum),
          DAYS_SCHEMA, 6000, FAST_MODEL
        ).then(r => {
          const meals = r?.days?.[0]?.meals;
          if (!meals || meals.length < 3) {
            throw new Error(`Day ${overallDayNum} returned only ${meals?.length ?? 0} meals`);
          }
          return r.days[0];
        });

        // Deterministic calorie guard: if the model's meal sum drifts outside
        // the target ± tolerance, proportionally rescale so the total is
        // guaranteed to land within band without an extra AI call. Runs after
        // every fresh generation AND after every meal-level repair, since a
        // swapped meal can shift the day's total.
        const guardTarget = dayCtx.calorieTarget ?? dayCtx.gainTarget ?? dayCtx.maintenanceTarget;
        const guardTolerance = dayCtx.maintenanceTarget ? 0.15 : 0.10;
        const rescale = (meals) => guardTarget
          ? rescaleMealsToTarget(meals, guardTarget, guardTolerance)
          : { meals, totalCalories: meals.reduce((s, m) => s + (m.calories || 0), 0) };

        const { tags: requiredAllergenTags, customAllergyTerm } = getUserRequiredAllergenAvoidance(dayData);
        const rawDietsForDay = Array.isArray(dayData.diets) ? dayData.diets : (dayData.diet ? [dayData.diet] : []);
        const activeDietTags = rawDietsForDay.filter(d => DIET_PROHIBITED[d] || d === "kosher" || d === "low_carb");
        const validateOpts = {
          requiredAllergenTags, customAllergyTerm, activeDietTags,
          expectedStructure: getExpectedMealStructure(dayCtx),
          calorieTarget: guardTarget, calorieTolerance: guardTolerance,
          perDayBudget: dayCtx.perDayBudget, kitchenList: dayKitchen, restrictedBorders: dayCtx.restrictedBorders,
        };

        let raw;
        let meals, totalCalories;
        let violations;
        // BLOCK fails closed — a violating MEAL is never patched/repaired,
        // full stop, and that guarantee is unchanged below. But until now,
        // a BLOCK on the very first generation killed the whole day with
        // ZERO chance at a fresh, independent attempt — a harsher bar than
        // every other failure path gets (malformed JSON gets one retry;
        // day-level REPAIR violations get a full fresh regeneration; only
        // "the first draft happened to contain a real or false-positive
        // allergen" got none). A fresh regeneration is a brand-new AI
        // response from scratch, not a patch of the known-bad one, so it
        // doesn't weaken the zero-tolerance guarantee — it just gives the
        // model another independent roll before permanently failing the
        // day. Confirmed live 2026-07-20: a gluten-free user's day failed
        // outright on a single BLOCK hit with no chance to recover.
        for (let blockAttempt = 1; blockAttempt <= REPAIR_ATTEMPTS; blockAttempt++) {
          try {
            raw = await requestFreshDay();
          } catch (e) {
            console.warn(`[generate-plan] Day ${overallDayNum} initial generation failed: ${e.message} — retrying`);
            try {
              raw = await requestFreshDay();
            } catch (e2) {
              console.error(`[generate-plan] Day ${overallDayNum} failed after retry: ${e2.message}`);
              return null;
            }
          }

          ({ meals, totalCalories } = rescale(raw.meals));
          violations = validateDay(meals, validateOpts).violations;
          for (const v of violations) logWallViolation({ ...v, day: overallDayNum, attempt: 0, source: blockAttempt > 1 ? "block-retry" : undefined });

          if (!hasBlockingViolation(violations)) break;
          for (const v of violations.filter(bv => bv.severity === "BLOCK")) {
            console.error(`[wall] BLOCK day=${overallDayNum} attempt=${blockAttempt} ${v.ruleId} tag=${v.tag} source=${v.source} meal="${v.mealName}" detail="${v.detail}" — refusing to serve this meal, no repair attempted`);
            if (process.env.WALL_DEBUG) {
              const blockedMeal = meals.find(m => m.name === v.mealName);
              console.error(`[wall-debug] name="${blockedMeal?.name}" description="${blockedMeal?.description}" tip="${blockedMeal?.tip}" ingredients=${JSON.stringify(blockedMeal?.ingredients)} allergens_present=${JSON.stringify(blockedMeal?.allergens_present)}`);
            }
          }
          if (blockAttempt === REPAIR_ATTEMPTS) {
            console.error(`[wall] day=${overallDayNum} still has a BLOCK violation after ${REPAIR_ATTEMPTS} fresh attempts — refusing to serve`);
            return null;
          }
        }

        // Layer 2 (judge): only on this FIRST generation, and only once
        // Layer 1 is already clean (no BLOCK, no REPAIR left) — a plan with
        // outstanding Layer-1 issues gets those fixed by the loop below
        // first; the judge reviews structurally-valid content, it doesn't
        // replace fixing it. One judge call per day, ever, per the cost note
        // in the Wall spec — repair iterations below are never re-judged.
        if (violations.length === 0) {
          const judgeVerdicts = await runJudge(meals);
          const oddVerdicts = judgeVerdicts.filter(j => j.verdict === "odd" && meals[j.meal_index]);
          for (const j of oddVerdicts) {
            logWallViolation({
              ruleId: "judge_plausibility", severity: "REPAIR", code: "JUDGE_ODD", day: overallDayNum,
              mealIndex: j.meal_index, mealType: meals[j.meal_index]?.type, mealName: meals[j.meal_index]?.name,
              detail: j.reason, attempt: 0, source: "layer2",
            });
          }
          if (oddVerdicts.length > 0) {
            const newMeals = await Promise.all(meals.map(async (meal, i) => {
              const odd = oddVerdicts.find(j => j.meal_index === i);
              if (!odd) return meal;
              const judgeViolation = { code: "JUDGE_ODD", detail: odd.reason, mealType: meal.type, mealName: meal.name };
              const fixed = await regenerateMealForViolations(meal, [judgeViolation], dayCtx.dietRules, dayCtx.kitchenAccessBlock, buildCarriedFoodPromptBlock(dayCtx.restrictedBorders));
              return fixed || meal;
            }));
            ({ meals, totalCalories } = rescale(newMeals));
            violations = validateDay(meals, validateOpts).violations;
            for (const v of violations) logWallViolation({ ...v, day: overallDayNum, attempt: 0, source: "layer2-repair" });
            if (hasBlockingViolation(violations)) {
              for (const v of violations.filter(bv => bv.severity === "BLOCK")) {
                console.error(`[wall] BLOCK (introduced during judge repair) day=${overallDayNum} ${v.ruleId} meal="${v.mealName}" detail="${v.detail}"`);
              }
              return null;
            }
          }
        }

        for (let attempt = 1; attempt <= REPAIR_ATTEMPTS && repairableViolations(violations).length > 0; attempt++) {
          const repairable = repairableViolations(violations);
          for (const v of repairable) {
            console.warn(`[validator] day=${overallDayNum} attempt=${attempt} FAIL ${v.ruleId ?? v.code} meal="${v.mealName ?? ""}" detail="${v.detail}"`);
          }
          const mealLevel = repairable.filter(v => v.mealIndex !== undefined);
          const dayLevel = repairable.filter(v => v.mealIndex === undefined);

          if (dayLevel.length > 0) {
            // Structural/day-total problems are about the COMBINATION of
            // meals — a single-meal swap can't fix them, regenerate the
            // whole day fresh.
            try {
              raw = await requestFreshDay();
              ({ meals, totalCalories } = rescale(raw.meals));
            } catch (e) {
              console.error(`[generate-plan] Day ${overallDayNum} repair regeneration failed: ${e.message}`);
              break;
            }
          } else {
            const byIndex = new Map();
            for (const v of mealLevel) {
              if (!byIndex.has(v.mealIndex)) byIndex.set(v.mealIndex, []);
              byIndex.get(v.mealIndex).push(v);
            }
            const newMeals = await Promise.all(meals.map(async (meal, i) => {
              if (!byIndex.has(i)) return meal;
              const deterministic = deterministicTitleFix(meal, byIndex.get(i)) || deterministicFodmapGarlicFix(meal, byIndex.get(i));
              if (deterministic) return deterministic;
              const fixed = await regenerateMealForViolations(meal, byIndex.get(i), dayCtx.dietRules, dayCtx.kitchenAccessBlock, buildCarriedFoodPromptBlock(dayCtx.restrictedBorders));
              return fixed || meal;
            }));
            ({ meals, totalCalories } = rescale(newMeals));
          }
          violations = validateDay(meals, validateOpts).violations;
          for (const v of violations) logWallViolation({ ...v, day: overallDayNum, attempt });

          // A repair pass must never accidentally introduce a NEW allergen —
          // if it does, treat it exactly like a first-pass BLOCK: fail
          // immediately, no further repair attempted.
          if (hasBlockingViolation(violations)) {
            for (const v of violations.filter(bv => bv.severity === "BLOCK")) {
              console.error(`[wall] BLOCK (introduced during repair) day=${overallDayNum} attempt=${attempt} ${v.ruleId} meal="${v.mealName}" detail="${v.detail}"`);
            }
            return null;
          }
        }

        // Last-resort escape hatch — the model has already had its normal
        // REPAIR_ATTEMPTS chances to fix things properly. If a meal is
        // still stuck on exactly one flagged ingredient (not a structural
        // day-level issue), strip that ingredient out directly rather than
        // failing the whole day over it. Confirmed live 2026-07-22: this is
        // a real, recurring failure mode (fodmap garlic, vegan butter/egg,
        // carnivore sugar all showed the model reaching for the SAME
        // flagged ingredient again on the very next attempt, unchanged) —
        // a mostly-right meal with one flavor ingredient quietly dropped is
        // a far better outcome for the crew member than "couldn't be
        // generated."
        const stillRepairable = repairableViolations(violations);
        if (stillRepairable.length > 0) {
          const strippableByIndex = new Map();
          for (const v of stillRepairable) {
            if (v.mealIndex === undefined) continue;
            if (!strippableByIndex.has(v.mealIndex)) strippableByIndex.set(v.mealIndex, []);
            strippableByIndex.get(v.mealIndex).push(v);
          }
          let anyStripped = false;
          const strippedMeals = meals.map((meal, i) => {
            const mealViolations = strippableByIndex.get(i);
            if (!mealViolations) return meal;
            const stripped = deterministicIngredientStripFix(meal, mealViolations);
            if (stripped) anyStripped = true;
            return stripped || meal;
          });
          if (anyStripped) {
            ({ meals, totalCalories } = rescale(strippedMeals));
            violations = validateDay(meals, validateOpts).violations;
            for (const v of violations) logWallViolation({ ...v, day: overallDayNum, attempt: REPAIR_ATTEMPTS + 1, source: "last-resort-strip" });
            if (hasBlockingViolation(violations)) {
              for (const v of violations.filter(bv => bv.severity === "BLOCK")) {
                console.error(`[wall] BLOCK (introduced during last-resort strip) day=${overallDayNum} ${v.ruleId} meal="${v.mealName}" detail="${v.detail}"`);
              }
              return null;
            }
          }
        }

        if (repairableViolations(violations).length > 0) {
          for (const v of repairableViolations(violations)) {
            console.error(`[validator] day=${overallDayNum} FAILED after ${REPAIR_ATTEMPTS} repair attempts — refusing to serve. ${v.ruleId ?? v.code} meal="${v.mealName ?? ""}" detail="${v.detail}"`);
          }
          return null;
        }

        return { meals, totalCalories, label: raw.label, jetlagNote: raw.jetlagNote, hydrationNote: raw.hydrationNote ?? null };
      };

      const dayResults = await Promise.all(Array.from({ length: missing }, (_, i) => generateOneDay(i)));

      if (dayResults.every(r => r === null)) {
        throw Object.assign(new Error("Failed to generate meal plan after retries"), { status: 503 });
      }

      // Only ever store days that already passed validatePlan-equivalent
      // checks above — the cache must never become a second, unvalidated
      // source of plans.
      const successfulAiDays = dayResults.filter(d => d !== null);
      const stored = successfulAiDays.length > 0
        ? await storeCachedDays(successfulAiDays, cacheKey)
        : { ids: [] };
      newDayIds = stored.ids || [];

      const allDays = [
        ...cachedDays.map(d => ({ meals: d.meals, totalCalories: d.totalCalories, label: null, jetlagNote: null, hydrationNote: null })),
        ...dayResults,
      ];
      days = allDays.slice(0, pairingDays).map((d, i) => {
        const dayNum = i + 1;
        const loc = ctx.destinations[dayNum - 1] || data.departure;
        return {
          day: dayNum,
          label: buildDayLabel(dayNum, loc, lang),
          jetlagNote: d?.jetlagNote || null,   // || catches empty string from model
          hydrationNote: d?.hydrationNote || null,
          meals: d?.meals || null,
          totalCalories: d?.totalCalories || null,
          failed: d === null,
        };
      });
      const failedCount = dayResults.filter(d => d === null).length;
      console.log(`[meal-cache] MISS for ${email}: generated ${missing} day(s), ${failedCount} failed extras=${cachedExtras ? "cache" : "ai"}`);
    }

    // Plan-scope rules ("variety" and "customs_matches_destination") run
    // across the WHOLE assembled plan — days generate independently
    // (parallel, for latency), so a same-slot hero/title repeat, or a
    // destination whose customs rules silently didn't get applied, can only
    // be caught here, after assembly. Repair is targeted where possible
    // (just the specific colliding/non-compliant meal, on the affected day)
    // rather than a full day-level regeneration, to keep this bounded and
    // fast — except customs_matches_destination's CUSTOMS_MISMATCH
    // violations, which have no single meal to swap (the whole day was
    // built without the right constraints) and go straight to "mark day
    // failed" below instead of attempting a meal-level fix.
    const planRuleCtx = {
      destinations: data.destinations, departure: data.departure,
      restrictedBorders: ctx.restrictedBorders,
      kitchen_by_day: data.kitchen_by_day, kitchen: data.kitchen,
    };
    const crossDayViolations = runWallOnPlanScope(days, planRuleCtx);
    if (crossDayViolations.length > 0) {
      const { tags: requiredAllergenTags, customAllergyTerm } = getUserRequiredAllergenAvoidance(data);
      const rawDietsForRepair = Array.isArray(data.diets) ? data.diets : (data.diet ? [data.diet] : []);
      const activeDietTagsForRepair = rawDietsForRepair.filter(d => DIET_PROHIBITED[d] || d === "kosher" || d === "low_carb");
      await Promise.all(crossDayViolations.map(async (v) => {
        logWallViolation({ ...v, day: v.day, attempt: 0, source: "cross-day" });
        const targetDay = days.find(d => d.day === v.day);
        if (!targetDay || targetDay.failed) return;
        if (v.mealIndex === undefined) {
          // No single meal to swap (e.g. CUSTOMS_MISMATCH) — the day was
          // generated without the right constraints entirely, so a full
          // regeneration is the only correct fix.
          console.error(`[validator] day=${v.day} ${v.ruleId} is plan-level, not meal-repairable — marking day failed: ${v.detail}`);
          targetDay.failed = true; targetDay.meals = null; targetDay.totalCalories = null;
          return;
        }
        if (!Array.isArray(targetDay.meals)) return;
        const meal = targetDay.meals[v.mealIndex];
        if (!meal) return;
        const rawKitchen = Array.isArray(data.kitchen_by_day)
          ? (data.kitchen_by_day[v.day - 1] || data.kitchen || [])
          : (data.kitchen || []);
        const dayKitchen = Array.isArray(rawKitchen) ? rawKitchen : (rawKitchen ? [rawKitchen] : []);
        // Retries up to REPAIR_ATTEMPTS, same budget as the main per-day
        // validation loop — this used to be a single shot with no retry, so
        // ANY new violation introduced by the swap (customs, kitchen_access,
        // whatever) failed the whole day immediately with no chance to
        // correct course. Confirmed live 2026-07-20: fixing a cross-day
        // variety repeat kept introducing a fresh, DIFFERENT violation each
        // deploy (fresh berries vs. customs, then a microwave prep_method
        // vs. hotel/no-kitchen) — a real, one-shot regeneration is simply
        // not reliable enough to trust without the same retry room every
        // other repair path already gets.
        let replacement = null;
        let lastAttempted = null;
        let currentViolations = [v];
        let blockingStillBad = [];
        const wallCheckCtx = {
          requiredAllergenTags, customAllergyTerm, activeDietTags: activeDietTagsForRepair,
          calorieTarget: null, kitchenList: dayKitchen, restrictedBorders: ctx.restrictedBorders,
        };
        for (let attempt = 1; attempt <= REPAIR_ATTEMPTS; attempt++) {
          replacement = await regenerateMealForViolations(meal, currentViolations, ctx.dietRules, buildKitchenAccessBlock(dayKitchen), buildCarriedFoodPromptBlock(ctx.restrictedBorders));
          if (!replacement) break;
          lastAttempted = replacement;
          // Full Wall re-check (every meal-scope rule, not just the ones
          // this specific fix targeted) — a cross-day repair is still a
          // fresh AI response and must clear the whole registry, not just
          // the rule it was regenerated for.
          const stillBad = runWallOnMeal(replacement, wallCheckCtx);
          for (const bv of stillBad) logWallViolation({ ...bv, day: v.day, mealName: replacement.name, mealType: replacement.type, attempt, source: "cross-day-repair" });
          // WARN-severity findings (hero_ingredient_agreement is currently
          // the only one) are explicitly documented as never blocking or
          // failing a day — "a disagreement is a useful signal to review,
          // not proof the model is wrong" (see WALL_RULES comment). This
          // check used to fail the whole day on a bare stillBad.length,
          // ignoring severity — confirmed live 2026-07-20: two separate
          // days failed purely because the heuristic hero-ingredient bucket
          // disagreed with a genuinely correct model answer.
          blockingStillBad = stillBad.filter(sv => sv.severity !== "WARN");
          const deterministic = deterministicTitleFix(replacement, blockingStillBad) || deterministicFodmapGarlicFix(replacement, blockingStillBad);
          if (deterministic) { replacement = deterministic; lastAttempted = deterministic; blockingStillBad = []; }
          if (blockingStillBad.length === 0) break;
          currentViolations = blockingStillBad;
          replacement = null;
        }
        // Last-resort escape hatch, same as the main per-day repair loop:
        // if the LAST attempt is stuck on exactly one flagged ingredient,
        // strip it directly rather than failing the whole day over it.
        if (!replacement && lastAttempted && blockingStillBad.length === 1) {
          const stripped = deterministicIngredientStripFix(lastAttempted, blockingStillBad);
          if (stripped) {
            const recheck = runWallOnMeal(stripped, wallCheckCtx).filter(sv => sv.severity !== "WARN");
            if (recheck.length === 0) { replacement = stripped; blockingStillBad = []; }
            else blockingStillBad = recheck;
          }
        }
        if (!replacement) {
          console.error(`[validator] day=${v.day} cross-day repair for "${meal.name}" still has issues after ${REPAIR_ATTEMPTS} attempts, marking day failed: ${JSON.stringify(blockingStillBad.map(sv => sv.detail))}`);
          targetDay.failed = true; targetDay.meals = null; targetDay.totalCalories = null;
          return;
        }
        // crossDayViolations can name multiple violations on the SAME day
        // (different mealIndex), all running concurrently in this
        // Promise.all — if a sibling violation for this day already failed
        // it (targetDay.meals set to null above) while this branch's own
        // regeneration succeeded, targetDay.meals is no longer an array by
        // the time we get here. Crashed the whole request with "Cannot set
        // properties of null" before this guard — confirmed live 2026-07-20
        // on a Mediterranean/dairy_free/shellfish_free plan. The day is
        // already correctly marked failed; nothing more to do.
        if (!Array.isArray(targetDay.meals)) return;
        targetDay.meals[v.mealIndex] = { ...replacement, type: meal.type };
        targetDay.totalCalories = targetDay.meals.reduce((s, m) => s + (m.calories || 0), 0);
      }));

      // The swap above only re-checks MEAL-scope rules on the replacement
      // (runWallOnMeal) — a day that already passed its DAY-scope budget
      // check earlier can go back over budget here, silently, since nothing
      // re-verifies the day total after a meal-level swap driven by an
      // unrelated cross-day violation (e.g. a variety repeat). Confirmed
      // live 2026-07-20: a day that validated under budget got a Breakfast
      // swapped for a cross-day "hero ingredient repeats" fix, and the
      // swap's pricier replacement pushed the day 50%+ over budget with no
      // rejection. Re-run just the budget rule on every day this pass
      // touched; mark it failed (same bar as the main validation loop) if
      // the swap pushed it over.
      const budgetRule = WALL_RULES.find(r => r.id === "budget");
      if (budgetRule && ctx.perDayBudget) {
        for (const v of crossDayViolations) {
          const targetDay = days.find(d => d.day === v.day);
          if (!targetDay || targetDay.failed || !Array.isArray(targetDay.meals)) continue;
          const { violations } = budgetRule.check(targetDay.meals, { perDayBudget: ctx.perDayBudget });
          if (violations.length > 0) {
            console.error(`[validator] day=${v.day} over budget after cross-day repair swap, marking day failed: ${violations[0].detail}`);
            targetDay.failed = true; targetDay.meals = null; targetDay.totalCalories = null;
          }
        }
      }
    }

    const extras = await extrasPromise;

    // Inject server-computed, deterministic (not model-generated) fields:
    // the carried-food note, whether the USA card should show at all, and
    // the full per-country customs breakdown for display — all derived the
    // same way, from the same ctx.restrictedBorders the customs_matches_
    // destination Wall rule itself checks against, so what's shown can never
    // drift from what was actually applied to the plan.
    const carriedNote = buildCarriedFoodNote(ctx.restrictedBorders, lang);
    extras.foodRestrictions = {
      ...extras.foodRestrictions,
      ...(carriedNote ? { carried: carriedNote } : {}),
      usaApplies: ctx.restrictedBorders.some(b => b.id === "usa"),
      byCountry: buildCustomsByCountry(ctx.restrictedBorders, lang),
    };

    // Fire-and-forget: doesn't gate anything. The pairing count itself was
    // already atomically consumed by reservePairingUsage above.
    markDaysSeen(email, [...cachedDayIds, ...newDayIds]);

    const failedDays = days.filter(d => d.failed).map(d => d.day);
    const planResponse = {
      summary: extras.summary,
      days,
      groceryList: extras.groceryList,
      foodRestrictions: extras.foodRestrictions,
      // Premium-only, same reasoning as generateOneDay's dayCtx.cognitivePerfRules above.
      performanceAdvisory: usage.isPremium ? getCognitivePerfRules(data, ctx.leg) : null,
      hydration: computeHydration(data),
      pairingCount: usage.pairingCount,
      isPremium: usage.isPremium,
      needsPremium: usage.needsPremium,
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

    // This endpoint's whole purpose is a personal allergen exclusion — the
    // replacement is fresh AI output and, like every other plan-returning
    // path, must clear the Wall before a user ever sees it. Not routing this
    // through validation was a real bypass: the AI's own response was
    // returned directly with no check that it actually dropped the flagged
    // ingredient or didn't introduce a new problem while rewriting the meal.
    const { tags: requiredAllergenTags } = getUserRequiredAllergenAvoidance(data);
    const rawDiets = Array.isArray(data.diets) ? data.diets : (data.diet ? [data.diet] : []);
    const activeDietTags = rawDiets.filter(d => DIET_PROHIBITED[d] || d === "kosher" || d === "low_carb");
    const rawKitchen = Array.isArray(data.kitchen) ? data.kitchen : (data.kitchen ? [data.kitchen] : []);

    // Retries up to REPAIR_ATTEMPTS, same budget every other repair path
    // gets — this used to be a single shot with no retry, so a replacement
    // that fixed the flagged allergen but introduced a DIFFERENT, unrelated
    // violation (wrong prep_method for the kitchen access, a new allergen,
    // etc.) failed outright with no new meal ever created. Confirmed live
    // 2026-07-20: a nut-free replacement came back with prep_method
    // "microwave" for a hotel/no-kitchen day and the whole request 502'd,
    // leaving the original (still-allergenic) meal in place.
    let replacement = null;
    let lastAttempted = null;
    let currentViolations = [{ code: "ALLERGEN", source: "user", detail: excludeIngredient }];
    let blocking = [];
    const wallCheckCtx = {
      requiredAllergenTags, customAllergyTerm: excludeIngredient, activeDietTags,
      calorieTarget: ctx.calorieTarget ?? ctx.gainTarget ?? ctx.maintenanceTarget ?? null,
      kitchenList: rawKitchen, restrictedBorders: ctx.restrictedBorders,
    };
    for (let attempt = 1; attempt <= REPAIR_ATTEMPTS; attempt++) {
      replacement = await regenerateMealForViolations(
        meal, currentViolations, personalNote, ctx.kitchenAccessBlock,
        buildCarriedFoodPromptBlock(ctx.restrictedBorders)
      );
      if (!replacement) break;
      lastAttempted = replacement;
      const wallViolations = runWallOnMeal(replacement, wallCheckCtx);
      for (const v of wallViolations) logWallViolation({ ...v, day: null, mealType: replacement.type, mealName: replacement.name, attempt, source: "regenerate-meal" });
      blocking = wallViolations.filter(v => v.severity !== "WARN");
      const deterministic = deterministicTitleFix(replacement, blocking) || deterministicFodmapGarlicFix(replacement, blocking);
      if (deterministic) { replacement = deterministic; lastAttempted = deterministic; blocking = []; }
      if (blocking.length === 0) break;
      currentViolations = blocking;
      replacement = null;
    }
    // Last-resort escape hatch, same as the day-generation repair path: if
    // the LAST attempt is stuck on exactly one flagged diet ingredient
    // (never a personal allergen — deterministicIngredientStripFix only
    // ever touches diet_compliance violations), strip it directly rather
    // than failing the whole request over it.
    if (!replacement && lastAttempted && blocking.length === 1) {
      const stripped = deterministicIngredientStripFix(lastAttempted, blocking);
      if (stripped) {
        const recheck = runWallOnMeal(stripped, wallCheckCtx).filter(sv => sv.severity !== "WARN");
        if (recheck.length === 0) { replacement = stripped; blocking = []; }
        else blocking = recheck;
      }
    }
    if (!replacement) {
      console.error(`[wall] /api/regenerate-meal replacement still failed the Wall for "${meal.name}" after ${REPAIR_ATTEMPTS} attempts: ${blocking.map(v => `${v.ruleId ?? v.code}(${v.detail})`).join(", ")}`);
      return res.status(502).json({ error: "Could not update this meal. Please try again." });
    }
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

NEVER include the home base itself in "destinations" — it is the departure
and implicit return, not a stop. If a 3-letter code is genuinely illegible
(too small, blurry, or cut off), do NOT guess a plausible-sounding city —
it is better to omit that pairing or leave a destination out than to
fabricate one from an unreadable code.

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
    // Deterministic safety net: the model sometimes lists the home base itself
    // (a return-to-base leg, e.g. "YYZ-LAX-YYZ") as a destination despite the
    // prompt's explicit rule against it. Strip any destination that matches
    // the pairing's own departure city — cheaper and more reliable than
    // relying on prompt compliance alone.
    if (Array.isArray(result?.pairings)) {
      for (const p of result.pairings) {
        if (!Array.isArray(p.destinations) || !p.departure) continue;
        const dep = p.departure.trim().toLowerCase();
        p.destinations = p.destinations.filter(d => (d || "").trim().toLowerCase() !== dep);
      }
    }
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

// Crew without a home kitchen (hotel or airplane food only) have no gym equipment.
// "hotel" is the kitchen value sent by the frontend for its "Hotel (No Kitchen)"
// option — "hotel_no_kitchen" is only the UI's translation label key, never the
// actual value, so matching against it here always missed and let hotel-only
// crew get told dumbbells were available.
function hasGymEquipment(kitchen) {
  const list = [].concat(kitchen || []);
  return list.length > 0 && !list.every(k => ["hotel", "airplane_food"].includes(k));
}

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
    const hasEquipment = hasGymEquipment(kitchen);
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

    // Store in CRUD backend (fire-and-forget). Keyed by TODAY's month, not
    // the first pairing's month — the plan's own content always starts
    // today ("Cover the calendar from today through the last return date"
    // above), and GymPlanModal's FAB-triggered lookup (no month prop, the
    // common "just tap Gym Plan any day" path) defaults to today's month
    // too. Confirmed live 2026-07-22: a roster uploaded for a FUTURE month
    // (e.g. uploading in July for an August trip) stored the plan under
    // "2026-08" while the FAB's default lookup queried "2026-07" — a
    // guaranteed miss that showed the empty "upload your roster" prompt
    // even though a real plan had just been generated.
    const month = new Date().toISOString().slice(0, 7);
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

    // Prefer the real derived leg (airport UTC offsets) over the client-
    // supplied `timezone` number — same reasoning as AIRPORT_TIMEZONE/
    // computeLegDirection above: direction should never be trusted from the
    // client, only computed. Falls back to the client's tz/sign only when
    // one of the airports isn't in AIRPORT_TIMEZONE.
    const derivedLeg = computeLegDirection(departure, destination);
    const hours = derivedLeg ? derivedLeg.hours : Math.abs(tz);
    const losingHours = derivedLeg ? derivedLeg.direction === "east" : tz > 0;
    const direction = losingHours
      ? `losing ${hours} hours (destination's clock is ahead — circadian advance, the harder direction to adjust to)`
      : `gaining ${hours} hours (destination's clock is behind — circadian delay, the easier direction to adjust to)`;
    const dietLine = Array.isArray(diets) && diets.length ? diets.join(", ") : "no restrictions";
    const prompt = `Create a short, practical jetlag meal-timing plan for a flight crew member ${direction}, flying from ${departure} to ${destination}. Diet: ${dietLine}.

Cover: the travel day, plus the first 2 days at the destination. For each entry give a label (e.g. "Travel day", "Day 1 in ${destination}") and 2-4 short, concrete meal-timing actions stated in destination local time (specific times, what to eat or avoid, hydration, caffeine cutoff). Be specific to the direction and size of the time difference — no generic advice. Phrase everything in terms of hours gained/lost (e.g. "you're losing/gaining N hours") — never use the words "eastward"/"westward"/"eastbound"/"westbound" anywhere in the response.

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
    // (configured in the Stripe dashboard, not here). Only relevant while
    // TRIAL_ENABLED is true — see below.
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
        // Launch model: no trial, charge begins immediately (see TRIAL_ENABLED
        // above). Setting TRIAL_ENABLED=true restores the original
        // trial_period_days behavior exactly as it was, untouched.
        ...(TRIAL_ENABLED && !isReturningCustomer ? { trial_period_days: TRIAL_DAYS } : {}),
      },
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: isAnnual ? 6232 : 799, // annual $62.32 = 35% off 12×$7.99 ($95.88); monthly $7.99
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
          unit_amount: 6232, // matches the paywall's annual price ($62.32 = 35% off 12×$7.99)
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

// Named exports of pure/deterministic logic (no network, no Express) so it can
// be exercised directly by regression tests without booting the server or
// spending Anthropic/CRUD-backend calls. Keep this list to functions that are
// safe to call with no environment configured.
export {
  buildContext, getDietRules, getSingleDietBlock, hasGymEquipment, CACHE_SCHEMA_VERSION,
  validatePlan, validateDay, findMealAllergenViolations, findMealDietViolations,
  findMealSlotContentViolation, findMealKitchenViolation, findMealCustomsViolation,
  getUserRequiredAllergenAvoidance, getExpectedMealStructure, ALLERGEN_DERIVATIVES,
  USER_ALLERGY_TO_TAGS, DIET_PROHIBITED, KITCHEN_PREP_METHOD_ALLOW, MEAL_SCHEMA,
  findMealPortionScaleViolation, findMealTitleViolation, findMealIconViolation,
  getMealHeroCategory, findCrossDayVarietyViolations, titlesShareSignificantPattern,
  computeLegDirection, computeLegForDay, AIRPORT_TIMEZONE, getCognitivePerfRules,
  TRIAL_ENABLED, TRIAL_DAYS, PREMIUM_REQUIRED_MESSAGE,
  WALL_RULES, runWallOnMeal, runWallOnDayScope, runWallOnPlanScope,
  hasBlockingViolation, repairableViolations, runJudge, JUDGE_SCHEMA,
  WALL_VIOLATION_LOG, logWallViolation, DAYS_SCHEMA,
  BORDER_COUNTRY_RULES, getCountryForAirport, detectRestrictedBorders,
  getDestinationFoodRules, unionCarriedBans, extractAirportCode,
  buildCarriedFoodNote, buildCustomsByCountry, buildKitchenAccessBlock,
  deterministicTitleFix, deterministicFodmapGarlicFix, deterministicIngredientStripFix,
};
export default app;
