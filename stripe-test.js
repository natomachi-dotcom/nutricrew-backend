// Load your environment variables from the .env file
require('dotenv').config(); 
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY_TEST);

async function runTestClockSimulation() {
  try {
    console.log("⏳ Starting Stripe Time-Travel Test...");

    // 1. Create a Test Clock pinned to right now
    const clock = await stripe.testHelpers.testClocks.create({
      frozen_time: Math.floor(Date.now() / 1000),
      name: '30-Day Trial Verification Clock',
    });
    console.log(`✅ Test Clock Created: ${clock.id}`);

    // 2. Create a Customer attached to that Test Clock
    const customer = await stripe.customers.create({
      email: 'throwaway-test@example.com',
      test_clock: clock.id, 
    });
    console.log(`✅ Test Customer Created: ${customer.id}`);

    // 3. Create the Subscription with a 30-day trial
    // NOTE: Replace 'price_YOUR_PRICE_ID_HERE' with a real test price ID from your Stripe dashboard if this errors!
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: 'price_1Tk1mHRFl7xpW4geExample' }], 
      trial_period_days: 30,
    });
    console.log(`✅ Subscription Created (Trialing): ${subscription.id}`);

    // 4. Advance the clock 31 days into the future
    console.log("⏩ Fast-forwarding clock 31 days into the future...");
    const targetTime = clock.frozen_time + (31 * 24 * 60 * 60); 
    
    await stripe.testHelpers.testClocks.advance(clock.id, {
      frozen_time: targetTime,
    });
    
    console.log(`🎉 Clock advanced successfully! Check your Stripe Dashboard under 'Customers' -> 'Test Clocks' to watch the status flip to Active.`);

  } catch (error) {
    console.error("❌ Test failed with error:", error.message);
  }
}

runTestClockSimulation();