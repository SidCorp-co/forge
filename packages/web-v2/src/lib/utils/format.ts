
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
