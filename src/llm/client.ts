/**
 * LLM client — one OpenAI-compatible client covering all three providers.
 *
 * Ports V2's LLMClient contract to TypeScript. Key invariants (from repo
 * memory + V2 lessons):
 *   - timeout=120s, maxRetries=0 — WE control retry via retryTransient, not the SDK.
 *   - All complete() calls wrapped in retryTransient (transient → backoff, fatal → throw).
 *
 * See docs/PHASE_0_DESIGN.md §6.
 */
import OpenAI, { type ClientOptions } from "openai";
import { log } from "../util/log.js";
import { retryTransient } from "../util/retry.js";
import { getProvider, resolveModel, type ProviderName } from "./providers.js";
import type {
  FinishReason,
  LLMMessage,
  LLMResponse,
  ToolCall,
  ToolDefinition,
} from "../types.js";

export interface CompleteRequest {
  model: string; // concrete model id (already resolved by the loader)
  provider?: ProviderName; // who serves `model`; if omitted, resolved from model
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
}

function mapFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case "stop":
      return "stop";
    case "tool_calls":
      return "tool_calls";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

function normalizeToolCall(raw: {
  id: string;
  type?: string;
  function: { name: string; arguments?: string };
}): ToolCall {
  return {
    id: raw.id,
    type: "function",
    function: { name: raw.function.name, arguments: raw.function.arguments ?? "{}" },
  };
}

export class LLMClient {
  /** Cached OpenAI SDK instances keyed by provider name. */
  private clients = new Map<ProviderName, OpenAI>();

  private sdk(name: ProviderName): OpenAI {
    const cached = this.clients.get(name);
    if (cached) return cached;

    const p = getProvider(name);
    const opts: ClientOptions = {
      baseURL: p.baseURL,
      timeout: 120_000,
      maxRetries: 0, // our retryTransient is in control
    };
    if (p.apiKey) opts.apiKey = p.apiKey;
    const client = new OpenAI(opts);
    this.clients.set(name, client);
    return client;
  }

  /**
   * List models available on a provider instance (GET /v1/models). Used by the
   * `sophron providers <name>` connectivity test. Uses a short timeout (10s) so
   * an unreachable host fails fast rather than blocking the operator.
   */
  async listModels(provider: ProviderName): Promise<{ id: string }[]> {
    const p = getProvider(provider);
    // Fresh client with a short timeout — don't reuse the 120s complete() client.
    const testClient = new OpenAI({
      baseURL: p.baseURL,
      apiKey: p.apiKey ?? undefined,
      timeout: 10_000,
      maxRetries: 0,
    });
    const res = await testClient.models.list();
    return res.data.map((m) => ({ id: m.id }));
  }

  async complete(req: CompleteRequest): Promise<LLMResponse> {
    // Provider is resolved ONCE at agent-load time and carried on the agent.
    // If a caller passes a concrete provider, trust it (no re-resolution).
    // Only fall back to resolveModel when no provider is given (e.g. ad-hoc calls).
    let provider: ProviderName | undefined = req.provider;
    let model = req.model;
    if (!provider) {
      try {
        const resolved = resolveModel(req.model);
        provider = resolved.provider;
        model = resolved.model;
      } catch (e) {
        // Last resort: assume OpenRouter for a bare model id.
        provider = "openrouter";
        log.warn({ model: req.model, err: (e as Error).message }, "no provider; assuming openrouter");
      }
    }

    log.debug({ provider, model, msgCount: req.messages.length }, "LLM complete()");

    const client = this.sdk(provider);

    return retryTransient(async () => {
      const resp = await client.chat.completions.create({
        model,
        messages: req.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        tools: req.tools
          ? (req.tools as unknown as OpenAI.Chat.Completions.ChatCompletionTool[])
          : undefined,
        temperature: req.temperature ?? 0,
      });

      const choice = resp.choices[0];
      if (!choice) {
        throw new Error(`LLM returned no choices (model=${model})`);
      }

      const msg = choice.message;
      return {
        content: msg.content ?? null,
        toolCalls: (msg.tool_calls ?? []).map(normalizeToolCall),
        usage: {
          promptTokens: resp.usage?.prompt_tokens ?? 0,
          completionTokens: resp.usage?.completion_tokens ?? 0,
          totalTokens: resp.usage?.total_tokens ?? 0,
        },
        finishReason: mapFinishReason(choice.finish_reason),
        model: resp.model ?? model,
      };
    });
  }
}
