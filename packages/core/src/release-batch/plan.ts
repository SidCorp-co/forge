// The shape of a release, with nothing attached that can touch the database.
//
// `channel.ts` reaches Postgres to answer these questions; the prompt builder
// only needs the answers' shape and the fallback text, and importing the
// resolver for that dragged the db client — and therefore the whole env
// contract — into a pure string test.

/** The knowledge-entry slug holding this project's repo-side release ritual. */
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
  const refusal = procedureRefusal(input);
  if (refusal !== null) return refusal;
  const steps: string[] = [];
  if (input.releaseModel === 'promote') steps.push(promoteStep(input.releaseStrategy));
  steps.push(deployStep(input.channels));
  steps.push(CHANGELOG_STEP);
  return steps.map((step, i) => `${i + 1}. ${step}`).join('\n');
}

/**
 * The whole procedure, where what was declared has no default at all.
 *
 * Both refusals used to render as a numbered STEP among the executable ones, and the deploy one
 * rendered SECOND — so a `promote`/`merge-branch` project on an epodsystem channel was handed
 * "1. Merge baseBranch → liveBranch and push." and then, underneath it, "Forge has NO default
 * deploy step for epodsystem … abort". An agent that reads top to bottom promotes the branch and
 * then discovers the release cannot be finished: the configuration was unreleasable before the run
 * started, and the first thing it did was move the live branch.
 */
// cm:guard a refusal is the WHOLE body or it is not a refusal. Emitting it beside steps that change
// something is the silent-substitution defect wearing a warning label — the branch still moves, and
// the abort arrives after the only irreversible instruction in the procedure. A new executable step
// added below must be reachable only past this function returning `null`.
function procedureRefusal(input: DefaultProcedureInput): string | null {
  if (input.releaseModel === 'promote' && input.releaseStrategy !== 'merge-branch') {
    return promoteStep(input.releaseStrategy);
  }
  const foreign = undeployableChannels(input.channels);
  if (foreign.length > 0) return foreignChannelRefusal(foreign);
  return null;
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
 * The deploy step, for a channel set Forge HAS a default for — reached only past `procedureRefusal`.
 *
 * The one it replaced ended `If a deploy channel is declared above: forge_coolify_deploy { … }` for
 * every project. An epodsystem-only `publish` project — butlocs, mowment, pixelight, anhome — was
 * therefore told to release through Coolify, a tool that does not reach its storefront at all.
 */
// cm:guard the Coolify call is emitted ONLY for a channel whose provider IS `coolify`. `gate.ts` already forbids reading a provider name to decide what a binding is FOR; this is the same rule for what a step DOES, and the old text broke it for four fleet projects. A provider Forge has no default for is refused by `foreignChannelRefusal` INSTEAD of this step rather than beside it, so do not reintroduce a branch here that renders both.
function deployStep(channels: ReleaseChannel[]): string {
  if (channels.length === 0) {
    return `No deploy channel is declared, so there is nothing here for you to deploy. Cut the version
   and stop — a human takes it from there. Do NOT reach for a deploy tool you have seen in another
   prompt; this project has not declared one.`;
  }
  // One step per provider that DECLARES one, in registry order. A provider declaring none is
  // refused by `foreignChannelRefusal` instead of this step, never beside it.
  const steps: string[] = [];
  for (const decl of listIntegrations()) {
    if (!decl.releaseStep) continue;
    const mine = channels.filter((c) => c.provider === decl.provider).map(namedChannel);
    if (mine.length === 0) continue;
    steps.push(decl.releaseStep(mine.join(', ')));
  }
  return steps.join('\n\n');
}

/** Every declared channel Forge has no default deploy step for, named, each one once. */
function undeployableChannels(channels: ReleaseChannel[]): string[] {
  return [
    ...new Set(channels.filter((c) => !getIntegration(c.provider)?.releaseStep).map(namedChannel)),
  ];
}

function foreignChannelRefusal(foreign: string[]): string {
  const named = foreign.join(', ');
  const those = foreign.length > 1 ? 'those channels' : 'that channel';
  return `STOP — Forge has NO default deploy step for ${named}, and \`forge_coolify_deploy\` does not
   reach ${those}. There is nothing below this line: do NOT merge, do NOT promote, and do NOT deploy
   the other channels first — a release that can only be half-finished is not started.
   \`abort\` naming the channel rather than deploying it some other way, and tell the operator the
   steps belong in the \`${RELEASE_PROCEDURE_FACT}\` project fact — that text replaces this entire
   default when it exists.`;
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
import { getIntegration, listIntegrations } from '../integrations/registry.js';
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
  /**
   * Where {@link ReleaseChannel.verify} came from, so the default is never silent.
   *
   * `binding` is the operator's own `verify` on the deploy binding. `environments-live` is the
   * probe built from `environments.live` for a binding that declares no `verify` key AT ALL — a
   * binding declaring one `parseVerifyConfig` cannot use takes no default and lands here as
   * `none`, because filling in for a broken declaration is replacing the operator's choice rather
   * than supplying its absence (ISS-1069).
   */
  verifySource: 'binding' | 'environments-live' | 'none';
  /** How this project gets back, or `null` when it declares no way. */
  rollback: ReleaseRollback | null;
}

export interface ReleasePlan {
  /** EVERY live deploy binding. Empty means: cut the version and stop, a human deploys. */
  channels: ReleaseChannel[];
  /** The one label across the set, or `null`. Two disagreeing labels throw instead. */
  releaseRunnerLabel: string | null;
  /** The `release-procedure` knowledge entry's body, verbatim. */
  procedure: string | null;
}

export type { ReleaseModel, ReleaseStrategy };
