/**
 * One sentence per way a check-run publish can be refused. ISS-1072.
 *
 * This is the first thing Forge ever WRITES to GitHub, so none of these failures
 * has been met on this project before: every call the integration made until now
 * was a read, and "it worked for reads" is not evidence about any line here.
 *
 * ## The rule this file exists to keep
 *
 * A refusal is built from the EVIDENCE, never from the status alone. GitHub
 * answers 403 for at least three different things — a permission the App was not
 * granted, a primary rate limit, a secondary one — and each sends an operator
 * somewhere different: to the App's settings page, to a clock, or to a slower
 * caller. `integrations/types.ts` already states the cost of collapsing 401 and
 * 403 into one verdict (ISS-924, against the coolify adapter: re-entering a
 * credential that works reproduces the state exactly). Collapsing the three
 * meanings of 403 is the same defect one level down, and it is only reachable
 * now that Forge writes.
 *
 * So: a 403 with `x-ratelimit-remaining: 0` is a quota, a 403 with `retry-after`
 * is a secondary limit, a 403 whose body says the resource is not accessible to
 * the integration is a permission — and a 403 carrying NONE of those three is
 * refused as exactly that, an access refusal naming both possibilities. Guessing
 * between them because a guess reads better than an admission is how an operator
 * spends an hour granting a permission they already hold.
 *
 * ## Attempted, and unknown
 *
 * A timeout is two different reports depending on where it happened. Minting a
 * token and looking the run up both precede any write, so a timeout there means
 * the publish did not happen and can simply be retried. A timeout on the create
 * or the update means Forge does not know whether GitHub took it, and telling an
 * operator it did not is a claim nothing here can support.
 */

import { GitHubPublishError, type GitHubPublishOp } from './client.js';

const WHERE: Record<GitHubPublishOp, string> = {
  mint: 'minting the installation token',
  lookup: 'looking up the existing check run',
  create: 'creating the check run',
  update: 'updating the check run',
  merge: 'merging the pull request',
};

export type RefusalCause =
  | 'timed-out-before-write'
  | 'timed-out-mid-write'
  | 'rate-limited'
  | 'permission-missing'
  | 'access-refused'
  | 'installation-missing'
  | 'repository-unreachable'
  | 'credential-rejected'
  | 'rejected-payload'
  | 'unknown';

export interface CheckRefusal {
  cause: RefusalCause;
  op: GitHubPublishOp;
  status: number | null;
  /** What an operator is told. One sentence naming the cause and the way out. */
  message: string;
}

const header = (err: GitHubPublishError, name: string): string | null =>
  err.headers?.get(name) ?? null;

/** Whether the evidence says a quota — not a guess from the status. */
function rateLimitNote(err: GitHubPublishError): string | null {
  const retryAfter = header(err, 'retry-after');
  if (retryAfter) return `GitHub asked for ${retryAfter}s before the next attempt`;
  if (header(err, 'x-ratelimit-remaining') !== '0') return null;
  const reset = header(err, 'x-ratelimit-reset');
  const at = reset ? new Date(Number(reset) * 1000).toISOString() : null;
  return at ? `the quota resets at ${at}` : 'the quota is exhausted';
}

// cm:guard GitHub's own words for an ungranted permission. It answers this on a 403 when the App lacks the scope, and it is the ONLY positive evidence of that cause — everything else about such a 403 looks identical to a secondary rate limit. Widening this to any 403 is what turns "grant checks: write" into advice given to operators who already granted it.
const PERMISSION_TELLS = ['not accessible by integration', 'resource not accessible'];

function saysPermission(err: GitHubPublishError): boolean {
  const detail = err.detail?.toLowerCase() ?? '';
  return PERMISSION_TELLS.some((tell) => detail.includes(tell));
}

// cm:guard the BODY's own words outrank the headers, and the order is the whole of what this
// function decides. Read the headers first and a 403 saying "Resource not accessible by
// integration" that happens to arrive on a spent quota is reported as a rate limit — carrying the
// sentence "No permission is missing; nothing needs granting", which is a positive claim about a
// permission nobody checked. The operator waits for a reset that changes nothing. The headers are
// evidence about a quota and never evidence that a permission is held.
function forbidden(err: GitHubPublishError): CheckRefusal {
  const quota = rateLimitNote(err);
  if (saysPermission(err)) {
    return {
      cause: 'permission-missing',
      op: err.op,
      status: 403,
      message:
        `GitHub refused Forge while ${WHERE[err.op]} because the App has no \`checks: write\` ` +
        'permission. Set Checks to "Read and write" on the App, then approve the resulting ' +
        'request on the installation — reconnecting will not change this, because the credential ' +
        'is not what is wrong.' +
        (quota ? ` The same answer also reports a rate limit — ${quota} — so both may apply.` : ''),
    };
  }
  if (quota) {
    return {
      cause: 'rate-limited',
      op: err.op,
      status: 403,
      message: `GitHub rate-limited Forge while ${WHERE[err.op]} — ${quota}. GitHub sent nothing saying a permission was refused.`,
    };
  }
  return {
    cause: 'access-refused',
    op: err.op,
    status: 403,
    message:
      `GitHub answered 403 while ${WHERE[err.op]} and sent nothing saying which of the two it ` +
      'was: the App may lack `checks: write`, or this may be a secondary rate limit. Forge is ' +
      "not guessing between them. Check the App's Checks permission first; if it is already " +
      '"Read and write", retry after a pause.',
  };
}

function notFound(err: GitHubPublishError): CheckRefusal {
  if (err.op === 'mint') {
    // cm:guard `app-auth.ts`'s OWN sentence, unchanged. A 404 at the mint is an installation that does not exist — never a repository the App was removed from, which is what the same status means one operation later. Rewording it here is how a run tells an operator a history that did not happen.
    return {
      cause: 'installation-missing',
      op: 'mint',
      status: 404,
      message: err.message,
    };
  }
  return {
    cause: 'repository-unreachable',
    op: err.op,
    status: 404,
    message:
      `GitHub answered 404 while ${WHERE[err.op]}, so this App no longer reaches that ` +
      'repository — it was removed from the installation, or the repository was renamed or ' +
      'deleted. Re-installing the App on it is the way back; the credential is fine.',
  };
}

export function describeRefusal(err: GitHubPublishError): CheckRefusal {
  if (err.timedOut) {
    const beforeWrite = err.op === 'mint' || err.op === 'lookup';
    return {
      cause: beforeWrite ? 'timed-out-before-write' : 'timed-out-mid-write',
      op: err.op,
      status: null,
      message: beforeWrite
        ? `Forge timed out ${WHERE[err.op]}, so no check run was written and none was changed. Retrying is safe.`
        : `Forge timed out ${WHERE[err.op]}. GitHub may or may not have taken that write — this is an unknown outcome, not a confirmed failure to write.`,
    };
  }
  if (err.status === 429) {
    const quota = rateLimitNote(err) ?? 'no retry window was given';
    return {
      cause: 'rate-limited',
      op: err.op,
      status: 429,
      message: `GitHub rate-limited Forge while ${WHERE[err.op]} — ${quota}.`,
    };
  }
  if (err.status === 403) return forbidden(err);
  if (err.status === 404) return notFound(err);
  if (err.status === 401) {
    return {
      cause: 'credential-rejected',
      op: err.op,
      status: 401,
      message: `GitHub did not recognise Forge's credential while ${WHERE[err.op]}: ${err.message}`,
    };
  }
  if (err.status === 422) {
    return {
      cause: 'rejected-payload',
      op: err.op,
      status: 422,
      message:
        `GitHub refused the request while ${WHERE[err.op]} as unprocessable` +
        (err.detail ? `: ${err.detail}` : '') +
        '. The commonest cause is a head SHA this repository does not hold.',
    };
  }
  return {
    cause: 'unknown',
    op: err.op,
    status: err.status,
    message: `Forge failed while ${WHERE[err.op]}: ${err.message}`,
  };
}

/** The same description for anything thrown on the publish path, refusal or not. */
export function describeThrown(err: unknown, op: GitHubPublishOp): CheckRefusal {
  if (err instanceof GitHubPublishError) return describeRefusal(err);
  return {
    cause: 'unknown',
    op,
    status: null,
    message: `Forge failed while ${WHERE[op]}: ${err instanceof Error ? err.message : String(err)}`,
  };
}
