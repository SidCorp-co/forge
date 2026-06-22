// Improvement-message registry — the versioned, git-committed catalogue of
// improvement ideas the platform suggests to project owners.
//
// Design mirrors `prompt/facts/registry.ts`:
//   - Pure module: imports TYPES ONLY from the DB schema (never side-effects).
//   - No DB seeding required — the registry is read directly from this module.
//
// Two surfaces consume this module:
//   1. `GET /api/improvement-messages` — returns the catalogue, optionally
//      annotated with per-project enablement from `schedules.template_key`.
//   2. `/api/schedules` POST/PUT — validates `templateKey` against this
//      registry before persisting.
//
// ── appliesWhen contract ─────────────────────────────────────────────────────
// `appliesWhen` is a NATURAL-LANGUAGE condition string, NOT a TS predicate.
// The skill-improve agent (child 4/5) loads the project's config
// (mergeStates, baseBranch, productionBranch, stack, roles) plus codebase
// context and JUDGES whether the condition holds, recording its reasoning in
// the run report. This design is intentional: conditions like "project has a
// FE/UI surface" or "base-merge state is a manual gate" require judgment over
// config + code that a cheap deterministic function cannot reliably cover.
// A future iteration MAY add an optional structured predicate for trivially-
// checkable conditions, but structured predicates are out of v1 scope.

import type { ScheduleMode } from '../../db/schema.js';

export type ImprovementMessageCategory =
  | 'code-quality'
  | 'testing'
  | 'documentation'
  | 'performance'
  | 'security'
  | 'dx'
  | 'ops'
  | 'pipeline-correctness'
  | 'quality'
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

export const improvementMessages: ImprovementMessage[] = [
  {
    key: 'merged-at-on-pass',
    title: 'Stamp merged_at on PASS to unblock dependencies',
    message:
      'When forge-test reaches an overall PASS verdict, call ' +
      'forge_issues.mark_merged({ issueId, target: "base" }) immediately ' +
      'after updating the status. This stamps merged_at on the issue so any ' +
      'downstream issues connected by blocks or decomposes edges are ' +
      'automatically dispatched. Without this stamp, dependent issues queue ' +
      'indefinitely even though their blocker has merged — the pipeline ' +
      'cannot detect the merge from status alone.',
    rationale:
      'Blocks/decomposes dependencies dispatch as soon as the blocker has ' +
      'merged_at set. When the base-merge state is a manual gate (e.g. ' +
      'released or tested), the system does not auto-stamp merged_at — ' +
      'leaving forge-test responsible for stamping on PASS. Missing this ' +
      'stamp silently stalls the entire downstream chain.',
    appliesToSkills: ['forge-test'],
    appliesWhen:
      'The project uses blocks/decomposes issue relations AND the base-merge ' +
      'state is a manual gate (a pipeline status the system does not ' +
      'auto-advance, such as "released" or "tested"), meaning merged_at is ' +
      'not stamped automatically on status transition.',
    category: 'pipeline-correctness',
    version: 1,
    recommended: true,
    defaultMode: 'propose',
  },
  {
    key: 'release-conflict-2tier',
    title: 'Two-tier conflict recovery on forge-release',
    message:
      'When forge-release encounters a merge conflict on the base branch: ' +
      '(1) git merge --abort to restore a clean base-branch worktree. ' +
      '(2) Check out the ISS-* branch and attempt ' +
      'git rebase origin/<productionBranch> — this resolves straightforward ' +
      'divergence when the branch was cut before recent production merges. ' +
      '(3) If rebase succeeds without conflict, push the rebased ISS-* ' +
      'branch then retry the base-branch merge. ' +
      '(4) If rebase itself conflicts or the retry merge conflicts, ' +
      'transition released → reopen and post the standard conflict comment ' +
      'so forge-fix can resolve it. Never leave the issue at released after ' +
      'a conflict — silent waiting blocks the release indefinitely.',
    rationale:
      'On 2-branch projects (baseBranch ≠ productionBranch), the ISS-* ' +
      'branch can diverge from production between the time it is cut and ' +
      'when forge-release runs. A simple merge --abort → reopen loses the ' +
      'opportunity to auto-resolve via rebase, unnecessarily pulling a human ' +
      'into a trivially-fixable conflict. The 2-tier approach (rebase attempt ' +
      'first, reopen only on true conflict) keeps the release path automated.',
    appliesToSkills: ['forge-release'],
    appliesWhen:
      'The project is 2-branch: baseBranch and productionBranch are ' +
      'different values in the project config (e.g. baseBranch="main" and ' +
      'productionBranch="release" or "production"), meaning ISS-* branches ' +
      'must track production to avoid divergence at merge time.',
    category: 'pipeline-correctness',
    version: 1,
    recommended: true,
    defaultMode: 'propose',
  },
  {
    key: 'qa-quality-bar',
    title: 'Pass-B quality checks for UI surfaces',
    message:
      'After verifying acceptance criteria (Pass-A), run Pass-B quality ' +
      'checks on every UI surface touched by the change: ' +
      '(1) Empty state — visit the feature with no data and confirm a ' +
      'graceful empty/zero-state renders instead of a blank page or broken ' +
      'layout. ' +
      '(2) Loading state — observe a slow-network condition or artificial ' +
      'delay and confirm a skeleton or spinner appears without layout shift. ' +
      '(3) Error state — trigger an API failure (e.g. invalid ID or ' +
      'disconnected network) and confirm a user-visible error message appears. ' +
      '(4) Responsive — resize to 390×844 (mobile) and 768×1024 (tablet) ' +
      'and confirm the layout holds at both breakpoints. ' +
      '(5) Accessibility — run browser_snapshot and verify interactive ' +
      'elements have accessible labels and keyboard tab order is logical. ' +
      'Report each check as a separate row tagged "Quality"; any FAIL blocks ' +
      'the overall PASS verdict.',
    rationale:
      'Acceptance criteria typically describe the happy-path feature behavior ' +
      'but omit edge states (empty, loading, error) and cross-cutting quality ' +
      'attributes (responsive, a11y). These gaps are the most common source ' +
      'of production regressions that pass QA. Pass-B closes them ' +
      'systematically on every UI issue without requiring explicit AC entries.',
    appliesToSkills: ['forge-test'],
    appliesWhen:
      'The project has a frontend or UI surface — web app, mobile app, or ' +
      'any browser-rendered interface that end users interact with directly.',
    category: 'quality',
    version: 1,
    recommended: true,
    defaultMode: 'propose',
  },
];

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
