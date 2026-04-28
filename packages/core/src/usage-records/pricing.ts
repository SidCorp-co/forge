// Estimated per-million-token pricing for cost calculation. Source: legacy
// Strapi service; values are USD per 1M tokens. Update as model pricing
// changes — this is a heuristic for dashboards, not billing.
const PRICING: Record<
  string,
  { input: number; output: number; cacheRead?: number; cacheCreation?: number }
> = {
  'claude-3-5-sonnet': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-3-7-sonnet': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-sonnet-4': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-3-5-haiku': { input: 0.8, output: 4.0, cacheRead: 0.08, cacheCreation: 1.0 },
  'claude-haiku-4-5': { input: 0.8, output: 4.0, cacheRead: 0.08, cacheCreation: 1.0 },
  'claude-3-opus': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheCreation: 18.75 },
  'claude-opus-4': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheCreation: 18.75 },
  'claude-opus-4-7': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheCreation: 18.75 },
};

export function lookupPricing(model: string): {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
} | null {
  const normalised = model.toLowerCase();
  for (const [key, val] of Object.entries(PRICING)) {
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
