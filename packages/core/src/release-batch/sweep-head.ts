// What the release sweep reads before it cuts (ISS-968): which gate issues outside the roster it would
// send the head production builds already carries.
//
// A release run reports the head it cut, and a head carrying the landing of a gate issue outside its
// roster is refused RELEASE_RANGE_OUTSIDE_ROSTER (ISS-962, `shipped-range.ts:recordRange`). Where
// production deploys on land, that head is the head of the branch production deploys from, and every
// commit under it is already landed: agenfold's sweep cut ISS-161 alone twice (0.129.0, 0.130.0) while
// main carried ISS-160, held for an unearned criterion, and both runs aborted at their range report.
// So the sweep takes the same reading first, by the same rule (`range-outside.ts:readOutsideLandings`),
// and does not cut a roster that reading refuses.
//
// It waits; it does not cut with the held issue held back. The head carries the held landing, so no
// release deployed from it can hold that issue back: a record saying it did would be false, and the
// only roster the range check passes carries it. Carrying an issue whose criterion is unearned is a
// hand start's act and not the sweep's: a start that names its roster is never weighed for criteria
// (`blockers.ts:gatedBlockers` weighs only an unnamed roster), so the gates the sweep passes would not
// treat the held issue as the manual start did. The wait is one hold on each issue the cut would have
// carried, naming the held issue, its own hold and what clears it, written once while it stands.
//
// Where the head or an issue's ancestry cannot be read, the issue is `unchecked` with why, as the
// range check keeps it, and the cut goes on: the range check reads it again at the run's report, and
// only a reading that places the landing under the head refuses.

import type { ReleaseHoldOwer, ReleaseHoldView } from '@forge/contracts/releases';
import { RELEASE_ROSTER_LIMIT } from '@forge/contracts/releases';
import { resolveSourceHost, SourceHostUnavailable } from '../integrations/source-host/index.js';
import { agrees } from '../lib/plural.js';
import { readDeclaredSource, readLandingBranches } from '../project-config/index.js';
import { readCheckoutHead } from '../runners/index.js';
import type { ReleaseHold } from './hold.js';
import {
  type OutsideIssue,
  type OutsideRead,
  outsideGateIssues,
  placeOutsideOf,
} from './range-outside.js';
import { rangeBaseOf } from './shipped-range.js';

/** The head production would build, or why it could not be read. */
export type ProductionHead = { branch: string; sha: string } | { why: string };

/**
 * The head of the branch production deploys from (the branch a promotion carries work to, or the
 * branch work lands on): asked of the source host, or, where none is bound, of a box holding the
 * project's checkout. A host binding that exists and cannot serve stays its own reason.
 */
async function readProductionHead(projectId: string): Promise<ProductionHead> {
  const branches = await readLandingBranches(projectId);
  const branch = branches.promoted ?? branches.defaultBranch;
  if (!branch) {
    return {
      why: 'the project document names no branch production deploys from (source.git.defaultBranch)',
    };
  }
  let unbound: string;
  try {
    const host = await resolveSourceHost(projectId, 'kernel');
    return { branch, sha: (await host.branchHead(branch)).toLowerCase() };
  } catch (err) {
    if (!(err instanceof SourceHostUnavailable)) {
      return { why: `the source host would not read ${branch}'s head: ${messageOf(err)}` };
    }
    if (err.reason !== 'no_binding' && err.reason !== 'local_repository')
      return { why: err.message };
    unbound = err.message;
  }
  const { repository } = await readDeclaredSource(projectId);
  if (!repository) return { why: `${unbound}, and the project declares no repository` };
  const read = await readCheckoutHead(projectId, branch, repository);
  if (!read.ok) return { why: `${unbound}, and ${read.detail}` };
  return { branch, sha: read.head.sha.toLowerCase() };
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The one door the head is read through, held as an object so an integration world can plant it. */
export const productionHead = { read: readProductionHead };

/** The reading the sweep takes before it cuts `eligible`, with the head it was taken against. */
export interface SweepRange extends OutsideRead {
  head: ProductionHead | null;
}

/**
 * Of the gate issues outside the roster the sweep would send (`eligible`, cut to the roster limit as
 * `cutWaitingRelease` cuts it), those the head production builds carries. No head is read where
 * nothing waits outside the roster.
 */
export async function readSweepRange(
  projectId: string,
  eligible: readonly string[],
): Promise<SweepRange> {
  const roster = { issueIds: eligible.slice(0, RELEASE_ROSTER_LIMIT) };
  const outside = await outsideGateIssues(projectId, roster);
  if (outside.length === 0) return { carried: [], unchecked: [], head: null };
  const head = await productionHead.read(projectId);
  if ('why' in head) return { ...(await placeOutsideOf(projectId, outside, null, head)), head };
  const { base } = await rangeBaseOf(projectId, null);
  return { ...(await placeOutsideOf(projectId, outside, base, head.sha)), head };
}

const short = (sha: string | null) => (sha ?? '').slice(0, 7);

function heldClause(issue: OutsideIssue, hold: ReleaseHoldView | undefined): string {
  const landed = `${issue.key} (landed at ${short(issue.commit)})`;
  if (!hold) return `${landed}, which records no hold of its own at the gate`;
  return `${landed}, held ${hold.code}, waiting for ${hold.waitingFor}`;
}

/**
 * The hold on each issue the sweep would have cut, while the head production builds carries a gate
 * issue outside that roster: what it waits on, that issue's own hold, and the two acts that end it.
 */
export function headCarriesHeldHold(args: {
  projectId: string;
  head: { branch: string; sha: string };
  carried: readonly OutsideIssue[];
  holds: ReadonlyMap<string, ReleaseHoldView>;
  owes: ReleaseHoldOwer;
}): ReleaseHold {
  const { carried } = args;
  const n = carried.length;
  const keys = carried.map((i) => i.key).join(', ');
  const it = agrees(n, 'it', 'them');
  const each = carried.map((i) => heldClause(i, args.holds.get(i.id))).join('; ');
  const who = args.owes === 'human' ? 'a person' : "the project's master";
  return {
    code: 'RELEASE_HEAD_CARRIES_HELD',
    reason:
      `The head production builds, ${short(args.head.sha)} of \`${args.head.branch}\`, already ` +
      `carries the landing of ${n} ${agrees(n, 'issue', 'issues')} held at the release gate: ${each}. ` +
      `A release cut without ${it} would ship ${it} unrecorded, so its range report is refused ` +
      `(RELEASE_RANGE_OUTSIDE_ROSTER) and it aborts; the automatic release waits instead of cutting ` +
      `one known to abort. It ends when ${agrees(n, 'that hold clears', 'those holds clear')} (for an ` +
      `unearned criterion, its verdict), and the next sweep carries ${it} with this issue; or when ` +
      `${who} cuts the release by hand naming ${keys} with this issue ` +
      `(POST /api/projects/${args.projectId}/release-batches), which ships ${it} owing what ` +
      `${agrees(n, 'its hold names', 'their holds name')}.`,
    owes: args.owes,
    waitingFor: `${keys} to clear ${agrees(n, 'its hold', 'their holds')}, or a release cut by hand naming ${agrees(n, 'it', 'them')}`,
  };
}
