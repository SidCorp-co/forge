// web-v2 feature module: activity — types + pure derive helpers.
//
// A cross-project feed of agent Q&A turns. The standalone workspace Activity
// page was removed in ISS-359 (replaced by Usage); no screen renders these
// today — `lib/ws/event-router.ts` still invalidates their `['chat-logs']` key.
// Row shape mirrors the exact projection `GET /api/chat-logs` returns (a
// drizzle `select()` over the `chat_logs` table — camelCase keys), verified
// against `packages/core/src/chat-logs/routes.ts` + `db/schema.ts` (do not
// guess field names).

export const QA_RATINGS = ["good", "bad", "flagged"] as const;
export type QaRating = (typeof QA_RATINGS)[number];

/** `chat_logs.usage` as core writes it — `run-turn-core.ts:usageForLog`: the
    summed provider usage plus, only when non-zero, what `context-budget.ts`
    elided. Older rows may be `null` or partial. */
export interface ChatLogUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedPromptTokens?: number;
  elided?: { historyMessages: number; truncatedToolResults: number; overBudget: boolean };
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
    input += r.usage?.promptTokens ?? 0;
    output += r.usage?.completionTokens ?? 0;
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

/** Badge tone for a QA rating chip. */
export function ratingTone(rating: QaRating): "green" | "red" | "amber" {
  return rating === "good" ? "green" : rating === "bad" ? "red" : "amber";
}
