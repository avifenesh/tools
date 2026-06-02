// OpenAI-compatible chat backend for the e2e harness.
//
// Why this exists: the e2e runner originally spoke only Ollama-native /api/chat.
// A local llama.cpp server (e.g. the Qwen3.6-27B daily driver on :8001) exposes
// the OpenAI /v1/chat/completions surface instead. This adapter lets the same
// e2e suites drive that server with no other changes — it translates the OpenAI
// request/response shape to/from the OllamaChatResponse the runner consumes.
//
// Mapping notes:
//   - tool_calls.function.arguments is a JSON STRING in OpenAI, an OBJECT in the
//     Ollama shape the runner expects -> parse it here.
//   - tool result messages: OpenAI wants { role:"tool", tool_call_id, content };
//     the runner produces { role:"tool", content, tool_name } -> we synthesize a
//     tool_call_id from the assistant's prior tool_calls by name.
//   - thinking models (Qwen) emit reasoning the OpenAI surface returns in content;
//     no separate "think" flag — sampling temperature is the only knob we pass.
import type {
  OllamaChatOptions,
  OllamaChatResponse,
  OllamaMessage,
  OllamaToolCall,
} from "./ollama.js";

interface OpenAIToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

interface OpenAIChoiceMessage {
  readonly role: string;
  readonly content: string | null;
  readonly tool_calls?: OpenAIToolCall[];
}

interface OpenAIChatResponse {
  readonly model?: string;
  readonly choices: ReadonlyArray<{
    readonly message: OpenAIChoiceMessage;
    readonly finish_reason?: string;
  }>;
}

/** Translate the runner's Ollama-shaped messages into OpenAI chat messages. */
function toOpenAIMessages(
  messages: readonly OllamaMessage[],
): Array<Record<string, unknown>> {
  // track the most recent assistant tool_calls so tool results can be paired by name
  let lastCallIdByName = new Map<string, string>();
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      lastCallIdByName = new Map();
      const calls = m.tool_calls.map((c, i) => {
        const id = `call_${out.length}_${i}`;
        lastCallIdByName.set(c.function.name, id);
        return {
          id,
          type: "function" as const,
          function: {
            name: c.function.name,
            arguments: JSON.stringify(c.function.arguments ?? {}),
          },
        };
      });
      out.push({ role: "assistant", content: m.content ?? "", tool_calls: calls });
      continue;
    }
    if (m.role === "tool") {
      const id =
        (m.tool_name && lastCallIdByName.get(m.tool_name)) ?? "call_unknown";
      out.push({ role: "tool", tool_call_id: id, content: m.content });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

/** OpenAI /v1/chat/completions call returning the OllamaChatResponse shape. */
export async function openaiChat(
  opts: OllamaChatOptions,
): Promise<OllamaChatResponse> {
  // Prefer the explicit OpenAI base env; ignore an Ollama-style baseUrl the
  // test may have passed (those default to :11434/api, wrong surface here).
  const baseUrl =
    process.env.E2E_OPENAI_BASE_URL ??
    (opts.baseUrl && opts.baseUrl.includes("/v1")
      ? opts.baseUrl
      : "http://127.0.0.1:8001/v1");
  const apiKey = process.env.E2E_OPENAI_API_KEY ?? "aviary-local";
  const body = {
    model: opts.model,
    messages: toOpenAIMessages(opts.messages),
    tools: opts.tools,
    stream: false,
    temperature: opts.temperature ?? 0.6,
  };
  const fetchFn = opts.fetchImpl ?? fetch;
  const res = await fetchFn(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`OpenAI chat failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as OpenAIChatResponse;
  const choice = data.choices[0];
  if (!choice) {
    throw new Error("OpenAI chat returned no choices");
  }
  const toolCalls: OllamaToolCall[] | undefined = choice.message.tool_calls?.map(
    (c) => ({
      type: "function" as const,
      function: {
        name: c.function.name,
        arguments: parseArgs(c.function.arguments),
      },
    }),
  );
  return {
    model: data.model ?? opts.model,
    created_at: "",
    message: {
      role: "assistant",
      content: choice.message.content ?? "",
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    },
    done: true,
    ...(choice.finish_reason ? { done_reason: choice.finish_reason } : {}),
  };
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Liveness probe: GET {baseUrl}/models on the OpenAI surface. */
export async function openaiModelAvailable(
  model: string,
  baseUrl = "http://127.0.0.1:8001/v1",
): Promise<boolean> {
  try {
    const apiKey = process.env.E2E_OPENAI_API_KEY ?? "aviary-local";
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return false;
    // llama.cpp serves a single model; presence of the endpoint is enough.
    return true;
  } catch {
    return false;
  }
}
