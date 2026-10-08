/** Set where the figure is not read: a held count is then no statement, and the badge says why. */
export type BadgeRead = "pending" | "failed";

/** Spread onto a row: a count and a read on its way or failed are never both set. */
export interface BadgeFigure {
  badge?: number;
  badgeRead?: BadgeRead;
  /** What the figure counts ("need attention", "in open work"); unset, the count is named by its number alone. */
  badgeCounts?: string;
}

export const ATTENTION_COUNTS = "need attention";

export interface BadgeFace {
  text: string;
  state: "count" | "pending" | "failed";
  color: string;
  background: string;
  /** What the accessible name says after the row's label. */
  phrase: string;
}

const ALARM = { color: "var(--flame-700)", background: "var(--flame-50)" };

/** What a query has answered: an error is `failed` even where an earlier answer is held, no data yet is `pending`. */
export type QueryRead = "pending" | "failed" | "read";

export function queryRead(q: { isError: boolean; data: unknown }): QueryRead {
  if (q.isError) return "failed";
  return q.data === undefined ? "pending" : "read";
}

/** A count only where every read came in, else the read that did not. `counts` names what the figure counts. */
export function badgeFigure(reads: ReadonlyArray<QueryRead>, count: number, counts: string = ATTENTION_COUNTS): BadgeFigure {
  if (reads.includes("failed")) return { badgeRead: "failed", badgeCounts: counts };
  if (reads.includes("pending")) return { badgeRead: "pending", badgeCounts: counts };
  return { badge: count, badgeCounts: counts };
}

export function badgeFace(item: BadgeFigure): BadgeFace | null {
  const counts = item.badgeCounts;
  if (item.badgeRead === "failed") {
    return { text: "!", state: "failed", ...ALARM, phrase: counts ? `how many ${counts} could not be read` : "the count could not be read" };
  }
  if (item.badgeRead === "pending") {
    return {
      text: "…",
      state: "pending",
      color: "var(--fg-muted)",
      background: "var(--bg-sunken)",
      phrase: counts ? `reading how many ${counts}` : "reading the count",
    };
  }
  const count = item.badge && item.badge > 0 ? item.badge : 0;
  if (count === 0) return null;
  return { text: count > 99 ? "99+" : String(count), state: "count", ...ALARM, phrase: counts ? `${count} ${counts}` : String(count) };
}
