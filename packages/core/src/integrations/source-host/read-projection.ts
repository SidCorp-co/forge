/**
 * A change request projected from what its host answers now, for a binding no webhook reaches.
 *
 * The row, its issue links and its checks are written by the writers a delivery reaches —
 * `applyPullRequestEvent` for the row and links, `storeHostChecks` folding each check under the
 * `check_run` rule — so a read and a webhook produce one record, and the links are derived by one
 * rule (REQ-63 BC-4). A merge the read reports is handed back as the `source.merged` fact a hook
 * would report, for the caller to emit: it stamps the issues the request delivers, once.
 */

import type { InboundFact } from '../index.js';
import { SourceHostCallError } from './errors.js';
import { readMergedHead } from './merged-head.js';
import { applyPullRequestEvent, type ProjectionContext, storeHostChecks } from './projection.js';
import { linkedIssuesOfNumber } from './repo-projection.js';
import type { ReadChangeRequest, SourceHost } from './types.js';

/** A host answer missing a field the row cannot be written without, named field by field. */
export class ChangeRequestReadIncomplete extends SourceHostCallError {
  constructor(host: SourceHost, number: number, missing: string[]) {
    super(
      200,
      `${host.provider} answered ${host.words.changeRequest} ${host.words.sigil}${number} on ${host.fullName} with no ` +
        `${missing.join(', no ')}, so Forge cannot write the projection row the merge and the release read`,
    );
    this.name = 'ChangeRequestReadIncomplete';
  }
}

/** What a check read wrote onto the row, or why it could not. */
type ChecksProjection =
  | { outcome: 'stored'; headSha: string; checks: number }
  | { outcome: 'unread'; headSha: string | null; reason: string };

export interface ReadProjection {
  /** `superseded` where Forge already held a newer record of the request, which stands. */
  outcome: 'recorded' | 'superseded';
  state: string;
  /** Every Forge issue the row delivers, by its branch and its description (REQ-63 BC-4). */
  issueIds: string[];
  checks: ChecksProjection;
}

function missingOf(read: ReadChangeRequest): string[] {
  const missing: string[] = [];
  if (!read.headRef) missing.push('head ref');
  if (!read.headSha) missing.push('head sha');
  if (!read.baseRef) missing.push('base ref');
  if (!read.baseSha) missing.push('base sha');
  if (!read.updatedAt) missing.push('updated at');
  if (read.state === 'merged' && !read.mergeCommitSha) missing.push('landing commit');
  if (read.state === 'merged' && !read.mergedAt) missing.push('merge time');
  return missing;
}

/** Store the host's checks for the request at its head, its own pipeline included (REQ-63 BC-7),
 *  reported rather than thrown: the row stands. */
async function projectChecks(
  host: SourceHost,
  row: { id: string; number: number },
  headSha: string,
): Promise<ChecksProjection> {
  try {
    const checks = await host.readChangeRequestChecks({ number: row.number, headSha });
    await storeHostChecks(row.id, checks);
    return { outcome: 'stored', headSha, checks: checks.length };
  } catch (err) {
    return {
      outcome: 'unread',
      headSha,
      reason: `the checks on ${headSha} could not be read from ${host.provider}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Write the request a host just answered for onto the projection, with its links and the checks on
 * its head, and answer the merge it reports as a fact. A field the row cannot be written without is
 * refused by name before anything is written.
 */
export async function projectReadChangeRequest(args: {
  projectId: string;
  host: SourceHost;
  read: ReadChangeRequest;
}): Promise<{ projection: ReadProjection; facts: InboundFact[] }> {
  const { host, read } = args;
  const missing = missingOf(read);
  if (missing.length > 0) throw new ChangeRequestReadIncomplete(host, read.number, missing);
  const headSha = read.headSha as string;
  const ctx: ProjectionContext = {
    projectId: args.projectId,
    bindingId: host.bindingId,
    host: host.provider,
  };
  const written = await applyPullRequestEvent(ctx, {
    action: 'read',
    pull_request: {
      number: read.number,
      title: read.title,
      body: read.body,
      ...(read.url === null ? {} : { html_url: read.url }),
      state: read.state === 'open' ? 'open' : 'closed',
      draft: read.draft,
      merged: read.state === 'merged',
      merged_at: read.mergedAt,
      merge_commit_sha: read.mergeCommitSha,
      updated_at: read.updatedAt,
      head: { ref: read.headRef, sha: headSha },
      base: { ref: read.baseRef, sha: read.baseSha as string },
    },
    repository: { full_name: host.fullName },
  });
  const row = await linkedIssuesOfNumber(host.bindingId, read.number);
  const checks: ChecksProjection = row
    ? await projectChecks(host, { id: row.id, number: read.number }, headSha)
    : { outcome: 'unread', headSha, reason: 'no projection row stands for it to carry them' };
  const projection: ReadProjection = {
    outcome: written > 0 ? 'recorded' : 'superseded',
    state: read.state,
    issueIds: row?.issueIds ?? [],
    checks,
  };
  if (read.state !== 'merged') return { projection, facts: [] };
  const commitSha = read.mergeCommitSha as string;
  const head = await readMergedHead((a, b) => host.sameTree(a, b), headSha, commitSha);
  return {
    projection,
    facts: [
      {
        type: 'source.merged',
        payload: {
          projectId: args.projectId,
          headRef: read.headRef,
          baseRef: read.baseRef,
          commitSha,
          mergedAt: read.mergedAt as string,
          head,
        },
      },
    ],
  };
}

/** The checks on a stored row's head after Forge merged it, so a binding with no hook still holds them. */
export async function projectChecksAfterMerge(
  host: SourceHost,
  row: { id: string; number: number; headSha: string },
): Promise<ChecksProjection> {
  return projectChecks(host, row, row.headSha);
}
