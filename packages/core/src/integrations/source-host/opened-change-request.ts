/**
 * ISS-1123 — what Forge opens, Forge records.
 *
 * `repo_pull_requests` had exactly one writer and exactly one route to it: a `pull_request`
 * delivery arriving at `POST /api/webhooks/in/:slug`. A pull request the agent face opened left no
 * row at all, so the merge route resolved nothing and refused every pull request on the project —
 * including the one Forge was certain about, because it had just created it.
 *
 * This is the second route to the SAME writer, in the shape `review-note.ts` already holds for the
 * review path: the webhook arm and the agent face reach ONE function, so "no second record" stays a
 * property of there being one writer rather than of two call sites agreeing. Nothing here inserts.
 * The answer the creation call returned is what it reads, and the host is called only to read back an
 * answer missing a field the row needs (`recordOpenedChangeRequest`, ISS-980).
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { type ChangeRequestHost, repoPullRequests } from '../../db/schema-repo-projection.js';
import { forgeReads } from '../index.js';
import { applyPullRequestEvent, type PullRequestPayload } from './projection.js';
import { linkedIssuesOfNumber, type NamedLink } from './repo-projection.js';
import type { OpenedChangeRequest, SourceHost } from './types.js';

type OpenedProjectionOutcome =
  /** This call wrote the row. */
  | 'recorded'
  /**
   * A record of this number already stood, so the writer kept it. Not a failure.
   *
   * Every stored row supersedes a creation answer, including one whose timestamp ties it: the
   * answer describes the request at the instant it began, so nothing it could overwrite is older.
   */
  | 'superseded'
  /** Nothing was written, and `reason` says what stopped it. The pull request still exists. */
  | 'not-recorded';

interface OpenedProjectionResult {
  outcome: OpenedProjectionOutcome;
  /** Every Forge issue the row delivers, in the order it names them: its branch's keys, then its title's, then the ones its description delivers (REQ-63 BC-4). */
  issueIds: string[];
  /** The same issues, each with the reading that named it: branch lead or tail, title or body (ISS-1027). */
  linkedIssues: NamedLink[];
  /** The primary issue: the branch's, else the first the title or description delivers; null where none is linked. */
  issueId: string | null;
  /** Where it links no issue, why, named by what was read (ISS-855); null where it links one, or nothing was read back. */
  noIssue: string | null;
  /**
   * Why there is no row — or, under `recorded`, what could not be read back after there was one.
   * Null where the row was written and read.
   */
  reason: string | null;
}

/**
 * A creation answer that cannot become a row, named field by field.
 *
 * The row's identity columns are `NOT NULL` and the merge route resolves on them, so a partial row
 * is not a lesser record — it is a row the merge would find and then fail to act on. A host sending
 * a change request back without a head sha is not a shape this widens to accept, and nor is one
 * without the `updated_at` the writer orders on — `RowIdentity` says what that absence costs. Where
 * the request was read back and the read did not supply the field either, `readBack` says so.
 */
export class OpenedPullRequestIncomplete extends Error {
  readonly missing: string[];
  constructor(
    missing: string[],
    repository: string,
    opts: { provider?: string; number?: number; readBack?: string } = {},
  ) {
    const which = opts.number ? ` #${opts.number}` : '';
    const refresh = opts.number
      ? `\`POST /api/projects/:id/integrations/source/change-requests/${opts.number}/refresh\` re-reads it and writes the row, and so does a webhook delivery for it.`
      : 'A webhook delivery for it writes the row.';
    super(
      `${opts.provider ?? 'github'}: the answer to opening change request${which} on ${repository} carried no ` +
        `${missing.join(', no ')}${opts.readBack ? `, and reading it back did not supply it (${opts.readBack})` : ''}, ` +
        `so Forge cannot write the projection row the merge route resolves on. The change request EXISTS on the host. ${refresh}`,
    );
    this.name = 'OpenedPullRequestIncomplete';
    this.missing = missing;
  }
}

/**
 * The six fields a row cannot be written without — or the names of the ones GitHub left out.
 *
 * `updated_at` is one of them, and it is here for a reason the other five are not: it is the only
 * field whose ABSENCE is louder than its presence. The writer's `setWhere` reads a null
 * `payload_updated_at` on the incoming row as always-wins, so a creation answer that carried no
 * timestamp would not merely arrive unordered — it would overwrite a `merged` row's state, head and
 * merge commit with `open` and no merge evidence, silently, and the merge stamp this whole path
 * exists to protect would be gone. Refusing it by name is the loud break; widening the writer to
 * cope is the silent substitution.
 */
interface RowIdentity {
  number: number;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  updatedAt: string;
}

function missingOf(opened: OpenedChangeRequest): string[] {
  const missing: string[] = [];
  if (!opened.number) missing.push('number');
  if (!opened.headRef) missing.push('head ref');
  if (!opened.headSha) missing.push('head sha');
  if (!opened.baseRef) missing.push('base ref');
  if (!opened.baseSha) missing.push('base sha');
  if (!opened.updatedAt) missing.push('updated at');
  return missing;
}

function identityOf(opened: OpenedChangeRequest): RowIdentity | { missing: string[] } {
  const missing = missingOf(opened);
  if (missing.length > 0) return { missing };
  return {
    number: opened.number,
    headRef: opened.headRef,
    headSha: opened.headSha as string,
    baseRef: opened.baseRef,
    baseSha: opened.baseSha as string,
    updatedAt: opened.updatedAt as string,
  };
}

/**
 * The delivery shape, built from the creation answer.
 *
 * Not a forged webhook: GitHub returns the same `pull_request` object from `POST /pulls` that it
 * puts in a `pull_request` delivery, so this hands the writer the object it already models rather
 * than teaching it a second one. `updated_at` travels unchanged, because it is what the writer's
 * ordering rule turns on.
 */
function payloadFor(args: {
  repository: string;
  opened: OpenedChangeRequest;
  identity: RowIdentity;
  description: string | null;
}): PullRequestPayload {
  const { opened, identity } = args;
  return {
    action: 'opened',
    pull_request: {
      number: identity.number,
      title: opened.title,
      body: args.description,
      ...(opened.url === null ? {} : { html_url: opened.url }),
      state: opened.state,
      draft: opened.draft,
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      updated_at: identity.updatedAt,
      head: { ref: identity.headRef, sha: identity.headSha },
      base: { ref: identity.baseRef, sha: identity.baseSha },
    },
    repository: { full_name: args.repository },
  };
}

/**
 * Record a pull request the agent face just opened, through the projection's own writer.
 *
 * Opening is not landing: the payload says `merged: false` with no merge commit and no merge time,
 * so `stateOf` reads `open` and the row carries no merge evidence. The stamp stays the merge's,
 * which is the single-writer rule this must not route around.
 */
export async function projectOpenedPullRequest(args: {
  projectId: string;
  bindingId: string;
  /** The host the change request was opened on; GitHub where left out. */
  host?: ChangeRequestHost;
  /** The repository's path on its host, as the binding spells it. */
  repository: string;
  opened: OpenedChangeRequest;
  /** The description the request was opened with: the issue keys it names are linked (REQ-63 BC-4). */
  description?: string | null;
}): Promise<OpenedProjectionResult> {
  const identity = identityOf(args.opened);
  if ('missing' in identity) {
    throw new OpenedPullRequestIncomplete(identity.missing, args.repository, {
      ...(args.host ? { provider: args.host } : {}),
      ...(args.opened.number ? { number: args.opened.number } : {}),
    });
  }

  const written = await applyPullRequestEvent(
    {
      projectId: args.projectId,
      bindingId: args.bindingId,
      ...(args.host ? { host: args.host } : {}),
    },
    payloadFor({
      repository: args.repository,
      opened: args.opened,
      identity,
      description: args.description ?? null,
    }),
    'creation',
  );

  // The write has COMMITTED by here. Reading the row back is how this call reports which issue the
  // branch resolved to, and a read that fails says nothing about the write that preceded it — so it
  // is caught rather than thrown. Letting it escape turned a committed row into `not-recorded` and a
  // log line saying the projection row never landed, which is the one thing known to be false.
  let row: { issueIds: string[]; links: NamedLink[] } | undefined;
  let unread: string | null = null;
  try {
    row = await linkedIssuesOfNumber(args.bindingId, identity.number);
  } catch (err) {
    unread =
      `the row for #${identity.number} on ${args.repository} could not be read back (${String(err)}), ` +
      'so the issue it links to is not reported here.';
  }
  const issueIds = row?.issueIds ?? [];
  const linkedIssues = row?.links ?? [];
  const issueId = issueIds[0] ?? null;
  const noIssue =
    row && issueIds.length === 0
      ? await forgeReads().noIssueForChangeRequest({
          projectId: args.projectId,
          headRef: identity.headRef,
          title: args.opened.title ?? null,
          description: args.description ?? null,
        })
      : null;

  if (written > 0) {
    return {
      outcome: 'recorded',
      issueIds,
      linkedIssues,
      issueId,
      noIssue,
      reason: unread === null ? null : `${unread} The row itself was written.`,
    };
  }
  // Zero writes here is `superseded` and nothing else, and it is the WRITER that says so rather
  // than the readback. `applyPullRequestEvent` returns 0 for exactly two reasons: its early guard
  // on the five payload fields, which `identityOf` has already enforced above, or its `ON CONFLICT`
  // predicate declining to overwrite a row that already stands, which under `creation` is every
  // such row. Only the second is reachable from here. A readback that then fails leaves the row's
  // LINKAGE unknown, never the outcome — reading `not-recorded` off it would tell a caller the pull
  // request has no record at the one moment Forge is known to hold one.
  if (unread !== null) {
    return {
      outcome: 'superseded',
      issueIds: [],
      linkedIssues: [],
      issueId: null,
      noIssue: null,
      reason:
        `Forge already holds a record of #${identity.number} on ${args.repository}, which is at least as ` +
        `new as this creation answer, so the stored one stands and nothing was overwritten. ${unread}`,
    };
  }
  if (row) {
    return {
      outcome: 'superseded',
      issueIds,
      linkedIssues,
      issueId,
      noIssue,
      reason:
        `Forge already holds a record of #${args.opened.number} on ${args.repository}, which is at least ` +
        'as new as this creation answer, so the stored one stands. Nothing was overwritten.',
    };
  }
  return {
    outcome: 'not-recorded',
    issueIds: [],
    linkedIssues: [],
    issueId: null,
    noIssue: null,
    reason:
      `the projection writer wrote no row for #${args.opened.number} on ${args.repository} and no row for ` +
      'that number is there, which is a state this path does not otherwise produce. The change request EXISTS ' +
      'on its host; merging it through Forge needs a row, and none is here.',
  };
}

/**
 * Record a change request the agent face just opened on `host` (ISS-980, FB-547).
 *
 * GitLab answers a create before it has computed the request's diff, so the answer can carry no head
 * or base sha, and the row the merge resolves on was then never written: the request stood on the
 * host, unlinked, until somebody re-read it. Where the answer lacks a field the row needs, the request
 * is read back from the host once and each missing field taken from that read; the answer's own
 * fields stand. A field neither holds is refused by name (`OpenedPullRequestIncomplete`), as before.
 */
export async function recordOpenedChangeRequest(args: {
  projectId: string;
  host: SourceHost;
  opened: OpenedChangeRequest;
  description?: string | null;
}): Promise<{ opened: OpenedChangeRequest; projection: OpenedProjectionResult }> {
  const { host } = args;
  const project = (opened: OpenedChangeRequest) =>
    projectOpenedPullRequest({
      projectId: args.projectId,
      bindingId: host.bindingId,
      host: host.provider,
      repository: host.fullName,
      opened,
      description: args.description ?? null,
    });
  const missing = missingOf(args.opened);
  if (missing.length === 0 || !args.opened.number) {
    return { opened: args.opened, projection: await project(args.opened) };
  }
  let read: OpenedChangeRequest;
  try {
    read = await host.readChangeRequest(args.opened.number);
  } catch (err) {
    throw new OpenedPullRequestIncomplete(missing, host.fullName, {
      provider: host.provider,
      number: args.opened.number,
      readBack: `the read failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  const whole: OpenedChangeRequest = {
    ...args.opened,
    headRef: args.opened.headRef || read.headRef,
    headSha: args.opened.headSha ?? read.headSha,
    baseRef: args.opened.baseRef || read.baseRef,
    baseSha: args.opened.baseSha ?? read.baseSha,
    updatedAt: args.opened.updatedAt ?? read.updatedAt,
  };
  if (missingOf(whole).length > 0) {
    throw new OpenedPullRequestIncomplete(missingOf(whole), host.fullName, {
      provider: host.provider,
      number: args.opened.number,
      readBack: `${host.provider} answered the read without it too`,
    });
  }
  return { opened: whole, projection: await project(whole) };
}

/**
 * Whether change request `number` of the binding is still open, as its projection holds it: null
 * when nothing is projected for it.
 */
export async function changeRequestOpen(
  bindingId: string,
  number: number,
): Promise<boolean | null> {
  const [row] = await db
    .select({ state: repoPullRequests.state })
    .from(repoPullRequests)
    .where(and(eq(repoPullRequests.bindingId, bindingId), eq(repoPullRequests.number, number)))
    .limit(1);
  return row ? row.state === 'open' : null;
}
