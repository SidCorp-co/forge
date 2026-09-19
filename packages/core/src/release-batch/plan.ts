/** The knowledge-entry slug holding this project's repo-side release ritual. */
export const RELEASE_PROCEDURE_FACT = 'release-procedure';

export const RELEASE_BATCH_SKILL = 'release-flow';

/** What the default procedure has to read to render: the two declared axes and the live set. */
export interface DefaultProcedureInput {
  releaseModel: ReleaseModel;
  /** Non-null exactly under `promote`; `projects_release_strategy_chk` holds that in Postgres. */
  releaseStrategy: ReleaseStrategy | null;
  /** EVERY live deploy binding, so the deploy step names the providers that are actually there. */
  channels: ReleaseChannel[];
}

export function defaultReleaseProcedure(input: DefaultProcedureInput): string {
  const refusal = procedureRefusal(input);
  if (refusal !== null) return refusal;
  const steps: string[] = [];
  if (input.releaseModel === 'promote') steps.push(promoteStep(input.releaseStrategy));
  steps.push(deployStep(input.channels));
  steps.push(CHANGELOG_STEP);
  return steps.map((step, i) => `${i + 1}. ${step}`).join('\n');
}

function procedureRefusal(input: DefaultProcedureInput): string | null {
  if (input.releaseModel === 'promote' && input.releaseStrategy !== 'merge-branch') {
    return promoteStep(input.releaseStrategy);
  }
  const foreign = undeployableChannels(input.channels);
  if (foreign.length > 0) return foreignChannelRefusal(foreign);
  return null;
}

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

export function releaseBranches(project: ProjectLike, releaseModel: ReleaseModel): ReleaseBranches {
  const resolved = resolveIssueBranches({}, project);
  if (!resolved.baseBranch) throw new ReleaseBranchesUndeclaredError();
  const promotePlanned = releaseModel === 'promote' && resolved.liveBranch !== null;
  return {
    baseBranch: resolved.baseBranch,
    liveBranch: promotePlanned ? (resolved.liveBranch as string) : resolved.baseBranch,
    promotePlanned,
  };
}

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
