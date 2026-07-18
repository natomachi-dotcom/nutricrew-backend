// One-shot calorie verification test
// Usage: node test-calorie-guard.mjs [runLabel]
// Profile: female, 70kg, age ~30 (dob 1996-01-01), no deficit, diet None, Full Kitchen, 1 day

const BACKEND = "https://nutricrew-backend.vercel.app";

const label = process.argv[2] || "run";

const data = {
  email: "renatogadeabi@gmail.com",
  name: "Test User",
  gender: "female",
  weight: "70kg",
  dob: "1996-01-01",
  position: "flight_attendant",
  diets: ["none"],
  goals: [],
  kitchen: ["full_kitchen"],
  pairing_days: "1",
  departure: "YYZ",
  destinations: ["LAX"],
  timezone: "0",
};

console.log(`\n=== ${label} — generating 1-day plan ===`);
const resp = await fetch(`${BACKEND}/api/generate-plan`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ data, lang: "en" }),
});

const result = await resp.json();
if (result.error) {
  console.error("Error:", result.error, result.message);
  process.exit(1);
}

const day = result.days[0];
if (!day || !day.meals) {
  console.error("No day or meals in response:", JSON.stringify(result, null, 2));
  process.exit(1);
}

console.log("\nPer-meal breakdown:");
let mealSum = 0;
for (const meal of day.meals) {
  console.log(`  ${meal.type.padEnd(9)} "${meal.name}" — ${meal.calories} kcal`);
  mealSum += meal.calories;
}

console.log(`\n  Meal sum:          ${mealSum} kcal`);
console.log(`  day.totalCalories: ${day.totalCalories} kcal`);
console.log(`  Sum matches field: ${mealSum === day.totalCalories ? "YES ✓" : `NO ✗ (diff: ${mealSum - day.totalCalories})`}`);
console.log(`  isPremium:         ${result.isPremium}`);
console.log(`  pairingCount:      ${result.pairingCount}`);
