/**
 * Approximate token counter.
 *
 * Exact counts come from provider responses (`usage.prompt_tokens`); this is
 * only for pre-flight budget estimates (context meter, compaction triggers).
 *
 * Heuristic: ~3.5 chars per token (matches SwarmClaw's `chars / 3.5` formula
 * so numbers line up with industry practice for English/code).
 */
export function approxTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

/** Sum tokens across many strings (e.g. all message contents). */
export function approxTokensMany(texts: Iterable<string>): number {
  let total = 0;
  for (const t of texts) total += approxTokens(t);
  return total;
}
