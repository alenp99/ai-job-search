import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "./config";

let client: Anthropic | null = null;

export function claudeConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function getClient(): Anthropic {
  if (!claudeConfigured()) {
    throw new Error("ANTHROPIC_API_KEY is not set on the server. Add it in Railway → Variables.");
  }
  client ??= new Anthropic();
  return client;
}

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AskOptions {
  system: string;
  prompt: Anthropic.MessageParam["content"];
  effort?: Effort;
  maxTokens?: number;
  tools?: unknown[];
  /** JSON schema for structured output; the reply is parsed and returned as an object. */
  schema?: Record<string, unknown>;
}

export interface AskResult<T> {
  text: string;
  json: T;
  usage: { input: number; output: number };
}

/**
 * One streamed Messages API call. The stable system prompt is cached, and refusals
 * fall back server-side (fallbacks: "default") instead of failing the pipeline.
 */
export async function ask<T = unknown>(opts: AskOptions): Promise<AskResult<T>> {
  const params: Record<string, unknown> = {
    model: MODEL,
    max_tokens: opts.maxTokens ?? 32000,
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: opts.prompt }],
    output_config: {
      effort: opts.effort ?? "medium",
      ...(opts.schema ? { format: { type: "json_schema", schema: opts.schema } } : {}),
    },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  };
  if (opts.tools) params.tools = opts.tools;

  // Server tools (web search) can pause a long turn; resume until it ends.
  const messages = params.messages as Anthropic.Beta.BetaMessageParam[];
  let message: Anthropic.Beta.BetaMessage;
  for (let turn = 0; ; turn++) {
    // fallbacks / betas are newer than some SDK typings; pass them through as-is.
    const stream = getClient().beta.messages.stream(params as never);
    message = await stream.finalMessage();
    if (message.stop_reason !== "pause_turn" || turn >= 5) break;
    messages.push({ role: "assistant", content: message.content as never });
  }

  if (message.stop_reason === "refusal") {
    throw new Error("Claude declined this request (refusal). Try editing the posting text.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Claude's reply hit the token limit before finishing.");
  }

  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  let json = undefined as T;
  if (opts.schema) {
    try {
      json = JSON.parse(text) as T;
    } catch {
      throw new Error("Claude returned malformed JSON for a structured request.");
    }
  }
  return {
    text,
    json,
    usage: { input: message.usage.input_tokens, output: message.usage.output_tokens },
  };
}

export const webSearchTool = { type: "web_search_20260209", name: "web_search", max_uses: 6 };
