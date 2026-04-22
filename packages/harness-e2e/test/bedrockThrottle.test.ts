import { describe, expect, it } from "vitest";
import { bedrockConverse } from "../src/index.js";

/**
 * Rate-limit injection test.
 *
 * Goal: when Bedrock returns a 429 `ThrottlingException`, `bedrockConverse`
 * must raise a clearly-attributable error — not swallow it, not retry
 * silently, not throw a confusing parse error from trying to JSON.parse
 * an error body.
 *
 * We inject a stub fetch that returns 429 with the real AWS error body
 * shape. Real traffic isn't touched.
 */
describe("bedrockConverse error surfaces", () => {
  it("surfaces a 429 ThrottlingException with a readable message", async () => {
    const stubFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          __type: "com.amazon.coral.availability#ThrottlingException",
          message: "Too many requests, please wait before trying again.",
        }),
        { status: 429, statusText: "Too Many Requests" },
      );

    await expect(
      bedrockConverse({
        fetchImpl: stubFetch,
        token: "test-token",
        region: "us-east-1",
        modelId: "anthropic.claude-opus-4-7",
        messages: [{ role: "user", content: [{ text: "hi" }] }],
      }),
    ).rejects.toThrow(/429.*ThrottlingException|429.*Too Many/i);
  });

  it("surfaces a 400 validation error without hanging", async () => {
    const stubFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          message: "temperature is deprecated for this model",
        }),
        { status: 400, statusText: "Bad Request" },
      );

    await expect(
      bedrockConverse({
        fetchImpl: stubFetch,
        token: "test-token",
        region: "us-east-1",
        modelId: "anthropic.claude-opus-4-7",
        messages: [{ role: "user", content: [{ text: "hi" }] }],
      }),
    ).rejects.toThrow(/400.*temperature is deprecated/);
  });

  it("surfaces a 500 internal error (not retry silently)", async () => {
    let calls = 0;
    const stubFetch: typeof fetch = async () => {
      calls++;
      return new Response("upstream boom", {
        status: 500,
        statusText: "Internal Server Error",
      });
    };

    await expect(
      bedrockConverse({
        fetchImpl: stubFetch,
        token: "test-token",
        region: "us-east-1",
        modelId: "anthropic.claude-opus-4-7",
        messages: [{ role: "user", content: [{ text: "hi" }] }],
      }),
    ).rejects.toThrow(/500/);
    expect(calls).toBe(1);
  });

  it("passes through a 200 response without issue (sanity)", async () => {
    const stubFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          output: {
            message: { role: "assistant", content: [{ text: "pong" }] },
          },
          stopReason: "end_turn",
        }),
        { status: 200, statusText: "OK" },
      );

    const res = await bedrockConverse({
      fetchImpl: stubFetch,
      token: "test-token",
      region: "us-east-1",
      modelId: "anthropic.claude-opus-4-7",
      messages: [{ role: "user", content: [{ text: "hi" }] }],
    });
    expect(res.stopReason).toBe("end_turn");
  });
});
