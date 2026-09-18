/**
 * One sentence per way any publish to GitHub can be refused. ISS-1075.
 *
 * This is `check-refusal.ts`'s engine, lifted whole the moment Forge gained a
 * SECOND thing it writes to GitHub — the `runner-v*` tag. Everything below was
 * written for the check run and every word of it is about the credential, the
 * quota and the timeout rather than about check runs, which is precisely why a
 * second copy of it would have been the wrong answer: the three meanings of a
 * 403 do not become three different meanings because the request created a tag.
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
 * token and looking a thing up both precede any write, so a timeout there means
 * the publish did not happen and can simply be retried. A timeout on the create
 * or the update means Forge does not know whether GitHub took it, and telling an
 * operator it did not is a claim nothing here can support.
 *
 * ## What a subject supplies, and what it may not
 *
 * A `PublishSubject` supplies only the four sentences that are about the THING
 * being written: which operation each op was, which permission it needs, what
 * was not written when a pre-write call timed out, and the commonest cause of a
 * 422. It supplies no cause, no status mapping and no ordering — those are the
 * rule, and a subject that could change them would be a second engine wearing
 * this one's name.
 */

import { GitHubPublishError, type GitHubPublishOp } from './client.js';

/** What one publish path calls its own operations and its own permission. */
export interface PublishSubject {
  /** What each op was doing, read into "… while <this> …". */
  where: Record<GitHubPublishOp, string>;
  /** After "GitHub refused Forge while <where> because ". Names the permission and the way to grant it. */
  permission: string;
  /** After "… sent nothing saying which of the two it was: ". Names both possibilities and what to check first. */
  ambiguous: string;
  /** After "Forge timed out <where>, ". Says what was not written. */
  nothingWritten: string;
  /** After "… as unprocessable<detail>. ". The commonest cause. */
  unprocessable: string;
}

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

export interface PublishRefusal {
  cause: RefusalCause;
  op: GitHubPublishOp;
  status: number | null;
  /** What an operator is told. One sentence naming the cause and the way out. */
  message: string;
  // cm:guard GitHub's OWN body, carried separately from `message` because `message` is Forge's prose with the subject's sentences folded into it. A caller deciding anything from GitHub's words — `saysRefExists` in `runner-release-repo.ts` is the one that does — reads this; matching on `message` instead matched the advice Forge appended, so every 422 read as "the ref already exists" including the ones that say the commit does not.
  detail: string | null;
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

// cm:guard GitHub's own words for an ungranted permission. It answers this on a 403 when the App lacks the scope, and it is the ONLY positive evidence of that cause — everything else about such a 403 looks identical to a secondary rate limit. Widening this to any 403 is what turns "grant the permission" into advice given to operators who already granted it.
const PERMISSION_TELLS = ['not accessible by integration', 'resource not accessible'];

function saysPermission(err: GitHubPublishError): boolean {
  const detail = err.detail?.toLowerCase() ?? '';
  return PERMISSION_TELLS.some((tell) => detail.includes(tell));
}

// cm:guard the BODY's own words outrank the headers, and the order is the whole of what this function decides. Read the headers first and a 403 saying "Resource not accessible by integration" that happens to arrive on a spent quota is reported as a rate limit — carrying the sentence "No permission is missing; nothing needs granting", which is a positive claim about a permission nobody checked. The operator waits for a reset that changes nothing. The headers are evidence about a quota and never evidence that a permission is held.
function forbidden(err: GitHubPublishError, subject: PublishSubject): PublishRefusal {
  const quota = rateLimitNote(err);
  if (saysPermission(err)) {
    return {
      cause: 'permission-missing',
      op: err.op,
      status: 403,
      detail: err.detail ?? null,
      message:
        `GitHub refused Forge while ${subject.where[err.op]} because ${subject.permission}` +
        (quota ? ` The same answer also reports a rate limit — ${quota} — so both may apply.` : ''),
    };
  }
  if (quota) {
    return {
      cause: 'rate-limited',
      op: err.op,
      status: 403,
      detail: err.detail ?? null,
      message: `GitHub rate-limited Forge while ${subject.where[err.op]} — ${quota}. GitHub sent nothing saying a permission was refused.`,
    };
  }
  return {
    cause: 'access-refused',
    op: err.op,
    status: 403,
    detail: err.detail ?? null,
    message:
      `GitHub answered 403 while ${subject.where[err.op]} and sent nothing saying which of the two it ` +
      `was: ${subject.ambiguous}`,
  };
}

function notFound(err: GitHubPublishError, subject: PublishSubject): PublishRefusal {
  if (err.op === 'mint') {
    // cm:guard `app-auth.ts`'s OWN sentence, unchanged. A 404 at the mint is an installation that does not exist — never a repository the App was removed from, which is what the same status means one operation later. Rewording it here is how a run tells an operator a history that did not happen.
    return {
      cause: 'installation-missing',
      op: 'mint',
      status: 404,
      detail: err.detail ?? null,
      message: err.message,
    };
  }
  return {
    cause: 'repository-unreachable',
    op: err.op,
    status: 404,
    detail: err.detail ?? null,
    message:
      `GitHub answered 404 while ${subject.where[err.op]}, so this App no longer reaches that ` +
      'repository — it was removed from the installation, or the repository was renamed or ' +
      'deleted. Re-installing the App on it is the way back; the credential is fine.',
  };
}

export function describePublishRefusal(
  err: GitHubPublishError,
  subject: PublishSubject,
): PublishRefusal {
  if (err.timedOut) {
    const beforeWrite = err.op === 'mint' || err.op === 'lookup';
    return {
      cause: beforeWrite ? 'timed-out-before-write' : 'timed-out-mid-write',
      op: err.op,
      status: null,
      detail: err.detail ?? null,
      message: beforeWrite
        ? `Forge timed out ${subject.where[err.op]}, ${subject.nothingWritten}`
        : `Forge timed out ${subject.where[err.op]}. GitHub may or may not have taken that write — this is an unknown outcome, not a confirmed failure to write.`,
    };
  }
  if (err.status === 429) {
    const quota = rateLimitNote(err) ?? 'no retry window was given';
    return {
      cause: 'rate-limited',
      op: err.op,
      status: 429,
      detail: err.detail ?? null,
      message: `GitHub rate-limited Forge while ${subject.where[err.op]} — ${quota}.`,
    };
  }
  if (err.status === 403) return forbidden(err, subject);
  if (err.status === 404) return notFound(err, subject);
  if (err.status === 401) {
    return {
      cause: 'credential-rejected',
      op: err.op,
      status: 401,
      detail: err.detail ?? null,
      message: `GitHub did not recognise Forge's credential while ${subject.where[err.op]}: ${err.message}`,
    };
  }
  if (err.status === 422) {
    return {
      cause: 'rejected-payload',
      op: err.op,
      status: 422,
      detail: err.detail ?? null,
      message:
        `GitHub refused the request while ${subject.where[err.op]} as unprocessable` +
        (err.detail ? `: ${err.detail}` : '') +
        `. ${subject.unprocessable}`,
    };
  }
  return {
    cause: 'unknown',
    op: err.op,
    status: err.status,
    detail: err.detail ?? null,
    message: `Forge failed while ${subject.where[err.op]}: ${err.message}`,
  };
}

/** The same description for anything thrown on a publish path, refusal or not. */
export function describePublishThrown(
  err: unknown,
  op: GitHubPublishOp,
  subject: PublishSubject,
): PublishRefusal {
  if (err instanceof GitHubPublishError) return describePublishRefusal(err, subject);
  return {
    cause: 'unknown',
    op,
    status: null,
    detail: null,
    message: `Forge failed while ${subject.where[op]}: ${err instanceof Error ? err.message : String(err)}`,
  };
}
