/** The knowledge-entry slug holding this project's repo-side release ritual. */
export const RELEASE_PROCEDURE_FACT = 'release-procedure';

export const RELEASE_BATCH_SKILL = 'release-flow';

/** The MCP tool a release run reads and records its batch through, on the credential its pane holds. */
export const RELEASE_BATCH_TOOL = 'forge_release_batch';

import { resolveIssueBranches } from '../branches/resolve.js';
import type { ReleaseCrossing } from '../db/schema.js';
import { chainLiveBranch, type ReleaseChain } from '../projects/release-chain.js';
import type { VerifyConfig } from './verify.js';

export interface ReleaseBranches {
  /** `null` where the project declares none. A release reads its branches from its own method. */
  baseBranch: string | null;
  /** Where the last edge of the chain lands. Equals `baseBranch` where the chain crosses nothing. */
  liveBranch: string | null;
  /** True where the chain has an edge to cross before it deploys. */
  promotePlanned: boolean;
}

/**
 * The branches this project declares, as FACTS about the project.
 *
 * ISS-1276 — no branch here is an argument to a step Forge writes, because Forge writes none. An
 * undeclared base branch was `RELEASE_BRANCHES_UNDECLARED` until then, which refused a release on
 * behalf of a merge step that no longer exists; `resolveReleaseDeclaration` read the same column and
 * defaulted it to `main`, so the two readings disagreed about the same project.
 */
export function releaseBranches(project: {
  baseBranch: string | null;
  releaseChain: ReleaseChain;
}): ReleaseBranches {
  const resolved = resolveIssueBranches(
    {},
    { ...project, liveBranch: chainLiveBranch(project.releaseChain) },
  );
  const promotePlanned = resolved.liveBranch !== null;
  return {
    baseBranch: resolved.baseBranch,
    liveBranch: promotePlanned ? resolved.liveBranch : resolved.baseBranch,
    promotePlanned,
  };
}

export type ReleaseRollback =
  | { kind: 'manual'; text: string }
  | { kind: 'coolify-image' }
  | { kind: 'unrepresentable'; text: string };

/** Where a channel's probes came from. `declared-unusable` is a `verify` block
 *  `parseVerifyConfig` refused, which `none` would make indistinguishable from
 *  declaring nothing — and the two need different repairs (ISS-1286). */
export type VerifySource = 'binding' | 'environments-live' | 'declared-unusable' | 'none';

/** ONE live deploy binding. A project's release works the whole set of these. */
export interface ReleaseChannel {
  bindingId: string;
  provider: string;
  /** ISS-558 multi-store slug; `''` for the default binding. NOT the runner label. */
  label: string;
  /** Verbatim operator text for the channel. Never contains a credential. */
  instructions: string | null;
  /** Matched against `runners.labels` to rank the boxes; it does not filter them. */
  releaseRunnerLabel: string | null;
  /** How the kernel proves the deploy landed. `null` → nothing is proven. */
  verify: VerifyConfig | null;
  verifySource: VerifySource;
  /** How this project gets back, or `null` when it declares no way. */
  rollback: ReleaseRollback | null;
}

/** How a release is proved: by one live channel's probes, or — where no live channel declares
 *  any — not at all, which every door records by that name rather than refusing (ISS-1321). */
export type CloseVerification = { kind: 'probed'; cfg: VerifyConfig } | { kind: 'unverified' };

/** What a release stamps on its run, its finish and its answers: the kind, by itself. */
export type ReleaseVerification = CloseVerification['kind'];

export interface ReleasePlan {
  /** EVERY live deploy binding. Empty means Forge reaches no deploy this project declared. */
  channels: ReleaseChannel[];
  /** The one label across the set, or `null`. Two disagreeing labels throw instead. */
  releaseRunnerLabel: string | null;
  /** The `release-procedure` knowledge entry's body, verbatim. */
  procedure: string | null;
}

export type { ReleaseCrossing };
