// Improvement-message registry — the versioned, git-committed catalogue of
// improvement ideas the platform suggests to project owners.
//
// Design mirrors `prompt/facts/registry.ts`:
//   - Pure module: imports TYPES ONLY from the DB schema (never side-effects).
//   - No DB seeding required — the registry is read directly from this module.
//   - Content is intentionally minimal in this issue (ISS-546); ISS-548 (child
//     3/5) adds the 3 canonical seed messages.
//
// Two surfaces consume this module:
//   1. `GET /api/improvement-messages` — returns the catalogue, optionally
//      annotated with per-project enablement from `schedules.template_key`.
//   2. `/api/schedules` POST/PUT — validates `templateKey` against this
//      registry before persisting.

import type { ScheduleMode } from '../../db/schema.js';

export type ImprovementMessageCategory =
  | 'code-quality'
  | 'testing'
  | 'documentation'
  | 'performance'
  | 'security'
  | 'dx'
  | 'ops'
  | 'general';

export interface ImprovementMessage {
  /** Stable, kebab-case key used as `schedules.template_key`. */
  key: string;
  title: string;
  /** The schedule prompt injected when this message is enabled. */
  message: string;
  /** Why this improvement matters — shown in the UI. */
  rationale: string;
  /** Skill keys this message is most useful for (optional filter hint). */
  appliesToSkills?: readonly string[];
  /**
   * Human/agent-readable condition evaluated by the engine at run time.
   * The engine (child 4/5) decides whether to fire the message based on this.
   */
  appliesWhen?: string;
  category: ImprovementMessageCategory;
  /** Increment on any content change; enables stale-detection downstream. */
  version: number;
  /** Whether the Forge maintainer recommends enabling this by default. */
  recommended: boolean;
  /** Default mode when the owner enables this message without specifying one. */
  defaultMode: ScheduleMode;
}

// ── Registry ─────────────────────────────────────────────────────────────────
// ISS-548 (child 3/5) fills in the 3 canonical seed messages.
// Keep this array until then so the module compiles and tests pass.

export const improvementMessages: ImprovementMessage[] = [];

// ── Lookups ───────────────────────────────────────────────────────────────────

const MESSAGE_BY_KEY = new Map<string, ImprovementMessage>(
  improvementMessages.map((m) => [m.key, m]),
);

export function getImprovementMessage(key: string): ImprovementMessage | undefined {
  return MESSAGE_BY_KEY.get(key);
}

export function listImprovementMessages(): ImprovementMessage[] {
  return improvementMessages;
}
