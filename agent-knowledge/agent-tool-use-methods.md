# Learning Guide: Tool Use Methods — Function Calling, Schemas, and Execution Patterns

**Generated**: 2026-04-19
**Sources**: 20 resources analyzed
**Depth**: medium
**Scope**: How LLMs invoke tools reliably across Anthropic, OpenAI, MCP, and open-source ecosystems.

## Prerequisites

- Familiarity with a chat-completions-style LLM API (messages, roles, responses)
- Basic JSON Schema literacy (`type`, `properties`, `required`, `enum`)
- Conceptual understanding of an "agent loop": model emits an action, host executes it, result is fed back
- One programming language for running examples (Python / TypeScript)

## TL;DR

- Every major vendor has converged on the same shape: the model returns a structured **tool call** (name + JSON arguments), the host executes it, and the result is fed back as a **tool result** message in the next turn. Claude calls the blocks `tool_use` / `tool_result`; OpenAI calls them `tool_calls` / `role: "tool"`; MCP wraps both in `tools/call` JSON-RPC.
- **The tool description is the prompt.** Detailed, unambiguous descriptions and well-typed schemas (enums, `required`, `additionalProperties: false`) dominate model behavior far more than any runtime parameter. Aim for 3-4 sentences minimum per tool, with explicit "when to use / when not to use" guidance.
- **Reliability comes from grammar-constrained decoding.** Both OpenAI's `strict: true` and Anthropic's `strict: true` compile your JSON schema into a grammar and guarantee outputs match it, eliminating type-mismatch and missing-field errors at the token level.
- **Parallel tool use is the default on modern models** (Claude 4.x, GPT-4o+). Preserve it by returning all tool results inside a *single* user message; splitting them across multiple messages trains the model to stop parallelizing.
- **At scale, tool definitions become the enemy.** A multi-server MCP setup can burn 55k+ tokens before useful work starts, and selection accuracy degrades past ~30-50 tools. Solutions: **MCP** for standardization, **tool search / `defer_loading`** for lazy schema loading, and consolidation (one capable tool beats ten granular ones).
- **Benchmarks to know**: Berkeley Function Calling Leaderboard (BFCL v3/v4: AST + executable + multi-turn + agentic), ToolBench/ToolLLM (16k APIs), Gorilla/APIBench. Common failure modes: hallucinated APIs, wrong types, implicit action gaps, state unawareness, over-planning.

## Core Concepts

### 1. The Agent Loop (Every Vendor Does This)

The mechanics are near-identical across Anthropic, OpenAI, and open-source harnesses:

1. You send the model a prompt plus a list of **tool definitions** (name, description, JSON schema of inputs).
2. The model either responds with text, or emits one or more **tool call** blocks containing a tool name and JSON arguments, and signals "I'm waiting" via a stop reason.
3. Your host code parses the call, executes the underlying function, and sends the result back as a **tool result** message in the next turn, referenced by a correlation ID.
4. The model consumes the result and either calls more tools or produces a final answer.

The model **never actually executes** anything. It only generates structured requests. This is true on OpenAI, Anthropic, Hugging Face Transformers, and MCP equally.

**Key insight**: The "loop" is just repeated turns of the same chat API. Any abstraction beyond that (LangChain's agents, Anthropic's Tool Runner, OpenAI's Assistants) is convenience around the same four steps.

### 2. Anthropic Tool Use: `tool_use` / `tool_result` Blocks

Anthropic models emit **content blocks** of type `tool_use`:

```json
{
  "type": "tool_use",
  "id": "toolu_01A09q90qw90lq917835lq9",
  "name": "get_weather",
  "input": { "location": "San Francisco, CA", "unit": "fahrenheit" }
}
```

The response stops with `stop_reason: "tool_use"`. Your code runs the tool, then sends back a user message containing a `tool_result` block keyed by the same `id`:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
      "content": "68°F, partly cloudy"
    }
  ]
}
```

**`tool_choice` options**: `auto` (default), `any` (must call some tool), `tool` (must call *this* tool), `none` (block all tool calls). `any` and `tool` prefill the assistant turn to force a tool block, so the model emits no natural-language preface. Extended thinking is only compatible with `auto` and `none`.

**Tool system prompt overhead**: Defining tools silently adds 313-346 tokens of system prompt on Claude 4.x models, regardless of how many tools you define (assuming at least one). This is fixed overhead on top of the serialized schemas.

### 3. OpenAI Function Calling: `tools` / `tool_calls`

OpenAI's shape is structurally identical but named differently. Tools are passed as:

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "...",
    "parameters": { "type": "object", "properties": {...}, "required": [...] }
  }
}
```

The model response contains `tool_calls` with each call carrying a `function.name` and a `function.arguments` string (which you must `JSON.parse`), and `finish_reason: "tool_calls"`. You reply with a message of `role: "tool"` referencing `tool_call_id`.

**`tool_choice`**: `auto`, `none`, `required` (OpenAI's equivalent of Anthropic's `any`), or `{type: "function", function: {name: "..."}}`.

**`parallel_tool_calls: true`** is the default on GPT-4o and later, allowing multiple `tool_calls` in one response. Set to `false` to force one-at-a-time.

**Responses API (2025)**: A newer, stateful endpoint that unifies Chat Completions, Assistants, and built-in tools (web search, file search, computer use) behind one surface. Tool shape is the same; the difference is state management — the API tracks the thread for you.

### 4. Strict Mode and Structured Outputs

Both OpenAI and Anthropic ship grammar-constrained decoding for tools, marketed as `strict: true`.

**What it guarantees**:
- Every field listed in your schema appears with the exact type you specified.
- `enum` values are one of the allowed options (not a paraphrase).
- `additionalProperties: false` is enforced — the model cannot invent new keys.
- Types never cross: `passengers: "two"` or `passengers: "2"` will not appear; you get `passengers: 2`.

**What it costs**:
- **First-request latency**: The schema is compiled into a context-free grammar on the server; subsequent requests hit a cache (Anthropic: 24 hours since last use).
- **Schema limitations**: Only a subset of JSON Schema is supported. Anthropic + OpenAI both require `additionalProperties: false` on every object and typically require all keys in `required` (OpenAI strict mode eliminates optional properties entirely; use unions with `null` instead).
- **Failure modes**: If the model gets confused and the grammar keeps allowing tokens, it can loop generating valid-but-useless output until hitting `max_tokens`.

OpenAI's `response_format: { type: "json_schema", json_schema: {..., strict: true} }` is the non-tool version of the same machinery — use it when you want structured data without the tool-calling ceremony.

**HIPAA/PHI warning (Anthropic)**: Schemas are cached separately and do *not* get the same retention guarantees as message content. Never put PHI in property names, enum values, or regex patterns.

### 5. JSON Schema Design: Descriptions Are the Prompt

Every benchmark and engineering guide agrees: schema quality dominates tool use success. Concrete rules:

- **Tool descriptions need 3-4 sentences minimum.** Explain what it does, when to use it, when *not* to use it, what it returns, and any caveats. Anthropic's own example contrasts "Gets the stock price for a ticker" (bad) with a three-sentence description naming the exchanges, units, and scope (good).
- **Prefer enums over free text** for anything with a closed set of values. `unit: {enum: ["celsius", "fahrenheit"]}` eliminates a whole class of errors. This is even more valuable under strict mode where the grammar enforces it.
- **Use `required` aggressively.** Unless a field is truly optional, mark it required. Opus is more likely to ask for missing required fields; Sonnet/Haiku will often guess.
- **Description fields on each property matter.** Don't just name `ticker: {type: "string"}` — describe what a ticker looks like (`"e.g. AAPL for Apple Inc."`). These descriptions are prompt tokens the model reads.
- **Avoid generic parameter names.** `user_id` beats `user`; `file_path` beats `path`. Semantic names resolve ambiguity without extra tokens.
- **Namespace your tool names.** `github_list_prs`, `slack_send_message` — prefix by service. This matters hugely for tool search (regex/BM25 patterns search both names and descriptions) and for selection accuracy with large tool sets.
- **Consolidate related operations.** One `schedule_event` tool with an `action` parameter beats three tools (`list_users`, `list_events`, `create_event`). Anthropic's engineering blog is emphatic: "Avoid low-signal tools" that force the agent to process irrelevant data.
- **Shape responses for tokens.** Return semantic IDs (slugs, names) over opaque UUIDs. Include only fields the model needs to plan its next step. Bloated responses waste context.

### 6. Input Examples (Anthropic)

Anthropic tools accept an optional `input_examples` array alongside `input_schema`. Each example must validate against the schema (invalid examples return 400). Examples are included in the prompt alongside the schema, teaching the model concrete patterns:

```json
"input_examples": [
  {"location": "San Francisco, CA", "unit": "fahrenheit"},
  {"location": "Tokyo, Japan", "unit": "celsius"},
  {"location": "New York, NY"}
]
```

The last example demonstrates that `unit` is optional. Cost: ~20-50 extra prompt tokens for simple cases, ~100-200 for complex. Not supported for server-side tools or when using tool_search.

### 7. Parallel vs Sequential Execution

Modern models emit multiple tool_use blocks in a single response when operations are independent. Claude 4.x and GPT-4o+ both do this by default.

**When to batch (parallel)**:
- Independent reads: "check weather in SF and NYC" → both in one turn.
- Fan-out: three file reads, multiple API lookups.
- Anthropic's recommended system prompt: *"For maximum efficiency, whenever you perform multiple independent operations, invoke all relevant tools simultaneously rather than sequentially."*

**When to sequence**:
- One tool's output determines the next tool's input.
- You need to validate a result before proceeding (e.g., don't `delete_file` until `list_files` confirms it exists).

**The critical formatting rule (Anthropic)**: When returning multiple `tool_result` blocks, **put them all in one user message**. Splitting them across separate user messages trains the model — within the same conversation — to stop emitting parallel calls. This is the most common footgun.

**Disabling**: `disable_parallel_tool_use: true` (Anthropic) forces at most one tool per turn under `auto`, or exactly one under `any`/`tool`. OpenAI equivalent: `parallel_tool_calls: false`.

### 8. Fine-Grained Tool Streaming (Anthropic Beta)

Standard streaming delivers `input_json_delta` events that are buffered and validated before being surfaced, adding noticeable latency for large tool inputs (e.g., writing long file contents). Fine-grained tool streaming bypasses the buffer.

Set `eager_input_streaming: true` on the tool definition and `stream: true` on the request. The model streams tool parameters essentially character-by-character, often in larger chunks (fewer word breaks). Reported effect: 15s → 3s for multi-KB parameter payloads.

**Tradeoff**: No guarantee the final JSON is valid. If `max_tokens` is hit mid-parameter, you get partial JSON. Your code must handle invalid/truncated input explicitly. Anthropic's pattern for returning malformed JSON back to the model as a tool error:

```json
{ "INVALID_JSON": "<your invalid json string>" }
```

**Accumulation pattern** (still required even without streaming):

```python
if event.type == "content_block_start" and event.content_block.type == "tool_use":
    tool_inputs[event.index] = ""
elif event.type == "content_block_delta" and event.delta.type == "input_json_delta":
    tool_inputs[event.index] += event.delta.partial_json
elif event.type == "content_block_stop" and event.index in tool_inputs:
    parsed = json.loads(tool_inputs[event.index])
```

The initial `content_block_start` has `input: {}` as a placeholder — the real value arrives as concatenated string deltas.

### 9. Deferred Tools / Lazy Schema Loading (Claude Code's ToolSearch Pattern)

At ~10+ tools, context bloat and selection accuracy both degrade. A multi-server setup (GitHub + Slack + Sentry + Grafana + Splunk) can consume ~55k tokens in definitions before the model does any actual work. Anthropic's engineering team reports selection accuracy "degrades significantly once you exceed 30-50 available tools."

**The pattern**: Mark rarely-used tools with `defer_loading: true`. They are excluded from the system prompt. Add a `tool_search_tool_regex_20251119` or `tool_search_tool_bm25_20251119` server tool. When the model needs a tool, it searches the catalog (tool names, descriptions, arg names, arg descriptions are all searched), and the API returns 3-5 `tool_reference` blocks that auto-expand into full definitions inline.

```json
{ "type": "tool_search_tool_regex_20251119", "name": "tool_search_tool_regex" },
{
  "name": "get_weather",
  "description": "...",
  "input_schema": { ... },
  "defer_loading": true
}
```

**Key constraints**:
- The search tool itself must not have `defer_loading: true`.
- At least one tool must be non-deferred (400 error otherwise).
- Regex variant uses Python `re.search()` syntax, max 200 characters; BM25 variant uses natural language.
- Up to 10,000 tools in the catalog.
- Keep your 3-5 most-used tools non-deferred for performance.

**Why it works for caching**: Deferred tools are not in the system prompt prefix, so prompt caching is preserved. Discovered tools appear inline as `tool_reference` blocks, so they're reused in subsequent turns without re-searching. This is a concrete instance of the broader "just-in-time retrieval" principle from Anthropic's context engineering guidance.

**Client-side equivalent**: Implement your own search (e.g., via embeddings) and return `tool_reference` blocks from a standard tool result. The expansion machinery still works.

### 10. Model Context Protocol (MCP): The Cross-Vendor Standard

MCP is an open JSON-RPC 2.0 protocol that standardizes how AI applications discover and invoke external capabilities. Adopted by Claude, ChatGPT, VS Code, Cursor, and many others, it positions itself as "USB-C for AI applications."

**Architecture**:
- **Host**: the AI application (Claude Desktop, VS Code, Cursor, Claude Code).
- **Client**: a connector inside the host, one per server.
- **Server**: a program exposing capabilities. Can run locally (stdio transport) or remotely (Streamable HTTP with SSE).

**Three server primitives**:
- **Tools**: executable functions (what everyone means when they say "MCP tools"). Discovered via `tools/list`, invoked via `tools/call`.
- **Resources**: data sources (file contents, DB records) the model or user can read.
- **Prompts**: reusable templates.

**Three client primitives** (that servers can request):
- **Sampling**: server asks the host's LLM to complete a prompt (lets server authors stay model-independent).
- **Elicitation**: server asks the user for additional input.
- **Logging**: server sends log messages to the client.

**Lifecycle**: connection starts with an `initialize` handshake that negotiates protocol version and capabilities (`{tools: {listChanged: true}, resources: {}}`). Servers can push `notifications/tools/list_changed` to prompt the client to refresh.

**Tool schema in MCP**:
```json
{
  "name": "weather_current",
  "title": "Weather Information",
  "description": "Get current weather information for any location worldwide",
  "inputSchema": {
    "type": "object",
    "properties": { "location": {"type": "string", "description": "..."} },
    "required": ["location"]
  }
}
```

Nearly identical to Anthropic/OpenAI tool shapes — this is intentional and what makes MCP tools portable.

**Security**: The spec is explicit that tools "represent arbitrary code execution" and descriptions should be treated as untrusted unless from a trusted server. Hosts MUST obtain user consent before invoking tools and before exposing user data to servers. This is the primary attack surface for prompt injection in MCP deployments.

**Reference servers**: filesystem, git, fetch, memory (knowledge-graph persistence), sequential-thinking, time, "everything" (test server). SDKs exist for TypeScript, Python, C#, Go, Java, Kotlin, PHP, Ruby, Rust, Swift.

### 11. Reliability: JSON Mode, Structured Outputs, Repair Loops

Before strict/structured modes, the state of the art was:

1. **JSON mode** (OpenAI's original): guarantees syntactically valid JSON but not schema conformance. Fields can be missing, types wrong, extra keys present.
2. **Prompt-only structured output**: "Respond with JSON matching this schema." Model compliance is best-effort; parse errors happen.
3. **Function calling without strict**: same as (2) but the schema is in the tools API rather than the prompt. Slightly more reliable on trained-for-tools models.

**Repair loop pattern** (what libraries like Instructor, BAML, and many production systems do when strict mode isn't available or sufficient):

```
1. Model emits JSON
2. Validate against schema (Pydantic, Zod, JSON Schema validator)
3. If invalid:
   a. Build an error message ("field X expected int, got string")
   b. Send back as a tool_result or user message
   c. Re-invoke the model
4. Cap retries (typically 1-3)
5. Log failures for schema tuning
```

**Why strict mode doesn't obsolete repair loops**:
- Schema constraints are syntactic. The model can still produce semantically wrong values ("location: 'Mars'" when you asked for an Earth city).
- Fine-grained streaming disables validation — partial/invalid JSON is possible.
- Business-logic validation (the product ID exists, the user has permission) happens after schema validation.

### 12. Research: Benchmarks and Failure Modes

**Berkeley Function Calling Leaderboard (BFCL)** — the de facto standard for tool use evaluation.

- **v1**: Introduced AST-based evaluation (checking that the generated call matches the expected function signature syntactically).
- **v2**: Added enterprise and open-source contributed functions.
- **v3**: Multi-turn and multi-step, with 1,000 entries across Base Multi-Turn (200), Missing Parameters (200), Missing Functions (200), Long-Context (200), and Composite (200). Evaluation is both **state-based** (does the final backend state match ground truth) and **response-based** (do ground-truth calls appear in the execution path). An entry passes only if both checks pass for all turns.
- **v4**: Holistic agentic evaluation including web search.
- **Two pathways**: FC (native tool calling) and Prompt (text-generation workarounds). Models are ranked by accuracy, latency, and estimated USD cost.

**BFCL v3 failure modes identified**:
1. **Implicit Action Gaps**: model fails to infer necessary exploratory steps (e.g., doesn't check fuel before filling a tank despite a cost constraint).
2. **State Unawareness**: model doesn't check current state before acting (e.g., creates a duplicate directory while already in the target).
3. **Over-Planning**: unnecessary re-authentication or setup steps the user didn't ask for.

**ToolBench / ToolLLM (arXiv 2307.16789)**: 16,464 real-world RESTful APIs across 49 categories. Three-stage construction (API collection from RapidAPI, instruction generation, solution path annotation). Introduced ToolEval for automatic scoring and ToolLLaMA, a fine-tuned model with performance comparable to ChatGPT on API calling plus strong zero-shot generalization to unseen APIs. A depth-first-search decision tree improves reasoning by letting the model evaluate multiple paths.

**Gorilla / APIBench (arXiv 2305.15334)**: Focused on HuggingFace, TorchHub, TensorHub APIs. Key finding: even GPT-4 struggles with accurate input arguments and hallucinates API usage. Retrieval-aware training substantially reduces hallucination; documents can change at test time without retraining (useful for versioned APIs).

**Toolformer (arXiv 2302.04761)**: Self-supervised — the model learns to insert tool calls into its own training data from a handful of demonstrations per API. Core insight: LLMs struggle with basic arithmetic where much smaller specialized models excel; strategic tool use bridges the gap without hurting language modeling.

**Recurring failure modes across all benchmarks**:
- Hallucinated tool names (calling a function that doesn't exist).
- Wrong argument types (strings for ints, dates in wrong format).
- Missing required arguments.
- Over-calling (invoking tools when no tool is needed).
- Under-calling (answering from memory when tools are mandatory).
- Parameter order confusion in positional-style APIs.
- Poor multi-turn state tracking (forgetting prior results).

## Code Examples

### Basic Anthropic Tool Use (strict, with enum)

```python
import anthropic
client = anthropic.Anthropic()

response = client.messages.create(
    model="claude-opus-4-7",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Weather in SF, in Fahrenheit?"}],
    tools=[{
        "name": "get_weather",
        "description": (
            "Get current weather for a US city. Use when the user asks about "
            "current conditions (not forecasts). Returns temperature, humidity, "
            "and a short description. Requires a city+state string."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "location": {"type": "string",
                             "description": "City and state, e.g. 'San Francisco, CA'"},
                "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
            },
            "required": ["location"],
            "additionalProperties": False
        }
    }]
)
```

### Parallel Tool Handling (correct result formatting)

```python
# After the initial response with multiple tool_use blocks...
tool_results = []
for block in response.content:
    if block.type == "tool_use":
        output = run_tool(block.name, block.input)   # your executor
        tool_results.append({
            "type": "tool_result",
            "tool_use_id": block.id,
            "content": output
        })

# CRITICAL: all results in ONE user message
messages.extend([
    {"role": "assistant", "content": response.content},
    {"role": "user", "content": tool_results},   # <- single message, list of blocks
])
```

### OpenAI Function Calling (with strict)

```python
from openai import OpenAI
client = OpenAI()

resp = client.chat.completions.create(
    model="gpt-4o-2024-08-06",
    messages=[{"role": "user", "content": "Book 2 tickets to Tokyo on 2026-06-01"}],
    tools=[{
        "type": "function",
        "function": {
            "name": "search_flights",
            "description": "Search one-way flights on a specific date.",
            "strict": True,
            "parameters": {
                "type": "object",
                "properties": {
                    "destination": {"type": "string"},
                    "departure_date": {"type": "string", "format": "date"},
                    "passengers": {"type": "integer", "enum": [1,2,3,4,5,6,7,8,9,10]}
                },
                "required": ["destination", "departure_date", "passengers"],
                "additionalProperties": False
            }
        }
    }],
    tool_choice="auto",
    parallel_tool_calls=True,
)

for call in resp.choices[0].message.tool_calls or []:
    args = json.loads(call.function.arguments)   # arguments is a string!
    result = run_tool(call.function.name, args)
    # reply with a message of role="tool", tool_call_id=call.id
```

### Deferred Tools + Tool Search (Anthropic)

```python
tools = [
    {"type": "tool_search_tool_regex_20251119", "name": "tool_search_tool_regex"},
    # Keep 3-5 common tools NOT deferred:
    {"name": "read_file", "description": "...", "input_schema": {...}},
    # Defer the long tail:
    {"name": "github_list_prs", "description": "...",
     "input_schema": {...}, "defer_loading": True},
    {"name": "slack_send_message", "description": "...",
     "input_schema": {...}, "defer_loading": True},
    # ... hundreds more
]
```

### MCP Server Tool Invocation (JSON-RPC)

```json
// Discovery
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }

// Invocation
{
  "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": {
    "name": "weather_current",
    "arguments": { "location": "San Francisco", "units": "imperial" }
  }
}

// Response
{
  "jsonrpc": "2.0", "id": 3,
  "result": {
    "content": [{ "type": "text", "text": "68°F, partly cloudy, wind 8mph W" }]
  }
}
```

### Fine-Grained Tool Streaming + Accumulation

```python
with client.messages.stream(
    model="claude-opus-4-7", max_tokens=65536,
    tools=[{
        "name": "make_file",
        "description": "Write text to a file.",
        "eager_input_streaming": True,   # enable fine-grained
        "input_schema": {...}
    }],
    messages=[{"role": "user", "content": "Write a long poem to poem.txt"}],
) as stream:
    buffers = {}
    for event in stream:
        if event.type == "content_block_start" and event.content_block.type == "tool_use":
            buffers[event.index] = ""
        elif event.type == "content_block_delta" and event.delta.type == "input_json_delta":
            buffers[event.index] += event.delta.partial_json
            # Optional: render partial progress
        elif event.type == "content_block_stop" and event.index in buffers:
            try:
                parsed = json.loads(buffers[event.index])
            except json.JSONDecodeError:
                # wrap invalid JSON to feed back as an error
                parsed = {"INVALID_JSON": buffers[event.index]}
```

### Open-Source Path (Hugging Face Transformers)

```python
def get_current_temperature(location: str, unit: str):
    """
    Get the current temperature at a location.

    Args:
        location: The location, e.g. "Paris, France"
        unit: The unit. (choices: ["celsius", "fahrenheit"])
    """
    return 22.0

tokenizer = AutoTokenizer.from_pretrained("NousResearch/Hermes-2-Pro-Llama-3-8B")
inputs = tokenizer.apply_chat_template(
    messages, tools=[get_current_temperature],
    add_generation_prompt=True, return_dict=True, return_tensors="pt"
)
# Model emits: {"arguments": {"location": "Paris, France", "unit": "celsius"},
#               "name": "get_current_temperature"}
# You append it under "tool_calls" in an assistant message, run it,
# append a {"role": "tool", "content": "22"} message, and loop.
```

The key detail: `apply_chat_template` will auto-convert Python functions to JSON Schema via `get_json_schema()`, but **only if your docstring is Google-style**. Open-source tool-use chat templates (Hermes, Mistral Instruct, Llama tool-use variants) each emit tool calls in model-specific formats, so parsing is model-specific.

## Common Pitfalls

| Pitfall | Why It Happens | How to Avoid |
|---------|---------------|--------------|
| Model emits wrong type (`"2"` instead of `2`) | Schema is a suggestion, not a constraint, without strict mode | Enable `strict: true` (Anthropic + OpenAI); validate server-side and repair |
| Model stops emitting parallel tool calls after a few turns | You split multiple `tool_result` blocks across separate user messages | Return all tool_results in a single user message with a content array |
| Context window blown by tool definitions alone | 10+ tools × long descriptions × forced re-send each turn | Use `defer_loading` + tool_search (Anthropic); consolidate tools; shorten descriptions |
| Agent hallucinates a tool that doesn't exist | Underspecified context, weak tool names, too many near-duplicates | Namespace tool names by service; write 3-4 sentence descriptions; add `input_examples` |
| Agent asks for credentials it already has | "Over-planning" failure from BFCL v3 | System prompt stating prior state; return identifiers that imply authenticated context |
| Agent skips exploration ("implicit action gap") | Model assumes state without checking | System prompt requiring state validation; return tool results that surface missing info |
| Partial JSON after `max_tokens` in streaming | Fine-grained tool streaming disables validation | Handle incomplete JSON explicitly; increase `max_tokens`; wrap invalid JSON in `{"INVALID_JSON": "..."}` |
| Strict mode rejects your schema | Uses unsupported JSON Schema features (oneOf, $ref with cycles, format validation gaps) | Check vendor's supported subset; flatten schemas; replace unsupported features |
| Tools return bloated responses | Dumping raw API output into tool_result | Filter to high-signal fields; use semantic IDs (slugs) not UUIDs; paginate |
| PHI leaked in schema | Putting patient identifiers in enums/property names/descriptions | Keep PHI only in message content; schemas are cached separately without HIPAA retention |
| `tool_choice: any` disables thinking | Forced tool choice prefills the turn, bypassing extended thinking | Use `tool_choice: auto` with explicit prompting when you need thinking + tools |
| Claude Code / IDE blows up at 100+ MCP tools | All MCP server tool definitions loaded eagerly | Use `mcp_toolset` with `defer_loading: true`; filter by server; disable unused servers |
| Forgot `JSON.parse` on OpenAI `function.arguments` | OpenAI returns arguments as a JSON *string*, not an object | Always `json.loads(call.function.arguments)` before passing to your tool |
| Model calls tools when it shouldn't | `tool_choice: auto` with weak prompt; user message is conversational | Use `tool_choice: none` for pure-chat turns; prompt "answer from memory when possible" |
| MCP server treated as trusted | Specification warns tool descriptions are untrusted input | Obtain user consent per-invocation; never auto-approve destructive tools; sandbox |

## Best Practices

Synthesized from 20 sources:

1. **Write tool descriptions like onboarding docs.** Aim for 3-4 sentences explaining what it does, when to use it, when NOT to use it, and what it returns. This is by far the highest-leverage lever. (Sources: Anthropic define-tools, Anthropic writing-tools-for-agents)

2. **Enable strict mode for anything that touches real systems.** The latency cost is one-time per schema; the reliability gain is permanent. (Sources: Anthropic strict-tool-use, OpenAI structured outputs)

3. **Consolidate tools, don't multiply them.** One `schedule_event` beats three CRUD helpers. Fewer, more capable tools mean less selection ambiguity and faster onboarding for the agent. (Source: Anthropic writing-tools-for-agents)

4. **Use enums wherever possible.** Closed sets eliminate entire error classes and compose perfectly with strict mode's grammar. (Source: Anthropic define-tools, strict-tool-use)

5. **Namespace tool names by service or resource.** `github_list_prs`, `slack_send_message`. This is essential for tool search (which greps both names and descriptions) and helps the model disambiguate at scale. (Source: Anthropic writing-tools-for-agents, tool-search-tool)

6. **Return all tool_results in one user message when there are parallel calls.** Breaking this rule is the #1 way teams accidentally disable parallelism. (Source: Anthropic parallel-tool-use)

7. **Scale past 30-50 tools with `defer_loading` + tool_search.** Keep your 3-5 high-frequency tools in the prefix; defer the rest. This preserves prompt caching and keeps selection accuracy high. (Source: Anthropic tool-search-tool, context-engineering)

8. **Prefer MCP when exposing tools to multiple model vendors.** It standardizes tool discovery (`tools/list`), invocation (`tools/call`), and the JSON schema shape, so one implementation works across Claude, ChatGPT, and IDE assistants. (Source: MCP introduction, MCP architecture)

9. **Shape tool responses for tokens.** Return semantic IDs (names, slugs) not UUIDs; include only the fields the agent needs; offer a `detail: "concise" | "detailed"` parameter for verbose tools. (Source: Anthropic writing-tools-for-agents)

10. **Use `input_examples` for complex schemas.** Nested objects, format-sensitive strings, or tools with multiple valid input patterns benefit from 2-3 concrete examples — which are validated against your schema so they can't drift. (Source: Anthropic define-tools)

11. **Pick `tool_choice` deliberately.** `auto` for agentic flows, `any` or `required` for guaranteed tool invocation (note: loses the preface text and extended thinking), `none` for pure-chat turns. (Source: Anthropic define-tools, OpenAI function calling)

12. **Instrument for parallel tool usage.** Track `avg_tools_per_message` > 1.0 as a canary; regressions mean either prompt drift or mis-formatted tool results. (Source: Anthropic parallel-tool-use)

13. **Validate beyond strict mode.** Strict guarantees schema, not semantics. Add a thin business-logic validation step (ID exists, permission granted, value in range) with a single repair attempt before bubbling errors to the user. (Source: OpenAI structured outputs, general best practice)

14. **For fine-grained streaming, always handle invalid JSON.** Wrap malformed buffers as `{"INVALID_JSON": "..."}` when feeding back to the model, and cap retries. (Source: Anthropic fine-grained-tool-streaming)

15. **Treat MCP tool descriptions as untrusted.** The spec is explicit. Require user consent before invocation and never auto-run destructive MCP tools, even "safe-sounding" ones. (Source: MCP specification)

## Further Reading

| Resource | Type | Why Recommended |
|----------|------|-----------------|
| [Anthropic: Tool use overview](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/overview) | Official docs | Canonical reference for tool_use/tool_result mechanics |
| [Anthropic: Define tools](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/define-tools) | Official docs | Definitive guide on schemas, descriptions, tool_choice, input_examples |
| [Anthropic: Strict tool use](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/strict-tool-use) | Official docs | Grammar-constrained decoding, HIPAA caveats, examples |
| [Anthropic: Parallel tool use](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/parallel-tool-use) | Official docs | The definitive formatting rules that preserve parallelism |
| [Anthropic: Fine-grained tool streaming](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/fine-grained-tool-streaming) | Official docs | Streaming large tool inputs; `eager_input_streaming` flag |
| [Anthropic: Tool search tool](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/tool-search-tool) | Official docs | Deferred loading, regex vs BM25, scaling past 10k tools |
| [Anthropic Engineering: Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) | Engineering blog | Highest-signal guidance on tool design; consolidation patterns |
| [Anthropic Engineering: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Engineering blog | Just-in-time retrieval framework that motivates tool search |
| [OpenAI Cookbook: Function calling](https://developers.openai.com/cookbook/examples/how_to_call_functions_with_chat_models) | Cookbook | Practical Python examples, tool_choice semantics |
| [OpenAI: Introducing Structured Outputs](https://openai.com/index/introducing-structured-outputs-in-the-api/) | Announcement | Context for strict mode, grammar-based token filtering |
| [Simon Willison on OpenAI Structured Outputs](https://simonwillison.net/2024/Aug/6/openai-structured-outputs/) | Analysis | Practical limitations, failure modes, schema subset |
| [Model Context Protocol: Introduction](https://modelcontextprotocol.io/introduction) | Official docs | MCP overview and ecosystem positioning |
| [MCP Architecture](https://modelcontextprotocol.io/docs/learn/architecture) | Official docs | Client/server model, transports, primitives, lifecycle |
| [MCP Specification 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18) | Spec | Authoritative message formats, security requirements |
| [MCP Reference Servers](https://github.com/modelcontextprotocol/servers) | Repo | Canonical implementations: filesystem, git, fetch, memory |
| [Hugging Face: Tool use in Transformers](https://huggingface.co/docs/transformers/en/chat_extras) | Official docs | Open-source path: chat templates, auto-schema from Python functions |
| [Berkeley Function Calling Leaderboard](https://gorilla.cs.berkeley.edu/leaderboard.html) | Benchmark | The standard for evaluating tool use reliability |
| [BFCL v3 Multi-Turn Blog](https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html) | Research blog | Multi-turn failure modes: action gaps, state unawareness, over-planning |
| [ToolBench / ToolLLM (arXiv 2307.16789)](https://arxiv.org/abs/2307.16789) | Research paper | 16k-API benchmark, DFS-based reasoning, ToolLLaMA |
| [Toolformer (arXiv 2302.04761)](https://arxiv.org/abs/2302.04761) | Research paper | Self-supervised tool learning; why tools close reasoning gaps |
| [Gorilla / APIBench (arXiv 2305.15334)](https://arxiv.org/abs/2305.15334) | Research paper | Retrieval-aware training for API calling; hallucination mitigation |

---

*This guide was synthesized from 20 sources. See `resources/agent-tool-use-methods-sources.json` for full source metadata and quality scores.*
