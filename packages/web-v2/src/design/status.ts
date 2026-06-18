/* Data-driven color meta for status / health / avatars.
   These intentionally reference the raw brand palette (var(--green-500),
   ...) because the color IS the datum — unlike app chrome, which must use
   the semantic layer. Keep the status vocabulary fixed (design system):
   queued · running · blocked · waiting · passed · failed · paused · done.

   ISS-509 — ONE semantic-tone source of truth.
   Color used to be picked independently in ~7 places, so the same meaning got
   different colors and different meanings shared a color (a real `failed` job
   and an `offline` runner both red; a benign `on_hold` issue red in a dashboard
   but neutral in its chip; the pipeline "active" bead sharing the primary-action
   flame). The fix: every status surface resolves through `TONE_META` below, and
   the THREE concepts (issue chip · session chip · pipeline bead) stay
   distinguishable by SHAPE + label, never by re-picking a color.

   `SemanticTone` is the vocabulary. `STATUS_KEY_TONE` maps the fixed StatusKey
   set onto it; `statusToTone` (features/issues/derive.ts) maps the 18 issue
   lifecycle statuses through `statusToChip` so a status's tone is identical in
   its chip and in every dashboard bucket. */

export interface ColorMeta {
  label: string;
  fg: string;
  bg: string;
  dot: string;
}

/**
 * The canonical semantic tones. Each = exactly ONE fg/bg/dot token. Reserve
 * `failure` (red) for a REAL failure only — a benign cleanup, a paused issue, a
 * blocked-by-dependency, or an offline runner must NEVER read red.
 *  - success   terminal-good: passed / done / released / closed / healthy
 *  - failure   a real failure: job `failed`, a live `zombie`/`stalled` session
 *  - active    machine working: running, in_progress, the review/test stages
 *  - attention a HUMAN must act: awaiting approval / info / your review
 *  - blocked   parked, not a failure: on_hold, blocked-by-dependency (calm ink)
 *  - neutral   backlog / idle / benign cleanup (`swept`, ISS-322)
 *  - infra     infrastructure down (runner offline) — distinct from a code failure
 */
export type SemanticTone =
  | "success"
  | "failure"
  | "active"
  | "attention"
  | "blocked"
  | "neutral"
  | "infra";

export const TONE_META: Record<SemanticTone, ColorMeta> = {
  success: { label: "Success", fg: "var(--green-600)", bg: "var(--green-50)", dot: "var(--green-500)" },
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
  | "review"
  | "zombie"
  | "swept";

/** The single mapping from the fixed StatusKey vocabulary onto a semantic tone.
 *  Everything that colors a StatusKey (issue + session chips) flows through here
 *  via `STATUS_META`, so the tone is the only place color is decided. */
export const STATUS_KEY_TONE: Record<StatusKey, SemanticTone> = {
  running: "active",
  queued: "neutral",
  blocked: "blocked",
  waiting: "attention",
  passed: "success",
  failed: "failure",
  paused: "blocked",
  done: "success",
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
