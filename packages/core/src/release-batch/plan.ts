// The shape of a release, with nothing attached that can touch the database.
//
// `channel.ts` reaches Postgres to answer these questions; the prompt builder
// only needs the answers' shape and the fallback text, and importing the
// resolver for that dragged the db client — and therefore the whole env
// contract — into a pure string test.

/** The `projectFacts` key holding this project's repo-side release ritual. */
export const RELEASE_PROCEDURE_FACT = 'release-procedure';

/**
 * The method a release run is expected to be working from.
 *
 * ONE constant, because `skillName` on the job and the invocation line in the
 * prompt are the same claim about the same run. It stamped `release-flow` and
 * the prompt said nothing about it, so the column selected nothing while
 * reading like a designation, and `finish` had no way to ask whether the run
 * had a method at all (ISS-1042).
 */
// cm:guard CROSS-REPO coupling, so no `cm:edge` can hold it: the skill itself is `plugin/skills/release-flow` in github.com/SidCorp-co/forge-plugin (ISS-1521). Renaming it here reaches an agent only when the plugin says the same word.
export const RELEASE_BATCH_SKILL = 'release-flow';

/**
 * What a project gets when it has not written its own procedure: the steps
 * that were hardcoded into the state prompt before this split.
 */
// cm:guard this text is a MIGRATION FLOOR, not a recommendation, and the floor is still load-bearing on a RECOUNT rather than on the number that used to be here. Its old premise — "Measured 2026-08-24: 17 projects have a release gate and NONE has declared a procedure" — was false in both halves by 2026-09-16: the gate answered FIVE projects (anhome, pixelight, portal-lighthuman, sid-desk, sidpeak) and TWO of them declared a `release-procedure` fact (pixelight, sidpeak). Under ISS-1046's declared model the gate answers SEVEN and five of those declare none, so making "no procedure" mean "refuse" would still break five live releases the day it shipped. Delete it only once every gated project declares its own.
// cm:guard step 1 is rendered ONLY under `releaseModel: 'promote'`. It used to be hardcoded for everyone as `liveBranch ≠ baseBranch`, which is `gate.ts`'s old branch comparison rewritten as prose for an agent — a `publish` project merges nothing (pixelight publishes a theme) and a `none` project has no release step at all, so the unconditional step told 28 of 32 projects to promote a branch nobody was promoting.
export function defaultReleaseProcedure(releaseModel: ReleaseModel): string {
  const promote =
    releaseModel === 'promote'
      ? `1. Merge baseBranch → liveBranch and push.
   A conflict is an abort, not something to resolve here.
`
      : '';
  const n = (k: number) => (releaseModel === 'promote' ? k : k - 1);
  return `${promote}${n(2)}. If a deploy channel is declared above: \`forge_coolify_deploy { action:'deploy', pipelineRunId: runId }\`.
   Poll \`forge_coolify_deploy { action:'status' }\` in the FOREGROUND until every target is
   'ok' or 'failed' — never end the turn while polling. pendingHumanConfirm:true → abort.
   Any 'failed' → abort.
${n(3)}. Append ONE line under \`## [Unreleased]\` in CHANGELOG.md on the branch the release lands on — one
   sentence for the whole batch, synthesised from the issues' \`releaseNotes.userFacing\`
   (issues with section='Skip' contribute nothing).
   Idempotency: check \`git log --grep="batch release <runId first 8>" --oneline -1\` first;
   non-empty → skip the append.
   Commit message: \`docs(changelog): batch release <runId first 8> (<n> issues)\`.`;
}

import { type ProjectLike, resolveIssueBranches } from '../branches/resolve.js';
import type { ReleaseModel, ReleaseStrategy } from '../db/schema.js';
import type { VerifyConfig } from './verify.js';

/** The project has no `baseBranch`, so there is nothing a release could promote from. */
export class ReleaseBranchesUndeclaredError extends Error {
  constructor() {
    super('RELEASE_BRANCHES_UNDECLARED');
    this.name = 'ReleaseBranchesUndeclaredError';
  }
}

export interface ReleaseBranches {
  baseBranch: string;
  /** Where a `promote` release lands. Equals `baseBranch` under every other model. */
  liveBranch: string;
  /** True only under `releaseModel: 'promote'` with a live branch of its own. */
  promotePlanned: boolean;
}

// cm:guard the branches come from the `projects` columns through the same resolver every other surface uses, and an undeclared base is an ERROR, never `'main'`. The loader this replaced read `agentConfig.branchConfig` — a key nothing writes — and defaulted both sides to `main`; on 2026-09-03 sidpeak (staging → master) cut three release batches whose envelope said `main → main`, and every one aborted on a branch origin does not have.
export function releaseBranches(project: ProjectLike, releaseModel: ReleaseModel): ReleaseBranches {
  const resolved = resolveIssueBranches({}, project);
  if (!resolved.baseBranch) throw new ReleaseBranchesUndeclaredError();
  // cm:guard `releaseModel` and NOT a branch comparison decides whether a promotion is planned. 25 of
  // 32 fleet projects still carry a `live_branch` from the era when the column had a `'main'` default
  // — six of them a branch genuinely distinct from their base — so `liveBranch !== baseBranch` answers
  // "this project promotes" for six projects that promote nothing (ISS-1046).
  const promotePlanned = releaseModel === 'promote' && resolved.liveBranch !== null;
  return {
    baseBranch: resolved.baseBranch,
    liveBranch: promotePlanned ? (resolved.liveBranch as string) : resolved.baseBranch,
    promotePlanned,
  };
}

/**
 * What this project's channel can do when a deploy comes up dead.
 *
 * `manual` is operator prose for a channel whose API cannot express a
 * rollback. `coolify-image` is the action Forge performs itself.
 * `unrepresentable` is a Coolify binding still carrying prose from before
 * ISS-925: the text is carried so it can be shown, and it is NOT executed.
 */
export type ReleaseRollback =
  | { kind: 'manual'; text: string }
  | { kind: 'coolify-image' }
  | { kind: 'unrepresentable'; text: string };

/** ONE live deploy binding. A project's release works the whole set of these. */
export interface ReleaseChannel {
  bindingId: string;
  provider: string;
  /** ISS-558 multi-store slug; `''` for the default binding. NOT the runner label. */
  label: string;
  /** Verbatim operator text for the channel. Never contains a credential. */
  instructions: string | null;
  /** Matched against `runners.labels` to pick the boxes allowed to release. */
  releaseRunnerLabel: string | null;
  /** How the kernel proves the deploy landed. `null` → nothing is proven. */
  verify: VerifyConfig | null;
  /** How this project gets back, or `null` when it declares no way. */
  rollback: ReleaseRollback | null;
}

export interface ReleasePlan {
  /** EVERY live deploy binding. Empty means: cut the version and stop, a human deploys. */
  channels: ReleaseChannel[];
  /** The one label across the set, or `null`. Two disagreeing labels throw instead. */
  releaseRunnerLabel: string | null;
  /** `projectFacts.release-procedure`, verbatim. */
  procedure: string | null;
}

export type { ReleaseModel, ReleaseStrategy };
