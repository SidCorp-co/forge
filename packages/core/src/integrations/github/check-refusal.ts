import type { GitHubPublishError, GitHubPublishOp } from './client.js';
import {
  describePublishRefusal,
  describePublishThrown,
  type PublishRefusal,
  type PublishSubject,
  type RefusalCause,
} from './publish-refusal.js';

export type { RefusalCause };
/** Kept as a name because `contract-check.ts` and its tests are written against it. */
export type CheckRefusal = PublishRefusal;

const WHERE: Record<GitHubPublishOp, string> = {
  mint: 'minting the installation token',
  lookup: 'looking up the existing check run',
  create: 'creating the check run',
  update: 'updating the check run',
  merge: 'merging the pull request',
};

export const CHECK_PUBLISH_SUBJECT: PublishSubject = {
  where: WHERE,
  permission:
    'the App has no `checks: write` permission. Set Checks to "Read and write" on the App, then ' +
    'approve the resulting request on the installation — reconnecting will not change this, ' +
    'because the credential is not what is wrong.',
  ambiguous:
    'the App may lack `checks: write`, or this may be a secondary rate limit. Forge is not ' +
    "guessing between them. Check the App's Checks permission first; if it is already " +
    '"Read and write", retry after a pause.',
  nothingWritten: 'so no check run was written and none was changed. Retrying is safe.',
  unprocessable: 'The commonest cause is a head SHA this repository does not hold.',
};

export function describeRefusal(err: GitHubPublishError): CheckRefusal {
  return describePublishRefusal(err, CHECK_PUBLISH_SUBJECT);
}

/** The same description for anything thrown on the publish path, refusal or not. */
export function describeThrown(err: unknown, op: GitHubPublishOp): CheckRefusal {
  return describePublishThrown(err, op, CHECK_PUBLISH_SUBJECT);
}
