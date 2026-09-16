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

/** What the default procedure has to read to render: the two declared axes and the live set. */
export interface DefaultProcedureInput {
  releaseModel: ReleaseModel;
  /** Non-null exactly under `promote`; `projects_release_strategy_chk` holds that in Postgres. */
  releaseStrategy: ReleaseStrategy | null;
  /** EVERY live deploy binding, so the deploy step names the providers that are actually there. */
  channels: ReleaseChannel[];
}

/**
 * What a project gets when it has not written its own procedure: the steps
 * that were hardcoded into the state prompt before this split.
 *
 * It reads the DECLARATION — the release model, the release strategy, and the live channel set —
 * and refuses by name wherever Forge has no default for what was declared. It renders a step only
 * where the step is the one the declaration asks for.
 */
// cm:guard this text is a MIGRATION FLOOR, not a recommendation, and the floor is still load-bearing on a RECOUNT rather than on the number that used to be here. Its old premise — "Measured 2026-08-24: 17 projects have a release gate and NONE has declared a procedure" — was false in both halves by 2026-09-16: the gate answered FIVE projects (anhome, pixelight, portal-lighthuman, sid-desk, sidpeak) and TWO of them declared a `release-procedure` fact (pixelight, sidpeak). Under ISS-1046's declared model the gate answers SEVEN and five of those declare none, so making "no procedure" mean "refuse" would still break five live releases the day it shipped. Delete it only once every gated project declares its own.
// cm:guard step 1 is rendered ONLY under `releaseModel: 'promote'`. It used to be hardcoded for everyone as `liveBranch ≠ baseBranch`, which is `gate.ts`'s old branch comparison rewritten as prose for an agent — a `publish` project merges nothing (pixelight publishes a theme) and a `none` project has no release step at all, so the unconditional step told 28 of 32 projects to promote a branch nobody was promoting.
// cm:guard the steps are NUMBERED from the list rather than by an index shifted per model. The `n(k)` arithmetic this replaced encoded "there are exactly three steps and one of them is conditional", which is false the moment a fourth branch exists — and an agent handed "2. deploy" with no step 1 goes looking for the step it was not given.
export function defaultReleaseProcedure(input: DefaultProcedureInput): string {
  const steps: string[] = [];
  if (input.releaseModel === 'promote') steps.push(promoteStep(input.releaseStrategy));
  steps.push(deployStep(input.channels));
  steps.push(CHANGELOG_STEP);
  return steps.map((step, i) => `${i + 1}. ${step}`).join('\n');
}

/**
 * How a `promote` release moves the code — by the declared strategy, or a refusal.
 *
 * `merge-branch` is the only one Forge can write a default for. A `cherry-pick` release needs the
 * commits to pick and a `tag-mr` release needs the tag and the target, and neither is derivable
 * from anything this prompt carries — so rendering the merge for them would substitute a whole
 * different release for the one the project declared, which is the defect ISS-1046 exists to
 * remove, reappearing as prose one layer above the column.
 */
// cm:guard NEVER fall back to the merge text. `releaseStrategy` is one of this issue's three declared axes; a default that ignores it is the `default('prod')` filler the schema change deleted, rewritten as an instruction to an agent that will act on it.
function promoteStep(strategy: ReleaseStrategy | null): string {
  if (strategy === 'merge-branch') {
    return `Merge baseBranch → liveBranch and push.
   A conflict is an abort, not something to resolve here.`;
  }
  const declared = strategy === null ? 'no releaseStrategy at all' : `releaseStrategy: ${strategy}`;
  return `STOP — this project declares \`${declared}\`, and Forge has no default procedure for it.
   Do NOT merge baseBranch → liveBranch. That is the \`merge-branch\` procedure, and it is not what
   this project declared; running it would promote the whole branch where a selected set of commits
   or a tagged request was asked for.
   \`abort\` naming this, and tell the operator the steps belong in the \`${RELEASE_PROCEDURE_FACT}\`
   project fact — that text replaces this entire default when it exists.`;
}

/**
 * The deploy step, per live channel, naming the provider each instruction is for.
 *
 * The one it replaced ended `If a deploy channel is declared above: forge_coolify_deploy { … }` for
 * every project. An epodsystem-only `publish` project — butlocs, mowment, pixelight, anhome — was
 * therefore told to release through Coolify, a tool that does not reach its storefront at all.
 */
// cm:guard the Coolify call is emitted ONLY for a channel whose provider IS `coolify`, and a provider Forge has no default for gets a refusal rather than the nearest tool. `gate.ts` already forbids reading a provider name to decide what a binding is FOR; this is the same rule for what a step DOES, and the old text broke it for four fleet projects.
function deployStep(channels: ReleaseChannel[]): string {
  if (channels.length === 0) {
    return `No deploy channel is declared, so there is nothing here for you to deploy. Cut the version
   and stop — a human takes it from there. Do NOT reach for a deploy tool you have seen in another
   prompt; this project has not declared one.`;
  }
  const coolify = channels.filter((c) => c.provider === 'coolify').map(namedChannel);
  const foreign = [...new Set(channels.filter((c) => c.provider !== 'coolify').map(namedChannel))];
  const parts: string[] = [];
  if (coolify.length > 0) {
    const named = coolify.join(', ');
    parts.push(`Deploy the coolify channel(s) — ${named} — with \`forge_coolify_deploy { action:'deploy', pipelineRunId: runId }\`.
   Poll \`forge_coolify_deploy { action:'status' }\` in the FOREGROUND until every target is
   'ok' or 'failed' — never end the turn while polling. pendingHumanConfirm:true → abort.
   Any 'failed' → abort.`);
  }
  if (foreign.length > 0) {
    const named = foreign.join(', ');
    const those = foreign.length > 1 ? 'those channels' : 'that channel';
    parts.push(`Forge has NO default deploy step for ${named}, and \`forge_coolify_deploy\` does not
   reach ${those}. \`abort\` naming the channel rather than deploying it some other way, and tell the
   operator the steps belong in the \`${RELEASE_PROCEDURE_FACT}\` project fact.`);
  }
  return parts.join('\n   ');
}

/** `provider` on its own, or `provider [label]` for an ISS-558 multi-store binding. */
function namedChannel(channel: ReleaseChannel): string {
  return channel.label ? `${channel.provider} [${channel.label}]` : channel.provider;
}

const CHANGELOG_STEP = `Append ONE line under \`## [Unreleased]\` in CHANGELOG.md on the branch the release lands on — one
   sentence for the whole batch, synthesised from the issues' \`releaseNotes.userFacing\`
   (issues with section='Skip' contribute nothing).
   Idempotency: check \`git log --grep="batch release <runId first 8>" --oneline -1\` first;
   non-empty → skip the append.
   Commit message: \`docs(changelog): batch release <runId first 8> (<n> issues)\`.`;

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
