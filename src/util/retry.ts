/**
 * Transient-error classifier + retry helpers.
 *
 * Ported 1:1 from V2's sophron_swarm/retry.py (see repo memory:
 * multi-agent-graph.md — "Transient error handling").
 *
 * Core rule: NEVER trip HALT on transient errors (timeouts, 429, 5xx,
 * connection resets). Retry with exponential backoff + jitter. Only
 * fatal errors propagate.
 *
 * Applied to ALL network I/O: LLM complete() calls (Phase 0) and sandbox
 * exec (Phase 1+). Tool-logic errors are NOT transient — they are returned
 * to the model, never retried.
 */
import { APIError } from "openai";

/** True if the error looks like a transient network/rate-limit/server fault. */
export function isTransientError(e: unknown): boolean {
  // OpenAI SDK error with HTTP status
  if (e instanceof APIError) {
    const status = e.status ?? (e as { statusCode?: number }).statusCode;
    if (status === 429) return true;
    if (typeof status === "number" && status >= 500) return true;
  }

  // Native fetch / network layer
  if (e instanceof TypeError && /fetch|network|fetch failed/i.test(e.message)) {
    return true;
  }

  const msg = String((e as Error)?.message ?? e).toLowerCase();
  return /timeout|timed out|etimedout|econnreset|socket hang up|connect etimedout|epipe|enotfound|getaddrinfo|ai_addrinfo|aborted|reason: socket|fetch failed|network error/i.test(
    msg,
  );
}

export interface RetryOptions {
  retries: number; // max retries (excluding the first attempt)
  baseMs: number; // initial backoff
  maxMs: number; // backoff ceiling
}

export const DEFAULT_RETRY: RetryOptions = {
  retries: 3,
  baseMs: 2000,
  maxMs: 30000,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Retry a transient-failing async function with exponential backoff + jitter.
 * Non-transient errors throw immediately. Exhausting retries rethrows the
 * last error.
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const { retries, baseMs, maxMs } = { ...DEFAULT_RETRY, ...opts };
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransientError(e) || attempt === retries) throw e;
      // full jitter: uniform in [base*2^attempt * 0.8, base*2^attempt * 1.2]
      const exp = baseMs * 2 ** attempt;
      const delay = Math.min(maxMs, exp) * (0.8 + Math.random() * 0.4);
      await sleep(delay);
    }
  }
  // unreachable — loop either returns or throws
  throw lastErr;
}

/** Synchronous variant for non-async code paths (rare). */
export function retrySync<T>(fn: () => T, opts: Partial<RetryOptions> = {}): T {
  const { retries, baseMs, maxMs } = { ...DEFAULT_RETRY, ...opts };
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
      if (!isTransientError(e) || attempt === retries) throw e;
      const exp = baseMs * 2 ** attempt;
      const delay = Math.min(maxMs, exp) * (0.8 + Math.random() * 0.4);
      // busy wait — only use retrySync when truly necessary
      const end = Date.now() + delay;
      while (Date.now() < end) {
        /* spin */
      }
    }
  }
  throw lastErr;
}
