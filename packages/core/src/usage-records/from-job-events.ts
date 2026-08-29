/**
 * ISS-439 — derive a single usage_records row from the `job_events` a CLI-runner
 * job already streamed to core.
 *
 * The `forge-runner` CLI streams every raw Claude `stream-json` stdout line as a
 * `stdout` job_event (`data.line` = the raw line). A `result` line carries a
 * `usage` token block (snake_case) AND `total_cost_usd` — the authoritative
 * dollar cost the CLI computes itself. Core already stores all of this; it just
 * never materialized a usage_records row from it, so cost-summary / withCost
 * return 0 for CLI-runner work. This extractor closes that gap purely from
 * stored events (no runner change).
 *
 * A print job emits exactly one `result`; a duplex session emits one per turn.
 *
 * Pure + side-effect-free so it can be unit-tested against real payload shapes;
 * the DB hook lives in `materialize.ts`.
 */
import { estimateCost } from './pricing.js';

/** Minimal shape of a job_event row this extractor reads. */
export interface UsageEventRow {
  kind: string;
  data: unknown;
  ts: Date;
}

export interface ExtractedUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requestCount: number;
  /** USD: the result line's `total_cost_usd` when present, else estimateCost(). */
  estimatedCost: number;
  /** Timestamp of the (last) result event — used as recorded_at. */
  recordedAt: Date;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function getLine(ev: UsageEventRow): Record<string, unknown> | null {
  if (ev.kind !== 'stdout') return null;
  const line = (ev.data as { line?: unknown } | null | undefined)?.line;
  return line && typeof line === 'object' ? (line as Record<string, unknown>) : null;
}

/**
 * Pick the dominant model for the row. Preference order:
 *  1. the result line's `modelUsage` map (key with the most input+output tokens),
 *  2. the assistant line whose `message.model` carried the most tokens,
 *  3. the first assistant `message.model` seen,
 *  4. 'unknown'.
 * We store ONE model per row even when a session mixed models — the dominant
 * model is the most representative label; `total_cost_usd` already covers all.
 */
function pickModel(
  resultLine: Record<string, unknown>,
  assistantModelTokens: Map<string, number>,
  firstAssistantModel: string | null,
): string {
  const modelUsage = resultLine.modelUsage;
  if (modelUsage && typeof modelUsage === 'object') {
    let best: string | null = null;
    let bestTokens = -1;
    for (const [model, v] of Object.entries(modelUsage as Record<string, unknown>)) {
      const u = (v ?? {}) as Record<string, unknown>;
      // modelUsage values are camelCase; tolerate snake_case too.
      const toks =
        num(u.inputTokens) + num(u.outputTokens) + num(u.input_tokens) + num(u.output_tokens);
      if (toks > bestTokens) {
        bestTokens = toks;
        best = model;
      }
    }
    if (best) return best;
  }

  let best: string | null = null;
  let bestTokens = -1;
  for (const [model, toks] of assistantModelTokens) {
    if (toks > bestTokens) {
      bestTokens = toks;
      best = model;
    }
  }
  return best ?? firstAssistantModel ?? 'unknown';
}

/**
 * Extract one usage record from a job's events, or null when there is no
 * terminal `result` line (e.g. the job died before Claude emitted its result —
 * nothing reliable to record).
 */
// cm:guard the two halves of a `result` line accumulate DIFFERENTLY, and reading either one the other's way silently misbills every duplex job. Measured on claude 2.1.251, 2026-08-29, two turns of one resident session: `usage` and `num_turns` are PER-TURN (turn 2 read `output_tokens: 3`, not 6), while `total_cost_usd` and `modelUsage` are CUMULATIVE (0.319836 -> 0.3452315). So tokens and turns are summed across every result line and cost is taken from the last — the reverse of what the original one-result-per-job shape suggested. On print there is exactly one result line, where summing and last-wins are the same number.
export function extractUsageFromEvents(events: UsageEventRow[]): ExtractedUsage | null {
  let resultLine: Record<string, unknown> | null = null;
  let resultTs: Date | null = null;
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, turns: 0 };
  const assistantModelTokens = new Map<string, number>();
  let firstAssistantModel: string | null = null;

  for (const ev of events) {
    const line = getLine(ev);
    if (!line) continue;
    const type = line.type;
    if (type === 'result') {
      resultLine = line;
      resultTs = ev.ts;
      const u = (line.usage ?? {}) as Record<string, unknown>;
      totals.input += num(u.input_tokens);
      totals.output += num(u.output_tokens);
      totals.cacheRead += num(u.cache_read_input_tokens);
      totals.cacheCreation += num(u.cache_creation_input_tokens);
      totals.turns += num(line.num_turns);
    } else if (type === 'assistant') {
      const msg = line.message as Record<string, unknown> | undefined;
      const model = msg?.model;
      if (typeof model === 'string' && model) {
        if (!firstAssistantModel) firstAssistantModel = model;
        const usage = (msg?.usage ?? {}) as Record<string, unknown>;
        const toks = num(usage.input_tokens) + num(usage.output_tokens);
        assistantModelTokens.set(model, (assistantModelTokens.get(model) ?? 0) + toks);
      }
    }
  }

  if (!resultLine) return null;

  const { input: inputTokens, output: outputTokens } = totals;
  const { cacheRead: cacheReadTokens, cacheCreation: cacheCreationTokens } = totals;
  // cm:guard `pickModel` reads the LAST line's `modelUsage` alone, which is right for the same reason the sums above are: that map is cumulative, so it already names the dominant model of the whole session rather than of the final turn.
  const model = pickModel(resultLine, assistantModelTokens, firstAssistantModel);
  const requestCount = totals.turns || 1;

  const totalCost = resultLine.total_cost_usd;
  const estimatedCost =
    typeof totalCost === 'number' && Number.isFinite(totalCost)
      ? totalCost
      : estimateCost(model, { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens });

  return {
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    requestCount,
    estimatedCost,
    recordedAt: resultTs ?? new Date(),
  };
}
