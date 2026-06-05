/* Data-driven color meta for status / health / avatars.
   These intentionally reference the raw brand palette (var(--green-500),
   ...) because the color IS the datum — unlike app chrome, which must use
   the semantic layer. Keep the status vocabulary fixed (design system):
   queued · running · blocked · waiting · passed · failed · paused · done. */

export type StatusKey =
  | "running"
  | "queued"
  | "blocked"
  | "waiting"
  | "passed"
  | "failed"
  | "paused"
  | "done"
  | "review"
  | "zombie"
  | "swept";

export interface ColorMeta {
  label: string;
  fg: string;
  bg: string;
  dot: string;
}

export const STATUS_META: Record<StatusKey, ColorMeta> = {
  running: { label: "Running", fg: "var(--cobalt-700)", bg: "var(--cobalt-50)", dot: "var(--cobalt-500)" },
  queued: { label: "Queued", fg: "var(--ink-600)", bg: "var(--paper-100)", dot: "var(--ink-400)" },
  blocked: { label: "Blocked", fg: "var(--red-600)", bg: "var(--red-50)", dot: "var(--red-500)" },
  waiting: { label: "Waiting", fg: "var(--amberw-600)", bg: "var(--amberw-50)", dot: "var(--amberw-500)" },
  passed: { label: "Passed", fg: "var(--green-600)", bg: "var(--green-50)", dot: "var(--green-500)" },
  failed: { label: "Failed", fg: "var(--red-600)", bg: "var(--red-50)", dot: "var(--red-500)" },
  paused: { label: "Paused", fg: "var(--ink-600)", bg: "var(--paper-100)", dot: "var(--ink-500)" },
  done: { label: "Done", fg: "var(--green-600)", bg: "var(--green-50)", dot: "var(--green-500)" },
  review: { label: "In review", fg: "var(--amberw-600)", bg: "var(--amberw-50)", dot: "var(--amberw-500)" },
  zombie: { label: "Zombie", fg: "var(--red-600)", bg: "var(--red-50)", dot: "var(--red-500)" },
  // ISS-322 — benign auto-cleanup / stale-sweep: a neutral (NOT red) bucket so a
  // session reaped when its run finished, or swept after going stale, never
  // reads as a real failure.
  swept: { label: "Swept", fg: "var(--ink-600)", bg: "var(--paper-100)", dot: "var(--ink-400)" },
};

export type HealthKey = "healthy" | "attention" | "down" | "idle";

export const HEALTH_META: Record<HealthKey, ColorMeta> = {
  healthy: { label: "Healthy", fg: "var(--green-600)", dot: "var(--green-500)", bg: "var(--green-50)" },
  attention: { label: "Attention", fg: "var(--amberw-600)", dot: "var(--amberw-500)", bg: "var(--amberw-50)" },
  down: { label: "Down", fg: "var(--red-600)", dot: "var(--red-500)", bg: "var(--red-50)" },
  idle: { label: "Idle", fg: "var(--ink-600)", dot: "var(--ink-400)", bg: "var(--paper-100)" },
};

export type AvatarHue = "cobalt" | "flame" | "green" | "amber" | "ink";

export const AVATAR_HUE: Record<AvatarHue, { bg: string; fg: string }> = {
  cobalt: { bg: "var(--cobalt-100)", fg: "var(--cobalt-700)" },
  flame: { bg: "var(--flame-100)", fg: "var(--flame-700)" },
  green: { bg: "var(--green-50)", fg: "var(--green-600)" },
  amber: { bg: "var(--amber-50)", fg: "var(--amber-600)" },
  ink: { bg: "var(--paper-200)", fg: "var(--ink-700)" },
};
