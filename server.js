import "dotenv/config";
import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(cors());
app.use(express.json());

const client = new Anthropic();
const MODEL = "claude-opus-4-8";

const MEAL_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["Breakfast", "Lunch", "Dinner", "Snack"] },
    name: { type: "string" },
    description: { type: "string" },
    prep: { type: "string" },
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
    day: { type: "integer" },
    label: { type: "string" },
    jetlagNote: { type: ["string", "null"] },
    totalCalories: { type: "integer" },
    meals: { type: "array", items: MEAL_SCHEMA },
  },
  required: ["day", "label", "jetlagNote", "totalCalories", "meals"],
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
  res.status(500).json({ error: err.message });
}

async function runStructured(prompt, schema, maxTokens) {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw Object.assign(new Error("The model declined to generate this content."), { status: 502 });
  }
  return extractJSON(message);
}

// Builds the shared crew-profile context used by every prompt for a plan.
function buildContext(data, lang) {
  const langName = lang === "fr" ? "French" : lang === "es" ? "Spanish" : "English";
  const diet = data.diet === "other" ? data.diet_other : data.diet;
  const jetlag = Math.abs(parseInt(data.timezone || 0, 10)) >= 4;
  const destinations = data.destinations || [];

  const profile = `CREW PROFILE:
- Name: ${data.name}, Position: ${data.position}, Gender: ${data.gender}
- Weight: ${data.weight}, Diet: ${diet}
- Goals: ${(data.goals || []).join(", ")}
- Budget: $${data.budget_amount || "open"} per ${data.budget_type || "day"}
- Route: ${data.departure} -> ${destinations.join(" -> ")}
- Going to USA: ${data.going_usa}
- Jet lag (timezone diff): ${data.timezone || 0} hours${jetlag ? " -- SIGNIFICANT JET LAG, adjust meal timing for circadian rhythm" : ""}
- Kitchen access: ${(data.kitchen || []).join(", ")}`;

  return { langName, diet, jetlag, destinations, profile };
}

function buildDayPrompt(data, dayNum, pairingDays, ctx) {
  const location = ctx.destinations[dayNum - 1] || data.departure;
  return `You are a professional nutritionist specializing in aviation crew health.

${ctx.profile}

Generate ONLY Day ${dayNum} of ${pairingDays} of this nutrition plan. This day's location: ${location}.

Respond ONLY in ${ctx.langName}. Return ONLY valid JSON matching the schema.
Include Breakfast, Lunch, Dinner, and 1-2 Snacks. The "day" field must be ${dayNum}.
The meal "type" field must always be the literal English word "Breakfast", "Lunch", "Dinner", or "Snack" — never translate it — even though every other field must be in ${ctx.langName}.
${ctx.jetlag && dayNum === 1
    ? `Set "jetlagNote" to short, practical meal-timing advice for adjusting to the jet lag described above.`
    : `Set "jetlagNote" to null.`}
Every meal must include a "tip" (short practical packing/timing/prep/substitution tip) and a "recyclingTip" (short waste-reduction or recycling/composting tip tailored to a ${ctx.diet} diet).
Vary the meal choices — pick different recipes, ingredients, and combinations than a typical/generic plan each time, so returning crew members don't get repetitive suggestions.`;
}

function buildExtrasPrompt(data, pairingDays, ctx) {
  const itinerary = ctx.destinations.map((d, i) => `  Day ${i + 1}: ${d}`).join("\n");
  return `You are a professional nutritionist specializing in aviation crew health.

${ctx.profile}

Daily itinerary:
${itinerary}

Generate the SUMMARY, GROCERY LIST, and FOOD RESTRICTIONS sections for this ${pairingDays}-day nutrition plan (day-by-day meals are generated separately).

Respond ONLY in ${ctx.langName}. Return ONLY valid JSON matching the schema.
- "summary": 2-sentence overview of the whole plan.
- "groceryList": categorized shopping list (produce, protein, pantry, snacks, dairy) covering the whole pairing, based on the crew's kitchen access.
- "foodRestrictions": "usa" (detailed list of what cannot be brought into the USA and why; if going_usa is "no", write "Not applicable — not traveling to the USA"), "destination" (food rules/restrictions for ${ctx.destinations.join(", ")}), "general" (general tips for a ${ctx.diet} diet while traveling).`;
}

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "NutriCrew AI backend is running" });
});

app.post("/api/generate-plan", async (req, res) => {
  try {
    const { data, lang } = req.body;
    if (!data) return res.status(400).json({ error: "Missing 'data' in request body" });

    const pairingDays = data.pairing_days || 1;
    const ctx = buildContext(data, lang);

    const dayPromises = [];
    for (let i = 1; i <= pairingDays; i++) {
      dayPromises.push(runStructured(buildDayPrompt(data, i, pairingDays, ctx), DAY_SCHEMA, 2500));
    }
    const extrasPromise = runStructured(buildExtrasPrompt(data, pairingDays, ctx), EXTRAS_SCHEMA, 4000);

    const [days, extras] = await Promise.all([Promise.all(dayPromises), extrasPromise]);
    days.forEach((d, i) => { d.day = i + 1; });

    res.json({
      summary: extras.summary,
      days,
      groceryList: extras.groceryList,
      foodRestrictions: extras.foodRestrictions,
    });
  } catch (err) {
    handleAnthropicError(err, res);
  }
});

app.post("/api/estimate-calories", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing 'prompt' in request body" });

    const message = await client.messages.create({
      model: MODEL,
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

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`NutriCrew AI backend listening on port ${PORT}`);
  });
}

export default app;
