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

const PERMISSION_TELLS = ['not accessible by integration', 'resource not accessible'];

function saysPermission(err: GitHubPublishError): boolean {
  const detail = err.detail?.toLowerCase() ?? '';
  return PERMISSION_TELLS.some((tell) => detail.includes(tell));
}

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
