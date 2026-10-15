
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
 * Compact elapsed span from a duration in ms, e.g. `42s` / `3m` / `4h` / `2d`.
 * Unlike `formatRelativeTime` it reads no clock, so a caller holding one instant
 * grades every row against it.
 */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

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

/** Format an estimated cost in USD. `$X.XX`, with small-value and zero cases. */
export function formatUsd(usd: number | null | undefined): string {
  if (usd == null) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Human duration from milliseconds: `820ms` · `4.2s` · `3m 12s` · `1h 04m`. */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Human duration from seconds. */
export function formatDurationSec(sec: number | null | undefined): string {
  if (sec == null) return "—";
  return formatDurationMs(sec * 1000);
}
