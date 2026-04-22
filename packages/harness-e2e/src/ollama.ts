export interface OllamaToolFunction {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface OllamaTool {
  readonly type: "function";
  readonly function: OllamaToolFunction;
}

export interface OllamaMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly tool_calls?: readonly OllamaToolCall[];
  readonly tool_name?: string;
}

export interface OllamaToolCall {
  readonly type?: "function";
  readonly function: {
    readonly index?: number;
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  };
}

export interface OllamaChatResponse {
  readonly model: string;
  readonly created_at: string;
  readonly message: {
    readonly role: "assistant";
    readonly content: string;
    readonly tool_calls?: OllamaToolCall[];
  };
  readonly done: boolean;
  readonly done_reason?: string;
}

export interface OllamaChatOptions {
  readonly baseUrl?: string;
  readonly model: string;
  readonly messages: readonly OllamaMessage[];
  readonly tools?: readonly OllamaTool[];
  readonly temperature?: number;
  readonly think?: boolean;
  /** Override the fetch implementation (for VCR / testing). */
  readonly fetchImpl?: typeof fetch;
}

export async function ollamaChat(
  opts: OllamaChatOptions,
): Promise<OllamaChatResponse> {
  const baseUrl = opts.baseUrl ?? "http://localhost:11434";
  const body = {
    model: opts.model,
    messages: opts.messages,
    tools: opts.tools,
    stream: false,
    think: opts.think ?? true,
    options: {
      // Qwen3/3.5 recommend sampling (T=0.6). T=0 collapses quality.
      temperature: opts.temperature ?? 0.6,
    },
  };
  const fetchFn = opts.fetchImpl ?? fetch;
  const res = await fetchFn(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Ollama chat failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as OllamaChatResponse;
}

export async function ollamaModelAvailable(
  model: string,
  baseUrl = "http://localhost:11434",
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
