/** Set where the figure is not read: a held count is then no statement, and the badge says why. */
export type BadgeRead = "pending" | "failed";

/** Spread onto a row: a count and a read on its way or failed are never both set. */
export interface BadgeFigure {
  badge?: number;
  badgeRead?: BadgeRead;
}

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
  if (reads.includes("failed")) return { badgeRead: "failed" };
  if (reads.includes("pending")) return { badgeRead: "pending" };
  return { badge: count };
}

export function badgeFace(item: BadgeFigure): BadgeFace | null {
  if (item.badgeRead === "failed") {
    return { text: "!", state: "failed", ...ALARM, phrase: "how many need attention could not be read" };
  }
  if (item.badgeRead === "pending") {
    return { text: "…", state: "pending", color: "var(--fg-muted)", background: "var(--bg-sunken)", phrase: "reading how many need attention" };
  }
  const count = item.badge && item.badge > 0 ? item.badge : 0;
  if (count === 0) return null;
  return { text: count > 99 ? "99+" : String(count), state: "count", ...ALARM, phrase: `${count} need attention` };
}
