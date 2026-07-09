/**
 * Unit tests for the OpenAI-compatible LLM client.
 *
 * The OpenAI SDK is replaced with a fake so these tests run offline and
 * assert on streaming aggregation / tool-call reconstruction.
 */
import { describe, expect, it, vi } from "vitest";
import { LLMClient } from "../../src/llm/client.js";
import type { CompleteRequest } from "../../src/llm/client.js";
import type { ProviderName } from "../../src/llm/providers.js";

function makeClientWithFakeStream(
  chunks: unknown[],
): { client: LLMClient; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue(streamFrom(chunks));
  const fakeOpenAI = {
    chat: {
      completions: {
        create,
      },
    },
  };
  const client = new LLMClient();
  // Inject the fake SDK instance directly so provider resolution is bypassed.
  (client as unknown as { clients: Map<ProviderName, unknown> }).clients.set("openrouter", fakeOpenAI);
  return { client, create };
}

function streamFrom(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      let i = 0;
      return {
        next: async () => {
          if (i < chunks.length) {
            return { value: chunks[i++]!, done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

function baseReq(): CompleteRequest {
  return {
    model: "test-model",
    provider: "openrouter" as ProviderName,
    messages: [{ role: "user", content: "hi" }],
  };
}

describe("LLMClient.completeStream", () => {
  it("aggregates content deltas and reports usage", async () => {
    const deltas: string[] = [];
    const { client } = makeClientWithFakeStream([
      { model: "test-model", usage: null, choices: [{ delta: { content: "Hello" } }] },
      { model: "test-model", usage: null, choices: [{ delta: { content: " world" } }] },
      {
        model: "test-model",
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        choices: [],
      },
    ]);

    const response = await client.completeStream(baseReq(), {
      onDelta: (d) => deltas.push(d),
    });

    expect(deltas).toEqual(["Hello", " world"]);
    expect(response.content).toBe("Hello world");
    expect(response.finishReason).toBe("stop");
    expect(response.model).toBe("test-model");
    expect(response.usage).toEqual({ promptTokens: 2, completionTokens: 3, totalTokens: 5 });
  });

  it("reconstructs tool calls from streamed deltas", async () => {
    const { client } = makeClientWithFakeStream([
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "multiply" } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"a":' } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: "2}" } }],
            },
          },
        ],
      },
    ]);

    const response = await client.completeStream(baseReq(), { onDelta: () => {} });

    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]).toEqual({
      id: "call_abc",
      type: "function",
      function: { name: "multiply", arguments: '{"a":2}' },
    });
  });

  it("calls onDelta only for content, not for tool-only deltas", async () => {
    const deltas: string[] = [];
    const { client } = makeClientWithFakeStream([
      { choices: [{ delta: { content: "First" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "noop" } }] } }] },
      { choices: [{ delta: { content: "Second" } }] },
    ]);

    const response = await client.completeStream(baseReq(), {
      onDelta: (d) => deltas.push(d),
    });

    expect(deltas).toEqual(["First", "Second"]);
    expect(response.content).toBe("FirstSecond");
    expect(response.toolCalls).toHaveLength(1);
  });
});
