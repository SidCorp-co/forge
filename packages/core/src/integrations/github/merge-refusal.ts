import { GitHubPublishError } from './client.js';
import {
  describePublishRefusal,
  describePublishThrown,
  type PublishRefusal,
  type PublishSubject,
} from './publish-refusal.js';

/** The same shape a check refusal carries, so one reader handles both. */
export type MergeCallRefusal = PublishRefusal;

/**
 * The operations a merge sends, and what a refusal of each one means.
 *
 * `merge.ts` sends three: the token mint every call makes, the reads of the
 * pull request and of the checks on its head, and the merge `PUT` itself. Each
 * needs its own permissions, so each carries its own sentences; the merge needs
 * no check permission at all (ISS-1151).
 */
export type MergeOp = 'mint' | 'lookup' | 'merge';

const MERGE_SUBJECT: PublishSubject<MergeOp> = {
  mint: {
    where: 'minting the installation token',
    permission:
      'the installation itself refused it: minting a token needs no repository permission, so ' +
      'coverage of any repository is not why. What is left, short of removal — which GitHub ' +
      'answers 404 for, and is handled separately — is the state of the installation itself: it ' +
      'may be suspended, or its access may have been revoked some other way. Open the ' +
      'installation on GitHub and act on what it says there — reactivate it if it is suspended, ' +
      'or reinstall it if its access was revoked.',
    ambiguous:
      'sent nothing naming a cause, so nothing here is ruled out. The readings worth trying ' +
      'first: the installation may be suspended, its access may have been revoked some other way ' +
      'short of removal, or this may be a secondary rate limit — minting needs no repository ' +
      'permission, so coverage of this repository is not among them. Read the installation on ' +
      'GitHub, then retry after a pause.',
    nothingWritten: 'so nothing was read and the merge was never sent. Retrying is safe.',
    unprocessable:
      'Nothing here names a cause beyond what GitHub sent with it. An installation ' +
      'this App no longer holds is answered 404 and handled as that, so it is not this one.',
  },
  lookup: {
    where: 'reading the pull request and the checks on its head',
    permission:
      'the App has no `pull_requests: read` permission, or no `checks: read` — that read needs ' +
      'both, and GitHub does not say which of them it refused. Set Pull requests and Checks to ' +
      'at least "Read-only" on the App, then approve the resulting request on the installation — ' +
      'reconnecting will not change this, because the credential is not what is wrong.',
    ambiguous:
      'sent nothing naming a cause, so nothing here is ruled out. The readings worth trying ' +
      'first: the App may lack `pull_requests: read` or `checks: read`, which that read needs ' +
      'both of; the installation may no longer cover this repository; or this may be a secondary ' +
      'rate limit. Check those two permissions, then that the App is still installed on this ' +
      'repository, then retry after a pause.',
    nothingWritten: 'so nothing was read and the merge was never sent. Retrying is safe.',
    unprocessable:
      'Nothing here names a cause beyond what GitHub sent with it. A pull request ' +
      'this repository does not hold is answered 404 and handled as that, so it is not this one.',
  },
  merge: {
    where: 'merging the pull request',
    permission:
      'the App has no `pull_requests: write` permission, or no `contents: write` — merging needs ' +
      'both, and GitHub does not say which of them it refused. Set Pull requests and Contents to ' +
      '"Read and write" on the App, then approve the resulting request on the installation — ' +
      'reconnecting will not change this, because the credential is not what is wrong.',
    ambiguous:
      'sent nothing naming a cause, so nothing here is ruled out. The readings worth trying ' +
      'first: the App may lack `pull_requests: write` or `contents: write`, which merging needs ' +
      'both of; a branch protection rule or a repository ruleset may refuse this App on the base ' +
      'branch; or this may be a secondary rate limit. Check those two permissions, then the base ' +
      "branch's protection rules and rulesets, then retry after a pause.",
    nothingWritten: 'so the merge was never sent. Retrying is safe.',
    unprocessable:
      'Nothing here names a cause beyond what GitHub sent with it. A merge method ' +
      'this repository has switched off is answered 405 and handled as that, so it is not ' +
      'this one.',
  },
};

function timedOut(): MergeCallRefusal {
  return {
    cause: 'timed-out-mid-write',
    op: 'merge',
    status: null,
    detail: null,
    message:
      'Forge timed out merging the pull request, so whether GitHub took the merge is unknown. ' +
      'Do not send it again: read the pull request, and either the `pull_request.closed` event ' +
      'or another call to this verb will record the merge if it happened. A second `PUT` against ' +
      'an unknown outcome is how one merge becomes two attempts.',
  };
}

export function describeMergeRefusal(err: unknown, number: number): MergeCallRefusal {
  if (!(err instanceof GitHubPublishError)) {
    return describePublishThrown(err, 'merge', MERGE_SUBJECT);
  }
  if (err.timedOut && err.op === 'merge') return timedOut();

  if (err.status === 405) {
    return {
      cause: 'rejected-payload',
      op: 'merge',
      status: 405,
      detail: err.detail ?? null,
      message:
        `GitHub refused to merge #${number}: it is not mergeable at the moment Forge asked` +
        (err.detail ? ` — GitHub said: ${err.detail}` : '') +
        '. Forge read it as mergeable a moment earlier, so something moved in between — a push, ' +
        'a check that went red, a protection rule that now applies. Read it again; this is not ' +
        'retried, because the state that refused it has not changed by itself.',
    };
  }
  if (err.status === 409) {
    return {
      cause: 'rejected-payload',
      op: 'merge',
      status: 409,
      detail: err.detail ?? null,
      message:
        `GitHub refused to merge #${number}: its head branch was modified between Forge's read ` +
        'and the merge. The commits this would have landed are not the ones that were judged, so ' +
        'it is refused rather than re-sent against whatever is there now.',
    };
  }
  return describePublishRefusal(err, MERGE_SUBJECT);
}
