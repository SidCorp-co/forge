import { SCRUB_HEADER_KEYS } from '@forge/observability';

export interface ActualUsage {
  input: number;
  output: number;
  cached: number;
  cacheCreation: number;
  cost: number;
  count: number;
}

export interface PromptEnvelope {
  jobId: string;
  systemPrompt: string | null;
  userPrompt: string | null;
  blocks: unknown[];
  estTokens: { input: number | null };
  actualUsage: ActualUsage | null;
  mcpConfig: unknown;
  model: string | null;
  payloadExtras: Record<string, unknown>;
}

// Walks a JSON value (depth-bounded) and rewrites any property whose KEY matches
// a scrub-header name (case-insensitive). String values become `"[REDACTED <N>
// chars]"`; non-string values collapse to `"[REDACTED]"`. Pure — returns a new
// value, never mutates the input.
export function redactMcpSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redactMcpSecrets(v, depth + 1));
  if (typeof value !== 'object') return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (SCRUB_HEADER_KEYS.has(k.toLowerCase())) {
      out[k] = typeof v === 'string' ? `[REDACTED ${v.length} chars]` : '[REDACTED]';
    } else {
      out[k] = redactMcpSecrets(v, depth + 1);
    }
  }
  return out;
}

const KEYS_SURFACED_ELSEWHERE = new Set(['promptString', 'skillName', 'mcpServers']);

export function extractPayloadExtras(
  payload: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!payload) return {};
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(payload)) {
    if (!KEYS_SURFACED_ELSEWHERE.has(k)) out[k] = payload[k];
  }
  return out;
}
