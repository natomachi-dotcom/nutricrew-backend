// Exercises the Stripe trial flow added in server.js against a *test-mode*
// Stripe account: /api/create-checkout-session (new vs. returning customer),
// /api/create-portal-session, and the /api/stripe-webhook signature check.
// Spins up a throwaway mock of the CRUD backend so it needs no other
// services running locally.
import "dotenv/config";
import http from "http";
import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
  console.error("STRIPE_SECRET_KEY must be a sk_test_... key to run this script.");
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "test-internal-key";
const NEW_EMAIL = `trial-new-${Date.now()}@example.com`;
const RETURNING_EMAIL = `trial-returning-${Date.now()}@example.com`;
const UNKNOWN_EMAIL = `no-subscription-${Date.now()}@example.com`;

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  // A real Stripe test-mode customer so the returning-customer and portal
  // paths hit Stripe with an ID that actually exists.
  const returningCustomer = await stripe.customers.create({ email: RETURNING_EMAIL });

  // Mock CRUD backend: knows about the "returning" customer, nothing else.
  const mockCrud = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/user/stripe-customer") {
      const email = url.searchParams.get("email");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        stripeCustomerId: email === RETURNING_EMAIL ? returningCustomer.id : null,
      }));
      return;
    }
    if (req.method === "POST" && (url.pathname === "/api/set-premium" || url.pathname === "/api/set-premium-by-customer")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        console.log(`  [mock-crud] ${url.pathname} <- ${body}`);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => mockCrud.listen(0, resolve));
  const crudPort = mockCrud.address().port;

  process.env.CRUD_API_BASE = `http://localhost:${crudPort}`;
  process.env.INTERNAL_API_KEY = INTERNAL_API_KEY;
  process.env.PORT = "0"; // let the OS pick a free port
  process.env.VERCEL = ""; // make sure app.listen runs
  if (!process.env.RESEND_API_KEY) process.env.RESEND_API_KEY = "re_dummy_not_used_by_this_test";

  const { default: app } = await import("./server.js");
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  try {
    console.log("\n1. New customer checkout (should get a 30-day trial, no existing Stripe customer)");
    let r = await fetch(`${base}/api/create-checkout-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: NEW_EMAIL, plan: "monthly" }),
    });
    let json = await r.json();
    check("HTTP 200", r.status === 200, `got ${r.status}: ${JSON.stringify(json)}`);
    check("returns a checkout url", !!json.url?.startsWith("https://checkout.stripe.com"), json.url);
    const newSessionId = json.url?.match(/\/pay\/([^#?]+)/)?.[1] || json.url?.split("/pay/")[1];
    let session = newSessionId ? await stripe.checkout.sessions.retrieve(newSessionId.split("#")[0]) : null;
    check("mode=subscription", session?.mode === "subscription");
    check("payment_method_collection=always (card required during trial)", session?.payment_method_collection === "always");
    check("no pre-existing customer attached (fresh trial-eligible email)", session?.customer === null, `customer=${session?.customer}`);

    console.log("\n2. Returning customer checkout (already has a Stripe customer — trial must be skipped)");
    r = await fetch(`${base}/api/create-checkout-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: RETURNING_EMAIL, plan: "monthly" }),
    });
    json = await r.json();
    check("HTTP 200", r.status === 200, `got ${r.status}: ${JSON.stringify(json)}`);
    const retSessionId = json.url?.split("/pay/")[1]?.split("#")[0];
    session = retSessionId ? await stripe.checkout.sessions.retrieve(retSessionId) : null;
    check("reuses the existing Stripe customer", session?.customer === returningCustomer.id, `customer=${session?.customer}`);

    console.log("\n3. Invalid email is rejected");
    r = await fetch(`${base}/api/create-checkout-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", plan: "monthly" }),
    });
    check("HTTP 400", r.status === 400);

    console.log("\n4. Billing portal for an unknown email is rejected");
    r = await fetch(`${base}/api/create-portal-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: UNKNOWN_EMAIL }),
    });
    check("HTTP 404", r.status === 404);

    console.log("\n5. Billing portal for the returning customer succeeds");
    r = await fetch(`${base}/api/create-portal-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: RETURNING_EMAIL }),
    });
    json = await r.json();
    check("HTTP 200", r.status === 200, `got ${r.status}: ${JSON.stringify(json)}`);
    check("returns a billing portal url", !!json.url?.includes("billing.stripe.com"), json.url);

    console.log("\n6. Webhook rejects a badly signed payload");
    const payload = JSON.stringify({ id: "evt_test", type: "checkout.session.completed", data: { object: {} } });
    r = await fetch(`${base}/api/stripe-webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
      body: payload,
    });
    check("HTTP 400 on bad signature", r.status === 400);

    console.log("\n7. Webhook accepts a correctly signed checkout.session.completed and forwards trialEnd to the CRUD backend");
    const webhookEmail = `webhook-${Date.now()}@example.com`;
    const eventPayload = JSON.stringify({
      id: "evt_test_completed",
      type: "checkout.session.completed",
      data: { object: { customer_email: webhookEmail, customer: returningCustomer.id, subscription: null } },
    });
    const sigHeader = stripe.webhooks.generateTestHeaderString({
      payload: eventPayload,
      secret: process.env.STRIPE_WEBHOOK_SECRET,
    });
    r = await fetch(`${base}/api/stripe-webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": sigHeader },
      body: eventPayload,
    });
    json = await r.json();
    check("HTTP 200 on valid signature", r.status === 200, `got ${r.status}: ${JSON.stringify(json)}`);
  } finally {
    server.close();
    mockCrud.close();
    await stripe.customers.del(returningCustomer.id).catch(() => {});
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test script crashed:", err);
  process.exit(1);
});
