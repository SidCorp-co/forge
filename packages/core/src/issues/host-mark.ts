import type { MergeRefusalCode } from '@forge/contracts/issues';
import { releaseThroughChangeRequests } from '@forge/contracts/releases';
import { db } from '../db/client.js';
import { RefusalError, refuser } from '../lib/refusal.js';
import { hostMergeNamed } from './host-landing.js';
import { observedMergeForIssue } from './merge-record.js';
import {
  isSourceHostUnavailable,
  readLandingBranches,
  readProjectDocument,
  resolveSourceHost,
} from './ports.js';
import type { IssueRow } from './read-service.js';

/** A landing the host holds: the commit, when it landed there, and the branch it landed on. */
export type HostMerge = { commitSha: string; mergedAt: Date; target: string };

const refuse = refuser<MergeRefusalCode>('MERGE_MARK_REFUSED');

const HOST_ONLY =
  'This project releases through change requests, so a merge mark lands nothing by itself: only what the host holds does.';
const OPEN_A_REQUEST =
  'Open or update a change request that links this issue (its branch or description naming it); once the release is approved, the master merges it through `POST /api/issues/:id/merge-pull-request`, and that merge records the landing.';

/**
 * The mark's `commit` as the host holds it on the project's `target` branch, read through the
 * binding. It is stamped at the moment the host was read holding it there: the commit's own date is
 * when it was written, which can be long before it reached the branch.
 */
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
    if (read && (await host.branchContains(target, read.sha))) {
      return { commitSha: read.sha, mergedAt: new Date(), target };
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
 * host holds on the project's target branch (`source.git.defaultBranch`) does (REQ-71, ISS-672). A
 * mark stands there on the host merge into that branch Forge holds for a request linking the issue,
 * on a `commit` that is the merge commit of a request the host reported merged into it, or on a
 * `commit` the branch contains, read through the binding (`hostBranchLanding`); each is stamped as
 * that landing. A mark naming another branch, and any other mark, is refused by name, never stamped
 * as a local claim nothing reads as landed, and a host that cannot be read refuses it too. Null
 * elsewhere. A design approval's stamp is the approval's own write (`design-landing.ts`).
 */
export async function hostMergeOfMark(
  args: { commit?: string | undefined; target?: string | undefined },
  prior: Pick<IssueRow, 'id' | 'projectId'>,
): Promise<HostMerge | null> {
  if (!releaseThroughChangeRequests((await readProjectDocument(prior.projectId))?.document)) {
    return null;
  }
  const { defaultBranch: target } = await readLandingBranches(prior.projectId);
  if (!target) {
    throw refuse(
      'MARK_NOT_A_HOST_MERGE',
      `${HOST_ONLY} The project document names no \`source.git.defaultBranch\`, so no branch on the host is a landing. Declare it (PUT /api/projects/${prior.projectId}/config), or: ${OPEN_A_REQUEST}`,
      '/target',
    );
  }
  if (args.target && args.target !== target) {
    throw refuse(
      'MARK_NOT_A_HOST_MERGE',
      `${HOST_ONLY} The mark names \`${args.target}\`, and this project, which lands on \`${target}\`, counts work as landed only once it is on that branch on the host. Mark naming \`${target}\`, or: ${OPEN_A_REQUEST}`,
      '/target',
    );
  }
  const host =
    (await observedMergeForIssue(db, prior.id, target)) ??
    (await hostMergeNamed(prior.projectId, args.commit, target));
  if (host) return host;
  if (args.commit && args.target) {
    return hostBranchLanding(prior, args.commit, target);
  }
  throw refuse(
    'MARK_NOT_A_HOST_MERGE',
    `${HOST_ONLY} This mark names ${args.commit ? 'no `target`' : 'no `commit`'} to check on the host, and Forge holds no host merge into \`${target}\` of a change request linking this issue. Name the \`commit\` and the \`target\` \`${target}\` that contains it, or: ${OPEN_A_REQUEST}`,
    args.commit ? '/target' : '/commit',
  );
}
