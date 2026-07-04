import { describe, expect, it } from "vitest";
import { isTransientError, retryTransient } from "../../src/util/retry.js";
import { APIError } from "openai";

describe("isTransientError", () => {
  it("classifies 429 as transient", () => {
    const err = new APIError(429, { message: "rate limited" }, "rate limited", { "x-request-id": "x" });
    expect(isTransientError(err)).toBe(true);
  });

  it("classifies 503 as transient", () => {
    const err = new APIError(503, { message: "unavailable" }, "unavailable", {});
    expect(isTransientError(err)).toBe(true);
  });

  it("classifies 400 as NON-transient", () => {
    const err = new APIError(400, { message: "bad request" }, "bad request", {});
    expect(isTransientError(err)).toBe(false);
  });

  it("classifies network errors by message", () => {
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
    expect(isTransientError(new Error("Request timed out"))).toBe(true);
    expect(isTransientError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientError(new Error("invalid tool args"))).toBe(false);
  });

  it("classifies native fetch TypeError as transient", () => {
    expect(isTransientError(new TypeError("fetch failed: network"))).toBe(true);
  });
});

describe("retryTransient", () => {
  it("returns immediately on success", async () => {
    let calls = 0;
    const result = await retryTransient(async () => {
      calls++;
      return "ok";
    }, { retries: 3, baseMs: 1, maxMs: 10 });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries transient errors then succeeds", async () => {
    let calls = 0;
    const result = await retryTransient(
      async () => {
        calls++;
        if (calls < 3) throw new Error("timeout");
        return "recovered";
      },
      { retries: 5, baseMs: 1, maxMs: 5 },
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  it("throws immediately on non-transient error", async () => {
    let calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls++;
          throw new Error("invalid arguments");
        },
        { retries: 5, baseMs: 1 },
      ),
    ).rejects.toThrow("invalid arguments");
    expect(calls).toBe(1);
  });

  it("rethrows after exhausting retries", async () => {
    let calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls++;
          throw new Error("ETIMEDOUT");
        },
        { retries: 2, baseMs: 1, maxMs: 2 },
      ),
    ).rejects.toThrow("ETIMEDOUT");
    expect(calls).toBe(3); // 1 initial + 2 retries
  });
});
