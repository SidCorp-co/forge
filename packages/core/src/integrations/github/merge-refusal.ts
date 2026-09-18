/**
 * What GitHub's own answer to a merge means. ISS-1073.
 *
 * The decision table (`merge-eligibility.ts`) refuses everything it can see
 * BEFORE any request goes out. What is left here is what GitHub says after it —
 * and almost all of it is a race, because the pre-flight read and the `PUT` are
 * two calls and a repository moves between them.
 *
 * ## Why this is not `check-refusal.ts` with another status
 *
 * Two statuses mean something on this path that they mean nowhere else. GitHub
 * answers **405** for a pull request it will not merge — the state moved since
 * the read — and **409** for a head that was modified between the two calls.
 * Both are refusals naming a thing that changed, and both are answered by
 * reading again rather than by anything an operator does to the App. Reported
 * through the check-run vocabulary they come back as `unknown`, which tells
 * nobody anything.
 *
 * Everything else — a rate limit, a permission, a credential, a timeout — means
 * exactly what it means for a publish, and is delegated rather than restated.
 * A restated sentence is one that stops matching the first time either is
 * edited.
 */
// cm:guard NOTHING here retries and nothing here reaches for a second credential, and that is the rule rather than an omission: ISS-1073's third rule is that a merge that cannot be made is refused by name, never retried and never fallen back from. A 405 answered by retrying is a merge attempted twice against a repository whose state is moving, and a 403 answered by reaching for a person's token is the very identity this whole layer exists to remove.

import { type CheckRefusal, describeThrown } from './check-refusal.js';
import { GitHubPublishError } from './client.js';

/** The same shape a check refusal carries, so one reader handles both. */
export type MergeCallRefusal = CheckRefusal;

// cm:guard the timeout arm is NOT delegated, and the difference is the whole of what an operator does next. `check-refusal.ts` says of a timed-out write that GitHub may or may not have taken it — true, and for a check run the way out is to publish again. For a merge the way out is the opposite: do NOT send it again, read the pull request, and let the `pull_request.closed` event or a second call to this verb record whatever actually happened. A sentence that invited a retry here would invite a second merge.
function timedOut(): MergeCallRefusal {
  return {
    cause: 'timed-out-mid-write',
    op: 'merge',
    status: null,
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
      message:
        `GitHub refused to merge #${number}: its head branch was modified between Forge's read ` +
        'and the merge. The commits this would have landed are not the ones that were judged, so ' +
        'it is refused rather than re-sent against whatever is there now.',
    };
  }
  return describeThrown(err, 'merge');
}
