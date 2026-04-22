import { beforeAll, describe, expect, it } from "vitest";
import { bedrockConverse, loadDotEnv } from "../src/index.js";

loadDotEnv();

const BACKEND = (process.env.E2E_BACKEND ?? "").toLowerCase();
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-opus-4-7";

describe("bedrock smoke", () => {
  let shouldRun = false;
  beforeAll(() => {
    shouldRun =
      BACKEND === "bedrock" &&
      typeof process.env.AWS_BEARER_TOKEN_BEDROCK === "string";
    if (!shouldRun) {
      console.warn(
        `[skip bedrock smoke] set E2E_BACKEND=bedrock and ensure AWS_BEARER_TOKEN_BEDROCK is in .env`,
      );
    }
  });

  it.runIf(() => shouldRun)(
    "reaches Converse with a trivial turn",
    async () => {
      const res = await bedrockConverse({
        modelId: MODEL_ID,
        system: "Reply with a single word.",
        messages: [{ role: "user", content: [{ text: "Say: pong" }] }],
        maxTokens: 16,
      });
      const text = res.output.message.content
        .filter((b): b is { text: string } => "text" in b)
        .map((b) => b.text)
        .join("");
      console.log(`[bedrock smoke]`, {
        model: MODEL_ID,
        stopReason: res.stopReason,
        text: text.slice(0, 80),
      });
      expect(text.toLowerCase()).toContain("pong");
    },
    60_000,
  );
});
