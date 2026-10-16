import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-6-luna-fast",
  reasoning: "high",
  defaultTools: false,
  tool: false,
  limits: { maxInputTokensPerSession: 20000, maxOutputTokensPerSession: 3000 },
});
