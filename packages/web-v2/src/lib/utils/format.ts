// Shared formatting helpers. Consolidated from ~6 near-identical local copies
// (ISS-397 cleanup) — one of which had silently drifted to Math.round, giving
// inconsistent "Ns ago" rounding. Floor is canonical here.

/**
 * Compact relative time, e.g. `3s ago` / `5m ago` / `2h ago` / `4d ago`.
 * Returns `emptyLabel` (default "") for null/empty/invalid input, so callers
 * can render it directly or branch on truthiness.
 */
export function formatRelativeTime(
  iso: string | null | undefined,
  opts: { emptyLabel?: string } = {},
): string {
  const empty = opts.emptyLabel ?? "";
  if (!iso) return empty;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return empty;
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Compact forward countdown, e.g. `in 40 min` / `in 6h` / `in 3 days`, and
 * `any moment now` once the moment has passed. Returns "" for null/invalid,
 * so callers can branch on truthiness the way `formatRelativeTime` allows.
 */
export function formatCountdown(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "any moment now";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `in ${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.ceil(ms / 86_400_000)} days`;
}
