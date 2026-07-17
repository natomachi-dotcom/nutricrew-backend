// Live acceptance test for meal-appropriateness (sardines-at-breakfast bug
// class). Real Anthropic calls against a running server — 5 requests (one
// per diet), staying under the 5-per-15min generatePlanLimiter for one email.
//
// Usage: node test-meal-appropriateness-live.mjs
//   BACKEND=http://localhost:3099 (default) node test-meal-appropriateness-live.mjs
//   BACKEND=https://nutricrew-backend.vercel.app node test-meal-appropriateness-live.mjs

const BACKEND = process.env.BACKEND || "http://localhost:3099";
const EMAIL = "renatogadeabi@gmail.com"; // same trusted test account other test-*.mjs scripts use

const PROHIBITED_BREAKFAST = /\b(sardines?|anchov(?:y|ies)|mackerel|tuna|shrimps?|prawns?|crabs?|lobsters?|steaks?|roasts?|stews?|curr(?:y|ies)|pastas?|casserole|risotto)\b/i;
const BREAKFAST_STYLE = /\b(pancakes?|waffles?|cereal|oatmeal|overnight oats|porridge|smoothie bowl|french toast|parfait)\b/i;
const HEAVY_MAIN = /\b(roasts?|stews?|curr(?:y|ies)|casserole|lasagn?a|risotto)\b/i;
const DIET_NAME_PATTERN = /\b(mediterranean|vegan|vegetarian|keto|paleo|halal|kosher|carnivore|fodmap|gluten[- ]free|dairy[- ]free|low[- ]carb)\b/i;

async function generate(label, data) {
  console.log(`\n${"═".repeat(70)}\n${label}\n${"─".repeat(70)}`);
  const resp = await fetch(`${BACKEND}/api/generate-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { email: EMAIL, ...data }, lang: "en" }),
  });
  const result = await resp.json();
  if (result.error) {
    console.error(`  API ERROR: ${result.error} ${result.message || ""}`);
    return null;
  }
  return result;
}

function heroGuess(meal) {
  const text = [meal.name, ...(meal.ingredients || []).map(i => (typeof i === "string" ? i : i.name))].join(" ").toLowerCase();
  const candidates = ["sardine", "anchov", "mackerel", "tuna", "salmon", "shrimp", "chicken", "beef", "steak", "pork", "bacon", "sausage", "turkey", "lamb", "tofu", "egg", "yogurt", "oat", "cheese", "lentil", "bean"];
  return candidates.find(c => text.includes(c)) || "(none obvious)";
}

const DIET_PLANS = [
  { label: "Mediterranean", diets: ["mediterranean"] },
  { label: "Vegan", diets: ["vegan"] },
  { label: "Keto (low_carb)", diets: ["low_carb"] },
  { label: "Halal", diets: ["halal"] },
  { label: "Gluten-Free", diets: ["gluten_free"] },
];

const BASE_PROFILE = {
  name: "Test User", position: "cabin", gender: "female", weight: "70kg", dob: "1994-01-01",
  departure: "YOW", destinations: ["YOW"], going_usa: "no", timezone: "0",
  kitchen: ["full_kitchen"], goals: [], pairing_days: "3",
};

let totalMeals = 0;
let breakfastViolations = 0;
let dinnerViolations = 0;
let snackViolations = 0;
let titleViolations = 0;

for (const { label, diets } of DIET_PLANS) {
  const r = await generate(`${label} — 3-day plan`, { ...BASE_PROFILE, diets });
  if (!r) continue;
  let prevBreakfast = null;
  for (const day of r.days) {
    console.log(`  ${day.label} (${day.totalCalories} kcal):`);
    for (const m of day.meals || []) {
      totalMeals++;
      const hero = heroGuess(m);
      console.log(`    [${m.type}] "${m.name}" — hero: ${hero}, ${m.calories}kcal, emoji=${m.emoji}`);

      if (m.type === "Breakfast" && PROHIBITED_BREAKFAST.test(m.name + " " + m.description)) {
        breakfastViolations++;
        console.log(`      !! PROHIBITED BREAKFAST HERO: "${m.name}"`);
      }
      if ((m.type === "Dinner" || m.type === "Lunch") && BREAKFAST_STYLE.test(m.name + " " + m.description)) {
        dinnerViolations++;
        console.log(`      !! BREAKFAST-STYLE DISH AT ${m.type.toUpperCase()}: "${m.name}"`);
      }
      if (m.type === "Snack" && HEAVY_MAIN.test(m.name + " " + m.description)) {
        snackViolations++;
        console.log(`      !! FULL MEAL AS SNACK: "${m.name}"`);
      }
      const contentWords = m.name.split(/\s+/).filter(w => !["with", "and", "&", "in", "of", "the", "a", "an"].includes(w.toLowerCase())).length;
      if (contentWords > 6 || DIET_NAME_PATTERN.test(m.name)) {
        titleViolations++;
        console.log(`      !! TITLE ISSUE (${contentWords} words, diet-name=${DIET_NAME_PATTERN.test(m.name)}): "${m.name}"`);
      }

      if (m.type === "Breakfast") {
        if (prevBreakfast && heroGuess(prevBreakfast) === hero && hero !== "(none obvious)") {
          console.log(`      !! HERO REPEATS FROM PREVIOUS DAY'S BREAKFAST: "${hero}"`);
        }
        prevBreakfast = m;
      }
    }
  }
}

console.log(`\n${"═".repeat(70)}\nSUMMARY\n${"─".repeat(70)}`);
console.log(`Total meals reported: ${totalMeals}`);
console.log(`Prohibited breakfast heroes (fish/shellfish/dense meat/stew/curry/pasta): ${breakfastViolations}`);
console.log(`Breakfast-style dishes at Lunch/Dinner: ${dinnerViolations}`);
console.log(`Full plated meals served as Snack: ${snackViolations}`);
console.log(`Title issues (>6 words or diet name present): ${titleViolations}`);
console.log(`\n${"═".repeat(70)}\nDONE\n${"═".repeat(70)}`);
