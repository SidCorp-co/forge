
export interface ColorMeta {
  label: string;
  fg: string;
  bg: string;
  dot: string;
}

export type SemanticTone =
  | "success"
  | "shipped"
  | "archived"
  | "failure"
  | "active"
  | "attention"
  | "blocked"
  | "neutral"
  | "infra";

export const TONE_META: Record<SemanticTone, ColorMeta> = {
  success: { label: "Success", fg: "var(--green-600)", bg: "var(--green-50)", dot: "var(--green-500)" },
  shipped: { label: "Shipped", fg: "var(--flame-700)", bg: "var(--flame-50)", dot: "var(--flame-600)" },
  // `archived` = closed/filed-away. Heavier ink than `blocked` (ink-700/paper-200)
  // so a closed issue is distinct from a parked `on_hold`. ISS-511.
  archived: { label: "Archived", fg: "var(--ink-900)", bg: "var(--paper-300)", dot: "var(--ink-600)" },
  failure: { label: "Failure", fg: "var(--red-600)", bg: "var(--red-50)", dot: "var(--red-500)" },
  active: { label: "Active", fg: "var(--cobalt-700)", bg: "var(--cobalt-50)", dot: "var(--cobalt-500)" },
  attention: { label: "Attention", fg: "var(--amberw-600)", bg: "var(--amberw-50)", dot: "var(--amberw-500)" },
  // `blocked` is a heavier ink than `neutral` so a parked issue reads as
  // "stopped", not "new" — but stays calm (no alarm-red).
  blocked: { label: "Blocked", fg: "var(--ink-700)", bg: "var(--paper-200)", dot: "var(--ink-500)" },
  neutral: { label: "Neutral", fg: "var(--ink-600)", bg: "var(--paper-100)", dot: "var(--ink-400)" },
  // `infra` = a cool slate ("dimmed / offline"), deliberately NOT red, so an
  // offline runner is never mistaken for a code failure (ISS-509 screenshot-1).
  infra: { label: "Infra", fg: "var(--slate-600)", bg: "var(--slate-50)", dot: "var(--slate-500)" },
};

export type StatusKey =
  | "running"
  | "queued"
  | "blocked"
  | "waiting"
  | "passed"
  | "failed"
  | "paused"
  | "done"
  | "shipped"
  | "archived"
  | "review"
  | "zombie"
  | "swept";

export const STATUS_KEY_TONE: Record<StatusKey, SemanticTone> = {
  running: "active",
  queued: "neutral",
  blocked: "blocked",
  waiting: "attention",
  passed: "success",
  failed: "failure",
  paused: "blocked",
  done: "success",
  // ISS-511 — the issue lifecycle tail splits off the shared `success`/green so a
  // released vs closed vs verified issue is distinct. Issue-domain only.
  shipped: "shipped",
  archived: "archived",
  // The review/test stages are AUTOMATED pipeline work in motion → `active`
  // (cobalt), not amber. Amber is reserved strictly for "a human must act".
  review: "active",
  // A LIVE stalled session is genuinely attention-worthy (ISS-322) → failure.
  zombie: "failure",
  // ISS-322 — benign auto-cleanup / stale-sweep stays neutral, never red.
  swept: "neutral",
};

/** Resolve a StatusKey's colors through its tone — the single derivation. */
export function statusKeyMeta(key: StatusKey): ColorMeta {
  const tone = TONE_META[STATUS_KEY_TONE[key]];
  return { label: STATUS_KEY_LABEL[key], fg: tone.fg, bg: tone.bg, dot: tone.dot };
}

/** Chip labels for the StatusKey vocabulary (the tone carries the color; the
 *  label carries the precise meaning so color is never the only signal). */
export const STATUS_KEY_LABEL: Record<StatusKey, string> = {
  running: "Running",
  queued: "Queued",
  blocked: "Blocked",
  waiting: "Waiting",
  passed: "Passed",
  failed: "Failed",
  paused: "Paused",
  done: "Done",
  shipped: "Released",
  archived: "Closed",
  review: "In review",
  zombie: "Zombie",
  swept: "Swept",
};

export const STATUS_META: Record<StatusKey, ColorMeta> = {
  running: statusKeyMeta("running"),
  queued: statusKeyMeta("queued"),
  blocked: statusKeyMeta("blocked"),
  waiting: statusKeyMeta("waiting"),
  passed: statusKeyMeta("passed"),
  failed: statusKeyMeta("failed"),
  paused: statusKeyMeta("paused"),
  done: statusKeyMeta("done"),
  shipped: statusKeyMeta("shipped"),
  archived: statusKeyMeta("archived"),
  review: statusKeyMeta("review"),
  zombie: statusKeyMeta("zombie"),
  swept: statusKeyMeta("swept"),
};

export type HealthKey = "healthy" | "attention" | "down" | "idle";

/** Health rolls up onto the same tones: down → `infra` (offline ≠ failure). */
export const HEALTH_KEY_TONE: Record<HealthKey, SemanticTone> = {
  healthy: "success",
  attention: "attention",
  down: "infra",
  idle: "neutral",
};

const HEALTH_KEY_LABEL: Record<HealthKey, string> = {
  healthy: "Healthy",
  attention: "Attention",
  down: "Down",
  idle: "Idle",
};

export const HEALTH_META: Record<HealthKey, ColorMeta> = {
  healthy: { ...TONE_META[HEALTH_KEY_TONE.healthy], label: HEALTH_KEY_LABEL.healthy },
  attention: { ...TONE_META[HEALTH_KEY_TONE.attention], label: HEALTH_KEY_LABEL.attention },
  down: { ...TONE_META[HEALTH_KEY_TONE.down], label: HEALTH_KEY_LABEL.down },
  idle: { ...TONE_META[HEALTH_KEY_TONE.idle], label: HEALTH_KEY_LABEL.idle },
};

export type AvatarHue = "cobalt" | "flame" | "green" | "amber" | "ink";

export const AVATAR_HUE: Record<AvatarHue, { bg: string; fg: string }> = {
  cobalt: { bg: "var(--cobalt-100)", fg: "var(--cobalt-700)" },
  flame: { bg: "var(--flame-100)", fg: "var(--flame-700)" },
  green: { bg: "var(--green-50)", fg: "var(--green-600)" },
  amber: { bg: "var(--amber-50)", fg: "var(--amber-600)" },
  ink: { bg: "var(--paper-200)", fg: "var(--ink-700)" },
};
