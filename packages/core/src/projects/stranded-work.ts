import { and, asc, eq, isNotNull, isNull, notInArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import {
  type Lane,
  landingShortfall,
  laneOrNull,
  whereItLands,
} from '../issues/landing-evidence.js';
import { ISSUE_TERMINAL_STATUSES } from '../issues/status-sets.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import type { ReleaseChain } from './release-chain.js';

export const RELEASE_CHAIN_STRANDS_WORK = 'RELEASE_CHAIN_STRANDS_WORK';
export const PROJECT_KIND_STRANDS_WORK = 'PROJECT_KIND_STRANDS_WORK';

/** How many keys a refusal names before it says how many more there are. */
export const STRANDED_NAMED_MAX = 10;

/** A project write that would leave work its project can no longer finish, refused by name. */
export interface StrandedWork {
  code: typeof RELEASE_CHAIN_STRANDS_WORK | typeof PROJECT_KIND_STRANDS_WORK;
  message: string;
  details: {
    issues: string[];
    total: number;
    status?: 'awaiting_release';
    /** On the kind refusal: the kinds the write moves between, and the landing shape each issue
     *  declares to stay on the lane its mark was written for. */
    from?: string;
    to?: string;
    landingShape?: Lane['shape'];
  };
}

function named(keys: string[]): string {
  const shown = keys.slice(0, STRANDED_NAMED_MAX).join(', ');
  const more = keys.length - STRANDED_NAMED_MAX;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/** The refusal for emptying a chain while issues wait for the release it would stop. */
export function chainStrandsWork(waiting: string[]): StrandedWork {
  const n = waiting.length;
  return {
    code: RELEASE_CHAIN_STRANDS_WORK,
    message:
      `${RELEASE_CHAIN_STRANDS_WORK}: this write empties the release chain, so the project would ship nothing, ` +
      `while ${n} of its issues wait${n === 1 ? 's' : ''} at Awaiting release for a release: ${named(waiting)}. ` +
      (n === 1
        ? 'With an empty chain no release is ever cut for it, so it would wait for good. ' +
          'Release it first, or return it to Developed, and then empty the chain. ' +
          'Closing it is not a way out: a close records the work as shipped and unblocks every issue that depends on it.'
        : 'With an empty chain no release is ever cut for them, so they would wait for good. ' +
          'Release them first, or return each one to Developed, and then empty the chain. ' +
          'Closing them is not a way out: a close records the work as shipped and unblocks every issue that depends on it.'),
    details: { issues: waiting, total: n, status: 'awaiting_release' },
  };
}

/** The refusal for a kind change that would make marks already written stop counting as landings. */
export function kindStrandsWork(args: {
  from: string;
  to: string;
  was: Lane;
  marked: { key: string; why: string }[];
}): StrandedWork {
  const n = args.marked.length;
  const keys = args.marked.map((m) => m.key);
  const examples = args.marked
    .slice(0, 3)
    .map((m) => `${m.key}: ${m.why}`)
    .join('; ');
  return {
    code: PROJECT_KIND_STRANDS_WORK,
    message:
      `${PROJECT_KIND_STRANDS_WORK}: this write changes the project's kind from \`${args.from}\` to \`${args.to}\`, ` +
      `and ${n} unclosed issue${n === 1 ? '' : 's'} declaring no landing shape of ${n === 1 ? 'its' : 'their'} own ` +
      `carr${n === 1 ? 'ies' : 'y'} a merge mark that counts as a landing today and would not after it: ${named(keys)}. ` +
      `Today ${whereItLands(args.was)}; after this write ${n === 1 ? 'that mark stops' : 'those marks stop'} counting, with nothing said (${examples}). ` +
      'For each one, in this order: withdraw its mark (`DELETE /api/issues/:id/merge`, or `forge_issues` `unmark`), ' +
      `declare \`landingShape: ${args.was.shape}\` (\`PATCH /api/issues/:id\`, or \`forge_issues\` \`update\`), and mark it merged again; ` +
      'a landing shape is not taken while a mark stands. Each one is then judged on the lane its mark was written for, and the kind can change.',
    details: { issues: keys, total: n, from: args.from, to: args.to, landingShape: args.was.shape },
  };
}

/** The refusal a project write earns for the work it would strand, or `null`. Only the two writes
 *  whose effect on existing work is silent are judged: a chain taken from some branches to none,
 *  and a kind change. A body naming neither is not this rule's business. */
export async function strandedWorkFor(
  projectId: string,
  updates: { releaseChain?: ReleaseChain | undefined; kind?: string | undefined },
): Promise<StrandedWork | null> {
  const emptiesChain = updates.releaseChain !== undefined && updates.releaseChain.length === 0;
  if (!emptiesChain && updates.kind === undefined) return null;
  const [row] = await db
    .select({
      releaseChain: projects.releaseChain,
      kind: projects.kind,
      issuePrefix: projects.issuePrefix,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  const keyOf = (issSeq: number) => formatIssueRef(row.issuePrefix, issSeq);

  if (emptiesChain && row.releaseChain.length > 0) {
    const waiting = await db
      .select({ issSeq: issues.issSeq })
      .from(issues)
      .where(and(eq(issues.projectId, projectId), eq(issues.status, 'awaiting_release')))
      .orderBy(asc(issues.issSeq));
    if (waiting.length > 0) return chainStrandsWork(waiting.map((w) => keyOf(w.issSeq)));
  }

  // A kind Forge does not know judged no mark as a landing, so moving off it strands none.
  const was = laneOrNull(null, row.kind);
  const to = updates.kind === undefined ? null : laneOrNull(null, updates.kind);
  if (was && to && was.shape !== to.shape) {
    const marked = await db
      .select({
        issSeq: issues.issSeq,
        mergedAt: issues.mergedAt,
        mergedCommitSha: issues.mergedCommitSha,
        mergedLanding: issues.mergedLanding,
        mergedClaimedCommit: issues.mergedClaimedCommit,
      })
      .from(issues)
      .where(
        and(
          eq(issues.projectId, projectId),
          isNull(issues.declaredLandingShape),
          isNotNull(issues.mergedAt),
          notInArray(issues.status, [...ISSUE_TERMINAL_STATUSES]),
        ),
      )
      .orderBy(asc(issues.issSeq));
    const refused = marked.flatMap((m) => {
      const why = landingShortfall(m, to);
      return why === null || landingShortfall(m, was) !== null
        ? []
        : [{ key: keyOf(m.issSeq), why }];
    });
    if (refused.length > 0) {
      return kindStrandsWork({ from: row.kind, to: updates.kind as string, was, marked: refused });
    }
  }
  return null;
}
