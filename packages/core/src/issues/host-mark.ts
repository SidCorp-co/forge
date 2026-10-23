import type { MergeRefusalCode } from '@forge/contracts/issues';
import { releaseThroughChangeRequests } from '@forge/contracts/releases';
import { db } from '../db/client.js';
import { RefusalError, refuser } from '../lib/refusal.js';
import { hostMergeNamed } from './host-landing.js';
import { observedMergeForIssue } from './merge-record.js';
import { isSourceHostUnavailable, readProjectDocument, resolveSourceHost } from './ports.js';
import type { IssueRow } from './read-service.js';

/** A landing the host holds: the commit, and when it landed there. */
export type HostMerge = { commitSha: string; mergedAt: Date };

const refuse = refuser<MergeRefusalCode>('MERGE_MARK_REFUSED');

const HOST_ONLY =
  'This project releases through change requests, so a merge mark lands nothing by itself: only what the host holds does.';
const OPEN_A_REQUEST =
  'Open or update a change request that links this issue (its branch or description naming it); once the release is approved, the master merges it through `POST /api/issues/:id/merge-pull-request`, and that merge records the landing.';

/** The mark's `commit` as the host holds it on the mark's `target` branch, read through the binding. */
async function hostBranchLanding(
  prior: Pick<IssueRow, 'id' | 'projectId'>,
  commit: string,
  target: string,
): Promise<HostMerge> {
  const unreachable = (why: string) =>
    refuse(
      'MARK_HOST_UNREACHABLE',
      `${HOST_ONLY} Whether \`${target}\` on the host contains \`${commit}\` could not be read, so the mark is not taken unchecked: ${why}. Mark again once the host answers.`,
      '/commit',
    );
  let host: Awaited<ReturnType<typeof resolveSourceHost>>;
  try {
    host = await resolveSourceHost(prior.projectId, 'kernel');
  } catch (err) {
    if (isSourceHostUnavailable(err)) throw unreachable(err.message);
    throw err;
  }
  const where = `${host.provider} ${host.fullName}`;
  try {
    const read = await host.readCommit(commit);
    const at = read ? new Date(read.committedAt ?? '') : null;
    if (read && at && !Number.isNaN(at.getTime())) {
      if (await host.branchContains(target, read.sha)) return { commitSha: read.sha, mergedAt: at };
    } else if (read) {
      throw new Error(`${where} answered no committer date for ${read.sha}`);
    }
    throw refuse(
      'MARK_NOT_A_HOST_MERGE',
      `${HOST_ONLY} Checked ${where}: ${read ? `branch \`${target}\` does not contain \`${read.sha}\`` : `\`${commit}\` is no commit there`}, and it is the merge commit of no change request the host reported merged. ${OPEN_A_REQUEST}`,
      '/commit',
    );
  } catch (err) {
    if (err instanceof RefusalError) throw err;
    throw unreachable(err instanceof Error ? err.message : String(err));
  }
}

/**
 * On a project that releases through change requests a mark lands nothing by itself: only what the
 * host holds does (REQ-71). A mark stands there on the host merge Forge holds for a request linking
 * the issue, on a `commit` that is a merge commit the host reported, or on a `commit` the host's
 * `target` branch contains, read through the binding (`hostBranchLanding`); each is stamped as that
 * landing. Any other is refused by name, never stamped as a local claim nothing reads as landed, and
 * a host that cannot be read refuses it too. Null elsewhere. A design approval's stamp is the
 * approval's own write (`design-landing.ts`), not this door's.
 */
export async function hostMergeOfMark(
  args: { commit?: string | undefined; target?: string | undefined },
  prior: Pick<IssueRow, 'id' | 'projectId'>,
): Promise<HostMerge | null> {
  if (!releaseThroughChangeRequests((await readProjectDocument(prior.projectId))?.document)) {
    return null;
  }
  const host =
    (await observedMergeForIssue(db, prior.id)) ??
    (await hostMergeNamed(prior.projectId, args.commit));
  if (host) return host;
  if (args.commit && args.target) {
    return hostBranchLanding(prior, args.commit, args.target);
  }
  throw refuse(
    'MARK_NOT_A_HOST_MERGE',
    `${HOST_ONLY} This mark names ${args.commit ? 'no `target`' : 'no `commit`'} to check on the host, and Forge holds no host merge of a change request linking this issue. Name the \`commit\` and the \`target\` branch on the host that contains it, or: ${OPEN_A_REQUEST}`,
    args.commit ? '/target' : '/commit',
  );
}
