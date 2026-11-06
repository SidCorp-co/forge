// What holds a release not yet shipped, as a room's release read hands it to the agent (ISS-1009):
// whom it waits on and for what, since when, the approval it owes and who may give it, each issue it
// carries that is not ready and why, and the next step with its owner. Every fact is the release
// page's own answer (`GET /api/projects/:id/releases/:version`: its standing, its gates, its
// approval), never a second computation; whom its act goes to is the steward's one reading
// (`steward/release-ask.ts:releaseTakerOf`), so a draft the master cuts reads as the master's, as
// Needs you leaves it. sidpeak's rooms (FB-516, FB-517, FB-537, FB-539) read only a draft's state and
// issue count, tried to approve an uncut draft, and asked Forge to cut it. The agent restates this in
// the room's words: it carries no refusal code for people to read.

import type { ReleaseDetail, ReleaseProof } from '@forge/contracts/releases';
import { readRelease } from '../release-batch/index.js';
import { heldStewardOf, releaseTakerOf } from '../steward/index.js';

/** What holds one release not yet shipped, in words the agent restates to a person. */
export interface ReleaseHold {
  /** Who owes the next act, by name: the project's master, a person, or Forge's own release run. */
  waitsOn: string;
  /** What they owe, lower case after the name. */
  owes: string;
  /** `waits on the project's master to cut 0.22.0, since 2026-11-06T08:45:04.000Z (35 minutes)`. */
  says: string;
  since: string;
  /** How long it has waited, in words. */
  waited: string;
  /** Why it waits so, as the release page says it. */
  why: string;
  /** Each reason that stands against it going out, with whoever owes its act. */
  blockers: { says: string; owner: string; issues: string[] }[];
  /** The approval it owes or carries, who may give it, and where one said in chat goes. */
  approval: string;
  /** Each issue it carries that is not ready, and why. */
  notReady: { issue: string; title: string; why: string }[];
  /** The next step and its owner. */
  next: string;
}

/**
 * What Forge cannot read, said once beside every hold: a deploy it was never told of shows only once
 * recorded, so a hold never says nothing is happening.
 */
export const UNSEEN =
  "Forge reads only what is recorded on it: a deploy or release done outside Forge shows here once the project's master records it, so a release waiting here does not mean nothing is happening. Say how long it has waited and whose act it waits on, never that it is stuck or that nobody is working on it.";

const PROOF_WHY: Partial<Record<ReleaseProof, string>> = {
  failing: 'a criterion failed when it was judged',
  open: 'its criteria are not all judged yet',
  unproven: 'its criteria were judged, but not every pass counts for this release yet',
};

/** `35 minutes`, `3 hours`, `2 days`. */
function waitedFor(since: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(since)) / 60_000));
  const [n, unit] =
    minutes < 120
      ? [minutes, 'minute']
      : minutes < 48 * 60
        ? [Math.round(minutes / 60), 'hour']
        : [Math.round(minutes / 1440), 'day'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

const names = (people: readonly { name: string }[]) => people.map((p) => p.name).join(', ');

/** The approval a release owes or carries, as its page records it. */
function approvalOf(r: ReleaseDetail): string {
  const chat =
    "an approval said in chat counts only once recorded on the release: tell the project's master (support.record), who records it, never approve it yourself";
  const decided = r.approval?.decision ? r.approval : null;
  if (decided?.decidedBy && decided.decidedAt) {
    const said = decided.decision === 'approved' ? 'approved' : 'returned';
    return `${said} by ${decided.decidedBy.name} at ${decided.decidedAt}${decided.reason ? `: ${decided.reason}` : ''}`;
  }
  if (r.draftApproval) {
    return `${r.draftApproval.decision} by ${r.draftApproval.decidedBy.name} at ${r.draftApproval.decidedAt}${r.draftApproval.reason ? `: ${r.draftApproval.reason}` : ''}`;
  }
  const who =
    r.approvers.length > 0
      ? `${names(r.approvers)} may give it`
      : 'nobody on the project may give it yet: a project admin grants it';
  if (r.approval) {
    return `asked by ${r.approval.requestedBy.name} at ${r.approval.requestedAt}, not yet given: ${who}; ${chat}`;
  }
  if (!r.approvalRequired) return 'none is required before it goes out';
  if (r.state === 'draft') {
    return `owed once it is cut, not before: ${who}; ${chat}`;
  }
  return `owed: ${who}; ${chat}`;
}

/** Each issue the release carries that is not ready: named by a reason against it, or not yet proven. */
function notReadyOf(r: ReleaseDetail): ReleaseHold['notReady'] {
  const blockers = r.gates.filter((g) => g.kind === 'blocker');
  return r.contents.flatMap((group) =>
    group.issues.flatMap((issue) => {
      const why = [
        ...blockers.filter((g) => g.issues.includes(issue.key)).map((g) => g.sentence),
        ...(PROOF_WHY[issue.proof] ? [PROOF_WHY[issue.proof] as string] : []),
      ];
      return why.length > 0 ? [{ issue: issue.key, title: issue.title, why: why.join('; ') }] : [];
    }),
  );
}

/** What holds this release, read from its page as the room reads it (no viewer of its own). */
export async function releaseHoldOf(
  projectId: string,
  version: string,
  now = new Date(),
): Promise<ReleaseHold> {
  const r = await readRelease(projectId, version, null);
  const wait = r.waitingOn;
  const taker = await releaseTakerOf(projectId, wait, await heldStewardOf(projectId));
  const waitsOn =
    taker.to === 'master'
      ? wait.kind === 'agent' && wait.says.who.key !== 'standing.who.master'
        ? wait.who
        : "the project's master"
      : taker.to === 'holders'
        ? names(taker.holders)
        : taker.to === 'nobody'
          ? 'nobody'
          : wait.who;
  const owes = taker.to === 'nobody' ? `${wait.act} (${taker.why})` : wait.act;
  const waited = waitedFor(r.at, now);
  const route =
    "route it to the project's master (support.record on this project), never approve or decide it yourself";
  const next =
    taker.to === 'master'
      ? `ask ${waitsOn} to ${owes}: ${route}`
      : taker.to === 'holders'
        ? `ask ${waitsOn} to ${owes} in Forge; mention only the one the channel lists for it`
        : taker.to === 'nobody'
          ? `nobody can ${owes} yet: ${route}`
          : `${waitsOn} is on it (${owes}): nothing is owed by a person`;
  // the page names the admins who may cut; outside strict the master takes the cut, as Needs you reads it
  const why =
    taker.to === 'master' && wait.kind !== 'agent'
      ? `${wait.rule}; on this project the master takes that act`
      : wait.rule;
  return {
    waitsOn,
    owes,
    says: `waits on ${waitsOn} to ${owes}, since ${r.at} (${waited})`,
    since: r.at,
    waited,
    why,
    blockers: r.gates
      .filter((g) => g.kind === 'blocker')
      .map((g) => ({
        says: g.sentence,
        owner: `${g.owner.who} to ${g.owner.act}`,
        issues: g.issues,
      })),
    approval: approvalOf(r),
    notReady: notReadyOf(r),
    next,
  };
}
