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

/** A count only where every read came in, else the read that did not. */
export function badgeFigure(reads: ReadonlyArray<"pending" | "failed" | "read">, count: number): BadgeFigure {
  if (reads.includes("failed")) return { badgeRead: "failed", badgeCounts: ATTENTION_COUNTS };
  if (reads.includes("pending")) return { badgeRead: "pending", badgeCounts: ATTENTION_COUNTS };
  return { badge: count, badgeCounts: ATTENTION_COUNTS };
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
