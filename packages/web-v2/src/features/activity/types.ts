// web-v2 feature module: activity — types + pure derive helpers.
//
// A cross-project feed of agent Q&A turns. The standalone workspace Activity
// page was removed in ISS-359 (replaced by Usage); these types + hooks now power
// the "Recent activity" widget on the workspace Overview
// (`features/overview/components/activity-feed.tsx`). Row shape mirrors the exact
// projection `GET /api/chat-logs` returns (a drizzle `select()` over the
// `chat_logs` table — camelCase keys), verified against
// `packages/core/src/chat-logs/routes.ts` + `db/schema.ts` (do not guess
// field names).

export const QA_RATINGS = ["good", "bad", "flagged"] as const;
export type QaRating = (typeof QA_RATINGS)[number];

/** Anthropic-format token usage as persisted on the chat-log row (snake_case
    from the model response). Older rows may be `null` or partial. */
export interface ChatLogUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** One row of `GET /api/chat-logs` — a single agent conversation turn. */
export interface ChatLogRow {
  id: string;
  sessionId: string;
  projectSlug: string;
  userKey: string | null;
  query: string;
  reply: string | null;
  model: string | null;
  ragContext: unknown[] | null;
  toolCalls: unknown[] | null;
  usage: ChatLogUsage | null;
  iterations: number;
  durationMs: number | null;
  error: string | null;
  queryIntent: string | null;
  condensedQuery: string | null;
  source: string;
  qualitySignals: Record<string, unknown> | null;
  qaRating: QaRating | null;
  qaNotes: string | null;
  createdAt: string;
}

/** `''` is the "all" sentinel for the source segmented control + selects. */
export type SourceFilter = "" | "web" | "cli" | "mcp" | "api";

/** Sum the input/output tokens of a page of rows for the throughput stats. */
export function sumTokens(rows: ChatLogRow[]): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const r of rows) {
    input += r.usage?.input_tokens ?? 0;
    output += r.usage?.output_tokens ?? 0;
  }
  return { input, output };
}

/** Compact token count: `1234` → `1.2k`, `2_000_000` → `2.0M`. */
export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Human duration from milliseconds: `820` → `820ms`, `1240` → `1.2s`. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Badge tone for a QA rating chip. */
export function ratingTone(rating: QaRating): "green" | "red" | "amber" {
  return rating === "good" ? "green" : rating === "bad" ? "red" : "amber";
}
