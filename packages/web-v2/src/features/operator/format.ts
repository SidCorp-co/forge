/* Value formatting for the Operator Ops Console. Every function answers for a
   null by returning the em-dash rather than "0" — a ratio with no denominator
   is not a zero, and the four endpoints send null for exactly that case. */

export const NO_VALUE = "—";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function formatCount(n: number | null | undefined): string {
  if (n == null) return NO_VALUE;
  return n < 10_000 ? String(Math.round(n)) : compact.format(n);
}

export function formatUsd(n: number | null | undefined): string {
  if (n == null) return NO_VALUE;
  if (n === 0) return "$0";
  return n < 1 ? `$${n.toFixed(2)}` : `$${compact.format(n)}`;
}

/** Minutes as the largest unit that keeps two significant figures — an ops
 *  reader wants "1.9d", not "2678m". */
export function formatMinutes(n: number | null | undefined): string {
  if (n == null) return NO_VALUE;
  if (n < 60) return `${Math.round(n)}m`;
  if (n < 60 * 48) return `${(n / 60).toFixed(1)}h`;
  return `${(n / 1440).toFixed(1)}d`;
}

export function formatPercent(n: number | null | undefined): string {
  if (n == null) return NO_VALUE;
  return `${n.toFixed(n < 10 ? 1 : 0)}%`;
}

export function formatRatio(n: number | null | undefined): string {
  if (n == null) return NO_VALUE;
  return n.toFixed(2);
}

/** Signed percentage move against the preceding window. */
export function formatDelta(deltaPct: number | null | undefined): string | null {
  if (deltaPct == null || !Number.isFinite(deltaPct)) return null;
  const rounded = Math.abs(deltaPct) < 10 ? deltaPct.toFixed(1) : String(Math.round(deltaPct));
  return `${deltaPct > 0 ? "+" : ""}${rounded}%`;
}

/** Coarse age of an ISO instant. Alerts carry `since` and nothing else about time. */
export function formatSince(iso: string | null, now: number = Date.now()): string | null {
  if (!iso) return null;
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 48) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

export function formatWeek(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
