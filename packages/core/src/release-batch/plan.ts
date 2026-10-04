/** The knowledge-entry slug holding this project's repo-side release ritual. */
export const RELEASE_PROCEDURE_FACT = 'release-procedure';

export const RELEASE_BATCH_SKILL = 'release-flow';

/** The REST path a release run reads and records its batch through, on the credential its pane holds. */
export const releaseBatchPath = (runId: string): string =>
  `projects/$FORGE_PROJECT_ID/release-batches/${runId}`;

import { promotedBranch, type ReleasePath } from '../project-config/release-path.js';
import type { VerifyConfig } from './verify.js';

export interface ReleaseBranches {
  /** Where work lands; `null` on a project with no git source. */
  defaultBranch: string | null;
  /** The branch production deploys from. Equals `defaultBranch` where no promotion crosses. */
  deploysFrom: string | null;
  /** True where a promotion has to be crossed before production deploys. */
  promotePlanned: boolean;
}

/** The branches the project document declares, as FACTS about the project. */
export function releaseBranches(path: ReleasePath): ReleaseBranches {
  const promoted = promotedBranch(path);
  return {
    defaultBranch: path.defaultBranch,
    deploysFrom: promoted ?? path.defaultBranch,
    promotePlanned: promoted !== null,
  };
}

export type ReleaseRollback =
  | { kind: 'manual'; text: string }
  | { kind: 'coolify-image' }
  | { kind: 'unrepresentable'; text: string };

/** Where a channel's probes came from: the production environment's `verification.runtime`.
 *  `declared-unusable` is a declared probe a release cannot compare with the commit it ships,
 *  which `none` would make indistinguishable from declaring nothing (ISS-1286). */
export type VerifySource = 'environment' | 'declared-unusable' | 'none';

/** The production environment's deploy binding: where a release lands. */
export interface ReleaseChannel {
  /** The production environment's name in the project document. */
  environment: string;
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
  /** The production environment's deploy binding, or empty where Forge reaches no production. */
  channels: ReleaseChannel[];
  /** The production binding's label, or `null`. */
  releaseRunnerLabel: string | null;
  /** The `release-procedure` knowledge entry's body, verbatim. */
  procedure: string | null;
}
