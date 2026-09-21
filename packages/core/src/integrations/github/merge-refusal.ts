import { type CheckRefusal, describeThrown } from './check-refusal.js';
import { GitHubPublishError } from './client.js';

/** The same shape a check refusal carries, so one reader handles both. */
export type MergeCallRefusal = CheckRefusal;

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
  if (!(err instanceof GitHubPublishError)) return describeThrown(err, 'merge');
  if (err.timedOut) return timedOut();

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
  return describeThrown(err, 'merge');
}
