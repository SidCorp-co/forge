const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const STAMP = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export const dayOf = (iso: string) => DAY.format(new Date(iso));
export const stampOf = (iso: string) => STAMP.format(new Date(iso));
export const shortSha = (sha: string) => sha.slice(0, 7);

export function durationOf(fromIso: string, toIso: string | null, now = Date.now()): string {
  const ms = (toIso ? new Date(toIso).getTime() : now) - new Date(fromIso).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function msOf(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
