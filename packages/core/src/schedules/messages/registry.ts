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
  standing?: boolean;
}

export const RETIRED_STRATEGY_INPUTS = {
  MERGED_AT_ON_PASS: {
    key: 'merged-at-on-pass',
    title: 'Stamp merged_at on PASS to unblock dependencies',
    message:
      'When forge-test reaches an overall PASS verdict, call ' +
      'forge_issues.mark_merged({ issueId, target: "base" }) immediately ' +
      'after updating the status. This stamps merged_at on the issue so any ' +
      'downstream issues connected by blocks edges are ' +
      'automatically dispatched. Without this stamp, dependent issues queue ' +
      'indefinitely even though their blocker has merged — the pipeline ' +
      'cannot detect the merge from status alone.',
    appliesWhen:
      'The project uses blocks issue relations AND the base-merge ' +
      'state is a manual gate (a pipeline status the system does not ' +
      'auto-advance, such as "awaiting_release" or "tested"), meaning merged_at is ' +
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
      'git rebase origin/<liveBranch> — this resolves straightforward ' +
      'divergence when the branch was cut before recent release merges. ' +
      '(3) If rebase succeeds without conflict, push the rebased ISS-* ' +
      'branch then retry the base-branch merge. ' +
      '(4) If rebase itself conflicts or the retry merge conflicts, ' +
      'transition awaiting_release → reopen and post the standard conflict comment ' +
      'so forge-fix can resolve it. Never leave the issue at awaiting_release after ' +
      'a conflict — silent waiting blocks the release indefinitely.',
    appliesWhen:
      "The project declares releaseModel='promote' in its project config, meaning the release " +
      'moves code from baseBranch to liveBranch and ISS-* branches must track liveBranch to ' +
      'avoid divergence at merge time. It does NOT apply under releaseModel `publish` (the ' +
      'release is an act on a live binding and no ref moves) or `none` (there is no release step), ' +
      'whatever branches those projects happen to have stored.',
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

export const improvementMessages: ImprovementMessage[] = [
  {
    key: 'optimize-skills',
    title: 'Standing skill steward — continuous per-project optimization',
    message:
      'The skill steward observes accumulated quality signals across pipeline runs ' +
      '(reopen rates, step durations, forge_feedback reports, domain weaknesses) ' +
      'and uses a per-skill memory namespace to propose or apply targeted improvements ' +
      "to this project's skills. Each run absorbs the forge-skill-audit rubric and " +
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
  {
    key: 'product-map-refresh',
    title: 'Standing product-map refresh — keep user-journey & module diagrams current',
    message:
      "The product-map refresh agent reads the project's curated product knowledge " +
      '(overview mindmap, scenario flowcharts, workflow state-diagrams, per-module ' +
      'overviews) and the issues shipped since each entry was last updated, then ' +
      'upserts the entries that changed and adds scenarios for newly-shipped user ' +
      'journeys. All nodes stay user-facing (issue id / acceptance-criterion / route) ' +
      'under the same verification gate forge-product-map uses — never source-code ' +
      'identifiers. It refreshes the map in place; it does not file issues.',
    rationale:
      'A product map bootstrapped once rots as features ship — diagrams that no longer ' +
      'match the product mislead both humans and agents. A standing refresh keeps the ' +
      'overview / scenarios / workflows / module nodes current from the issue stream, ' +
      'so the map stays a living account of the product rather than a stale snapshot. ' +
      'The mindmap / context / user-flow / swimlane views are generated from the module ' +
      "taxonomy since ISS-950 and are not this agent's to draw. " +
      'Pairs with knowledge-drift-check (which only ' +
      'flags drift): this one closes the loop by actually refreshing.',
    appliesWhen:
      'The project maintains a product map — curated knowledge_entries of kind ' +
      'overview/scenario/workflow authored by forge-product-map (or equivalent). ' +
      'If no such entries exist yet, the agent bootstraps the core set on first run.',
    category: 'documentation',
    version: 1,
    recommended: true,
    defaultMode: 'auto',
    standing: true,
  },
  {
    key: 'feedback-triage-digest',
    title: 'Standing fleet feedback digest — weekly unreviewed-feedback rollup',
    message:
      'The feedback-digest agent pulls unreviewed forge_feedback reports fleet-wide ' +
      '(scope="all", reviewed=false), dedupes by signalKey, groups by target then ' +
      'severity, and files ONE draft issue into forge-dev per run summarizing the ' +
      'backlog (top clusters, counts per project, capped). It never reviews or ' +
      'edits feedback reports itself — a human triages the underlying reports.',
    rationale:
      'Without a standing digest, triage of forge_feedback reports depends on a ' +
      'human hand-scanning every project — which happens rarely and lets friction ' +
      'signals pile up unseen. A weekly fleet-wide rollup surfaces the backlog ' +
      'continuously and routes it through the same draft-issue review gate as ' +
      'the skill steward and knowledge-drift-check, keeping a human in the loop.',
    category: 'ops',
    version: 1,
    recommended: true,
    defaultMode: 'propose',
    standing: true,
  },
];

const MESSAGE_BY_KEY = new Map<string, ImprovementMessage>(
  improvementMessages.map((m) => [m.key, m]),
);

export function getImprovementMessage(key: string): ImprovementMessage | undefined {
  return MESSAGE_BY_KEY.get(key);
}

export function listImprovementMessages(): ImprovementMessage[] {
  return improvementMessages;
}
