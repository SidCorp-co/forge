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
//
// ── standing templates ───────────────────────────────────────────────────────
// When `standing === true`, the dispatch engine BYPASSES the
// `appliedMessageVersions` idempotency gate — every cadence run fires
// regardless of prior executions. Use for templates whose value comes from
// observing fresh signals on every run (e.g. the skill steward). One-shot
// templates (standing omitted / false) still skip after their version is
// applied.

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
  | 'steward'
  | 'general';

export interface ImprovementMessage {
  /** Stable, kebab-case key used as `schedules.template_key`. */
  key: string;
  title: string;
  /** The schedule prompt injected when this message is enabled (one-shot templates).
   *  For standing templates this is human-facing catalog copy only; the real
   *  prompt is built by the dedicated prompt builder in skill-steward-prompt.ts. */
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
  /**
   * When true, the dispatch engine bypasses the `appliedMessageVersions`
   * idempotency gate so the template fires on every cadence run.
   * Standing templates have continuous value (always fresh signals to process).
   * Default: false (one-shot semantics).
   */
  standing?: boolean;
}

// ── Strategy inputs (retired one-shot templates) ──────────────────────────────
// These patterns were previously separate scheduled templates. They are now
// STRATEGY_INPUTS absorbed by the standing steward — applied by the steward
// when it observes the matching signal, not run on their own schedule.
// Preserved here as reference data so the steward prompt can inline them.
export const RETIRED_STRATEGY_INPUTS = {
  MERGED_AT_ON_PASS: {
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
    appliesWhen:
      'The project uses blocks/decomposes issue relations AND the base-merge ' +
      'state is a manual gate (a pipeline status the system does not ' +
      'auto-advance, such as "released" or "tested"), meaning merged_at is ' +
      'not stamped automatically on status transition.',
    appliesToSkills: ['forge-test'],
  },
  RELEASE_CONFLICT_2TIER: {
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
    appliesWhen:
      'The project is 2-branch: baseBranch and productionBranch are ' +
      'different values in the project config (e.g. baseBranch="main" and ' +
      'productionBranch="release" or "production"), meaning ISS-* branches ' +
      'must track production to avoid divergence at merge time.',
    appliesToSkills: ['forge-release'],
  },
  QA_QUALITY_BAR: {
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
    appliesWhen:
      'The project has a frontend or UI surface — web app, mobile app, or ' +
      'any browser-rendered interface that end users interact with directly.',
    appliesToSkills: ['forge-test'],
  },
} as const;

// ── Registry ─────────────────────────────────────────────────────────────────

export const improvementMessages: ImprovementMessage[] = [
  {
    key: 'optimize-skills',
    title: 'Standing skill steward — continuous per-project optimization',
    message:
      'The skill steward observes accumulated quality signals across pipeline runs ' +
      '(reopen rates, step durations, forge_feedback reports, domain weaknesses) ' +
      'and uses a per-skill memory namespace to propose or apply targeted improvements ' +
      'to this project\'s skills. Each run absorbs the forge-skill-audit rubric and ' +
      'playbook, curates per-skill memory to ≤2k tokens, and emits a structured run ' +
      'report tracking which domains improved over time.',
    rationale:
      'Skills improve continuously rather than through one-time patches. ' +
      'The steward accumulates project-specific knowledge in a dedicated memory ' +
      'namespace (2k token cap per skill), raises accept standards gradually as ' +
      'quality improves, and routes Forge-level issues to the owner via forge_feedback ' +
      'rather than silently dropping them. replaces the recurring forge-skill-audit ' +
      'daily schedule and the 3 retired one-shot templates.',
    category: 'steward',
    version: 1,
    recommended: true,
    defaultMode: 'propose',
    standing: true,
  },
  {
    key: 'knowledge-drift-check',
    title: 'Standing knowledge drift detector — weekly staleness + gap scan',
    message:
      'The knowledge drift-check agent reads curated knowledge_entries and recently ' +
      'shipped issues to identify three classes of drift: (1) stale entries whose ' +
      'relatedIssueIds are all >90 days old while newer issues touch the same ' +
      'capability, (2) scenario entries referencing removed features, and (3) ' +
      'capabilities with ≥3 shipped issues in the last 30 days but no covering ' +
      'knowledge entry. For each drift cluster it files ONE draft issue describing ' +
      'the gap — capped at 5 proposals per run. It NEVER edits knowledge_entries directly.',
    rationale:
      'Curated knowledge entries go stale as features ship and evolve. ' +
      'Without a standing detector, documentation rot is invisible until it ' +
      'misleads an agent at runtime. The drift-check surfaces staleness signals ' +
      'continuously and routes them through the human/PM review gate (draft issues) ' +
      'rather than auto-patching knowledge — keeping the human in the loop.',
    category: 'documentation',
    version: 1,
    recommended: true,
    defaultMode: 'propose',
    standing: true,
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
