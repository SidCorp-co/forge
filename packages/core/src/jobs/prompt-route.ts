import { SCRUB_HEADER_KEYS } from '@forge/observability';

export interface ActualUsage {
  input: number;
  output: number;
  cached: number;
  cacheCreation: number;
  cost: number;
  count: number;
}

/**
 * PR-7a — Resolved per-state dispatch flags surfaced on the Inspector
 * envelope. These are the values the dispatcher computed AT DISPATCH TIME
 * (after applying `appConfig.pipeline.states[stage]` overrides + defaults),
 * not the raw config. Lets operators see exactly what reached the runner.
 */
export interface ResolvedFlags {
  state: string | null;
  skillName: string | null;
  model: string | null;
  allowedTools: string | null;
  permissionMode: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions' | null;
  timeoutSeconds: number | null;
  sessionGroup: string | null;
  claudeSessionId: string | null;
  systemPromptMode: 'append' | 'replace' | null;
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
  resolvedFlags: ResolvedFlags;
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

const KEYS_SURFACED_ELSEWHERE = new Set([
  'promptString',
  'skillName',
  'mcpServers',
  // PR-7a — dispatcher-stamped flags surfaced under `resolvedFlags` so
  // `payloadExtras` doesn't double-render them in the Inspector UI.
  'model',
  'allowedTools',
  'permissionMode',
  'timeoutSeconds',
  'sessionGroup',
  'stageStatus',
  'claudeSessionId',
  'mcpServersOverride',
]);

/**
 * Surface the dispatcher-resolved flags on the Inspector envelope. Reads
 * the stamped values out of `job.payload` (set by the orchestrator at
 * enqueue time + the dispatcher at dispatch time).
 */
export function extractResolvedFlags(
  payload: Record<string, unknown> | null | undefined,
  job: {
    skillName?: string | null;
    modelUsed?: string | null;
  },
): ResolvedFlags {
  const p = payload ?? {};
  const str = (k: string): string | null => {
    const v = p[k];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  const allowedTools = (() => {
    const v = p.allowedTools;
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.join(',');
    return null;
  })();
  const permissionMode = (() => {
    const v = p.permissionMode;
    return v === 'default' || v === 'plan' || v === 'acceptEdits' || v === 'bypassPermissions'
      ? v
      : null;
  })();
  const timeoutSeconds = typeof p.timeoutSeconds === 'number' ? p.timeoutSeconds : null;
  // systemPromptMode comes from the per-state systemPrompt.mode if a stage
  // override was applied; missing → null (caller renders as "default append").
  let systemPromptMode: 'append' | 'replace' | null = null;
  const sp = p.systemPromptMode;
  if (sp === 'append' || sp === 'replace') systemPromptMode = sp;

  return {
    state: str('stageStatus'),
    skillName: job.skillName ?? str('skillName'),
    model: job.modelUsed ?? str('model'),
    allowedTools,
    permissionMode,
    timeoutSeconds,
    sessionGroup: str('sessionGroup'),
    claudeSessionId: str('claudeSessionId'),
    systemPromptMode,
  };
}

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
