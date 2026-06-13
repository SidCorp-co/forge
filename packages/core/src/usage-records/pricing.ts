// Estimated per-million-token pricing for cost calculation. Values are USD per
// 1M tokens (platform.claude.com/docs/en/pricing, checked 2026-06-11). Update
// as model pricing changes — this is a heuristic for dashboards, not billing.
// Where omitted, cacheRead defaults to 0.1× input and cacheCreation to 1.25×
// input (the standard 5-minute-TTL cache rates).
//
// Matching is LONGEST-KEY-FIRST substring (ISS-438): a generic family prefix
// ('claude-opus-4') can never shadow a more specific version key
// ('claude-opus-4-8') regardless of declaration order — the old first-match
// loop priced every Opus 4.5–4.8 row at the 4.0/4.1 rate (3× too high).
const PRICING: Record<
  string,
  { input: number; output: number; cacheRead?: number; cacheCreation?: number }
> = {
  // Fable/Mythos tier
  'claude-fable-5': { input: 10.0, output: 50.0 },
  'claude-mythos-5': { input: 10.0, output: 50.0 },
  'claude-mythos-preview': { input: 10.0, output: 50.0 },
  // Opus 4.5+ ($5/$25 since the 4.5 launch repricing)
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
  'claude-opus-4-7': { input: 5.0, output: 25.0 },
  'claude-opus-4-6': { input: 5.0, output: 25.0 },
  'claude-opus-4-5': { input: 5.0, output: 25.0 },
  // Opus 4.0/4.1 + Opus 3 (legacy $15/$75)
  'claude-opus-4': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheCreation: 18.75 },
  'claude-3-opus': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheCreation: 18.75 },
  // Sonnet family ($3/$15 across 3.5 → 4.6)
  'claude-sonnet-4': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-3-5-sonnet': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-3-7-sonnet': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.75 },
  // Haiku
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'claude-3-5-haiku': { input: 0.8, output: 4.0, cacheRead: 0.08, cacheCreation: 1.0 },
};

// Longest key first so the most specific substring wins.
const PRICING_ENTRIES = Object.entries(PRICING).sort((a, b) => b[0].length - a[0].length);

export function lookupPricing(model: string): {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
} | null {
  const normalised = model.toLowerCase();
  for (const [key, val] of PRICING_ENTRIES) {
    if (normalised.includes(key)) {
      return {
        input: val.input,
        output: val.output,
        cacheRead: val.cacheRead ?? val.input * 0.1,
        cacheCreation: val.cacheCreation ?? val.input * 1.25,
      };
    }
  }
  return null;
}

export function estimateCost(
  model: string,
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  },
): number {
  const p = lookupPricing(model);
  if (!p) return 0;
  const cost =
    (tokens.inputTokens * p.input) / 1_000_000 +
    (tokens.outputTokens * p.output) / 1_000_000 +
    ((tokens.cacheReadTokens ?? 0) * p.cacheRead) / 1_000_000 +
    ((tokens.cacheCreationTokens ?? 0) * p.cacheCreation) / 1_000_000;
  return Math.round(cost * 100_000) / 100_000;
}
