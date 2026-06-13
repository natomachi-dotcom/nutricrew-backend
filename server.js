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
    type: { type: "string" },
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

const EXERCISE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    sets: { type: "string" },
    reps: { type: "string" },
  },
  required: ["name", "sets", "reps"],
  additionalProperties: false,
};

const GYM_DAY_SCHEMA = {
  type: "object",
  properties: {
    day: { type: "integer" },
    focus: { type: "string" },
    exercises: { type: "array", items: EXERCISE_SCHEMA },
  },
  required: ["day", "focus", "exercises"],
  additionalProperties: false,
};

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    days: { type: "array", items: DAY_SCHEMA },
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
    gymRoutine: {
      type: "object",
      properties: {
        note: { type: "string" },
        days: { type: "array", items: GYM_DAY_SCHEMA },
      },
      required: ["note", "days"],
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
  required: ["summary", "days", "groceryList", "gymRoutine", "foodRestrictions"],
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
  if (err instanceof Anthropic.APIError) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  res.status(500).json({ error: err.message });
}

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "NutriCrew AI backend is running" });
});

app.post("/api/generate-plan", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing 'prompt' in request body" });

    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { format: { type: "json_schema", schema: PLAN_SCHEMA } },
      messages: [{ role: "user", content: prompt }],
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      return res.status(502).json({ error: "The model declined to generate this plan." });
    }

    res.json(extractJSON(message));
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`NutriCrew AI backend listening on port ${PORT}`);
});
