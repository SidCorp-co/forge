import { GitHubPublishError, type GitHubPublishOp } from './client.js';

/**
 * What one operation means on one publish path, and what a refusal of it says.
 *
 * Every clause here is per operation because the permission an operation needs
 * is a property of the operation and not of the path it runs on: the merge
 * `PUT` needs `pull_requests: write` and `contents: write` and no check
 * permission at all, while the four calls that publish a check run need
 * `checks: write` and nothing else. A subject that named one permission for a
 * map of operations rendered the check sentence for a merge and sent an
 * operator to grant a permission that could not unblock it (ISS-1151).
 */
export interface PublishOpSubject {
  /** What this op was doing, read into "… while <this> …". */
  where: string;
  /** After "GitHub refused Forge while <where> because ". The permission THIS op needs and the way to grant it. */
  permission: string;
  /** After "GitHub answered 403 while <where> and ". What GitHub did not say, and the readings THIS op's unexplained 403 has. */
  ambiguous: string;
  /** After "Forge timed out <where>, ". Says what was not written. */
  nothingWritten: string;
  /** After "… as unprocessable<detail>. ". The commonest cause for THIS op. */
  unprocessable: string;
}

/**
 * The sentences one publish path has written, for the operations it sends.
 *
 * The parameter is that operation set, so a path declares what it sends rather
 * than filling entries for calls it never makes. Handing an op to a subject
 * that has no entry for it does not compile; where only a runtime op is in
 * hand, `describePublishRefusal` says the entry is missing rather than reading
 * another operation's sentence.
 */
export type PublishSubject<Op extends GitHubPublishOp = GitHubPublishOp> = Readonly<
  Record<Op, PublishOpSubject>
>;

/** Any path's subject, read by op at runtime. The lookup may miss, and says so when it does. */
type SubjectLookup = Readonly<Partial<Record<GitHubPublishOp, PublishOpSubject>>>;

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

/**
 * A refusal of an operation this path has written no sentence for.
 *
 * It names the gap instead of borrowing a neighbour's wording, because a
 * message that reads as a diagnosis is worse than one that admits it has none:
 * the borrowed sentence is what sent an operator to grant `checks: write` for
 * a merge, and told them in the same breath to stop looking elsewhere.
 */
function unwritten(op: GitHubPublishOp, status: number | null, why: string): PublishRefusal {
  return {
    cause: 'unknown',
    op,
    status,
    detail: null,
    message:
      `Forge failed a \`${op}\` call that this path describes no refusal for: ${why}. Nothing here ` +
      `can say which permission or which cause that was, and no other operation's sentence stands ` +
      `in for it — \`${op}\` needs its own entry on this path's refusal subject.`,
  };
}

function forbidden(
  err: GitHubPublishError,
  subject: PublishOpSubject,
  quota: string | null,
): PublishRefusal {
  if (saysPermission(err)) {
    return {
      cause: 'permission-missing',
      op: err.op,
      status: 403,
      detail: err.detail ?? null,
      message:
        `GitHub refused Forge while ${subject.where} because ${subject.permission}` +
        (quota ? ` The same answer also reports a rate limit — ${quota} — so both may apply.` : ''),
    };
  }
  if (quota) {
    return {
      cause: 'rate-limited',
      op: err.op,
      status: 403,
      detail: err.detail ?? null,
      message: `GitHub rate-limited Forge while ${subject.where} — ${quota}. GitHub sent nothing saying a permission was refused.`,
    };
  }
  return {
    cause: 'access-refused',
    op: err.op,
    status: 403,
    detail: err.detail ?? null,
    message: `GitHub answered 403 while ${subject.where} and ${subject.ambiguous}`,
  };
}

function notFound(err: GitHubPublishError, subject: PublishOpSubject): PublishRefusal {
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
      `GitHub answered 404 while ${subject.where}, so this App no longer reaches that ` +
      'repository — it was removed from the installation, or the repository was renamed or ' +
      'deleted. Re-installing the App on it is the way back; the credential is fine.',
  };
}

export function describePublishRefusal(
  err: GitHubPublishError,
  path: SubjectLookup,
): PublishRefusal {
  const subject = path[err.op];
  if (!subject) return unwritten(err.op, err.status, err.message);
  if (err.timedOut) {
    const beforeWrite = err.op === 'mint' || err.op === 'lookup';
    return {
      cause: beforeWrite ? 'timed-out-before-write' : 'timed-out-mid-write',
      op: err.op,
      status: null,
      detail: err.detail ?? null,
      message: beforeWrite
        ? `Forge timed out ${subject.where}, ${subject.nothingWritten}`
        : `Forge timed out ${subject.where}. GitHub may or may not have taken that write — this is an unknown outcome, not a confirmed failure to write.`,
    };
  }
  if (err.status === 429) {
    const quota = rateLimitNote(err) ?? 'no retry window was given';
    return {
      cause: 'rate-limited',
      op: err.op,
      status: 429,
      detail: err.detail ?? null,
      message: `GitHub rate-limited Forge while ${subject.where} — ${quota}.`,
    };
  }
  if (err.status === 403) return forbidden(err, subject, rateLimitNote(err));
  if (err.status === 404) return notFound(err, subject);
  if (err.status === 401) {
    return {
      cause: 'credential-rejected',
      op: err.op,
      status: 401,
      detail: err.detail ?? null,
      message: `GitHub did not recognise Forge's credential while ${subject.where}: ${err.message}`,
    };
  }
  if (err.status === 422) {
    return {
      cause: 'rejected-payload',
      op: err.op,
      status: 422,
      detail: err.detail ?? null,
      message:
        `GitHub refused the request while ${subject.where} as unprocessable` +
        (err.detail ? `: ${err.detail}` : '') +
        `. ${subject.unprocessable}`,
    };
  }
  return {
    cause: 'unknown',
    op: err.op,
    status: err.status,
    detail: err.detail ?? null,
    message: `Forge failed while ${subject.where}: ${err.message}`,
  };
}

/** The same description for anything thrown on a publish path, refusal or not. */
export function describePublishThrown<Op extends GitHubPublishOp>(
  err: unknown,
  op: Op,
  path: PublishSubject<Op>,
): PublishRefusal {
  if (err instanceof GitHubPublishError) return describePublishRefusal(err, path);
  const why = err instanceof Error ? err.message : String(err);
  const subject = (path as SubjectLookup)[op];
  if (!subject) return unwritten(op, null, why);
  return {
    cause: 'unknown',
    op,
    status: null,
    detail: null,
    message: `Forge failed while ${subject.where}: ${why}`,
  };
}
