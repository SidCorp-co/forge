import type { GitHubPublishError } from './client.js';
import {
  describePublishRefusal,
  describePublishThrown,
  type PublishOpSubject,
  type PublishRefusal,
  type PublishSubject,
  type RefusalCause,
} from './publish-refusal.js';

export type { RefusalCause };
/** Kept as a name because `contract-check.ts` and its tests are written against it. */
export type CheckRefusal = PublishRefusal;

/** The operations this path sends. `merge` runs on its own path, off its own subject. */
export type CheckPublishOp = 'mint' | 'lookup' | 'create' | 'update';

/** What all four of these calls need. The name is the claim: an operation that
 * publishes no check run must not be given these sentences. */
const NEEDS_CHECKS_WRITE: Omit<PublishOpSubject, 'where'> = {
  permission:
    'the App has no `checks: write` permission. Set Checks to "Read and write" on the App, then ' +
    'approve the resulting request on the installation — reconnecting will not change this, ' +
    'because the credential is not what is wrong.',
  ambiguous:
    'sent nothing saying which of the two it was: the App may lack `checks: write`, or this may ' +
    "be a secondary rate limit. Forge is not guessing between them. Check the App's Checks " +
    'permission first; if it is already "Read and write", retry after a pause.',
  nothingWritten: 'so no check run was written and none was changed. Retrying is safe.',
  unprocessable: 'The commonest cause is a head SHA this repository does not hold.',
};

export const CHECK_PUBLISH_SUBJECT: PublishSubject<CheckPublishOp> = {
  mint: { where: 'minting the installation token', ...NEEDS_CHECKS_WRITE },
  lookup: { where: 'looking up the existing check run', ...NEEDS_CHECKS_WRITE },
  create: { where: 'creating the check run', ...NEEDS_CHECKS_WRITE },
  update: { where: 'updating the check run', ...NEEDS_CHECKS_WRITE },
};

export function describeRefusal(err: GitHubPublishError): CheckRefusal {
  return describePublishRefusal(err, CHECK_PUBLISH_SUBJECT);
}

/** The same description for anything thrown on the publish path, refusal or not. */
export function describeThrown(err: unknown, op: CheckPublishOp): CheckRefusal {
  return describePublishThrown(err, op, CHECK_PUBLISH_SUBJECT);
}
