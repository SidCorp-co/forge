
export const QA_RATINGS = ["good", "bad", "flagged"] as const;
export type QaRating = (typeof QA_RATINGS)[number];

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
