// What holds a release not yet shipped, as a room's release read hands it to the agent (ISS-1009):
// whom it waits on and for what, since when, the approval it owes and who may give it, each issue it
// carries that is not ready and why, and the next step with its owner. Every fact is the release
// page's own answer (`GET /api/projects/:id/releases/:version`: its standing, its gates, its
// approval), never a second computation; whom its act goes to is the steward's one reading
// (`steward/release-ask.ts:releaseTakerOf`) of that page's wait, which names the master for a draft
// it cuts (`release-view.ts:draftTurn`, ISS-1043), as Needs you leaves it. sidpeak's rooms (FB-516, FB-517, FB-537, FB-539) read only a draft's state and
// issue count, tried to approve an uncut draft, and asked Forge to cut it. The agent restates this in
// the room's words: it carries no refusal code for people to read. A wait that is the project's
// delivery work (a cut, a record) reads as what it waits for, never whose act it is
// (ISS-1483): the room says what is waiting and how long, and a person is named only where one owes it.

import type { ReleaseDetail, ReleaseProof } from '@forge/contracts/releases';
import { readRelease } from '../release-batch/index.js';
import { heldStewardOf, releaseTakerOf } from '../steward/index.js';
import { NO_PERSON, roomPerson, roomSay, roomWaits } from './room-voice.js';

/** What holds one release not yet shipped, in words the agent restates to a person. */
export interface ReleaseHold {
  /** Who owes the next act, by name where a person or Forge's release run does; `nobody needs to be asked` where it is delivery work. */
  waitsOn: string;
  /** What they owe, lower case after the name. */
  owes: string;
  /** `waits to cut 0.22.0, since 2026-11-06T08:45:04.000Z (35 minutes)`, or `waits on Lan to approve 0.22.0, since …`. */
  says: string;
  since: string;
  /** How long it has waited, in words. */
  waited: string;
  /** Why it waits so, as the release page says it. */
  why: string;
  /** Each reason that stands against it going out, with a person who owes its act where one does. */
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
  'A deploy or release done outside Forge shows here only once it is recorded on the project, so a release waiting here does not mean nothing is happening. Say how long it has waited and what it waits for (and a person by name where one owes it), never that it is stuck or that nobody is working on it.';

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
    "a go or no a person says in chat is recorded on the release at once with support.release_decision citing their own message (the owner's is kept until his account is named), never through support.record, and never approved by you";
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
export function notReadyOf(r: ReleaseDetail): ReleaseHold['notReady'] {
  const blockers = r.gates.filter((g) => g.kind === 'blocker');
  return r.contents.flatMap((group) =>
    group.issues.flatMap((issue) => {
      const why = [
        ...blockers
          .filter((g) => g.issues.includes(issue.key))
          .map((g) => roomSay(g.says.sentence)),
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
    taker.to === 'master' || taker.to === 'system'
      ? NO_PERSON
      : taker.to === 'holders'
        ? names(taker.holders)
        : taker.to === 'nobody'
          ? 'nobody'
          : (roomPerson(wait.says.who) ?? NO_PERSON);
  const waitAct = roomSay(wait.says.act);
  const owes = taker.to === 'nobody' ? `${waitAct} (${taker.why})` : waitAct;
  const waited = waitedFor(r.at, now);
  const route =
    'if the person wants it moved, record that on this project with support.record, never approve or decide it yourself';
  const next =
    taker.to === 'master' || taker.to === 'system'
      ? `it is waiting to ${owes} and nobody has to be asked: say that and how long, and ${route}`
      : taker.to === 'holders'
        ? `ask ${waitsOn} to ${owes} in Forge; mention only the one the channel lists for it`
        : taker.to === 'nobody'
          ? `nobody can ${owes} yet: ${route}`
          : `it is waiting to ${owes}: nothing is owed by a person`;
  return {
    waitsOn,
    owes,
    says:
      waitsOn === NO_PERSON
        ? `waits to ${owes}, since ${r.at} (${waited})`
        : `waits on ${waitsOn} to ${owes}, since ${r.at} (${waited})`,
    since: r.at,
    waited,
    why:
      waitsOn === NO_PERSON
        ? `merged issues wait at the release gate for this step: ${owes}`
        : roomSay(wait.says.rule),
    blockers: r.gates
      .filter((g) => g.kind === 'blocker')
      .map((g) => ({
        says: roomSay(g.says.sentence),
        owner: roomWaits(g.owner.says.who, g.owner.says.act),
        issues: g.issues,
      })),
    approval: approvalOf(r),
    notReady: notReadyOf(r),
    next,
  };
}
