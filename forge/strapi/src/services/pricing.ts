const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-opus-4-6-20251101': { input: 15, output: 75 },
  'claude-opus-4-5-20251101': { input: 15, output: 75 },
  'claude-sonnet-4-5-20250929': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
}; // per million tokens

/**
 * Strip LiteLLM provider prefixes (e.g. "anthropic/claude-sonnet-4-5" → "claude-sonnet-4-5")
 */
function stripPrefix(model: string): string {
  const slashIdx = model.indexOf('/');
  return slashIdx >= 0 ? model.slice(slashIdx + 1) : model;
}

export const DEFAULT_MODEL = 'claude-opus-4-6';

export interface SessionUsage {
  inputTotal: number;
  outputTotal: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  contextUsed: number;
}

/**
 * Estimate cost for an agent session including cache token pricing.
 * Cache read tokens: 10% of input rate. Cache write tokens: 125% of input rate.
 */
export function estimateSessionCost(usage: SessionUsage, model?: string): number {
  const m = model || DEFAULT_MODEL;
  const stripped = stripPrefix(m);
  let pricing = PRICING[stripped];
  if (!pricing) {
    const key = Object.keys(PRICING).find((k) => stripped.startsWith(k));
    if (key) pricing = PRICING[key];
  }
  if (!pricing) return 0;

  const input = (usage.inputTotal || 0) * pricing.input;
  const output = (usage.outputTotal || 0) * pricing.output;
  const cacheRead = (usage.cacheRead || 0) * pricing.input * 0.1;
  const cacheWrite = (usage.cacheWrite || 0) * pricing.input * 1.25;
  return (input + output + cacheRead + cacheWrite) / 1_000_000;
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const stripped = stripPrefix(model);
  let pricing = PRICING[stripped];
  if (!pricing) {
    const key = Object.keys(PRICING).find((k) => stripped.startsWith(k));
    if (key) pricing = PRICING[key];
  }
  if (!pricing) return 0;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}
