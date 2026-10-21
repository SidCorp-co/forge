// Whose turn an agreed requirement is once its issues exist and none of the earlier rules in
// `standing.ts:turnOf` holds: the party it actually waits on, never "its issues" while nobody is
// working them (ISS-461 round 3). First rule wins:
// 0. an issue whose own standing reads stuck (not by a blocker, which is read itself) → its wait,
//    carried up so the requirement reads stuck by it, the oldest stuck first (REQ-48 BC-9);
// 1. an issue parked (`PARK_STATUSES`) → what that issue waits on, by its own standing, its key linked;
// 2. every issue not yet shipped has landed (`awaiting_release`) → whoever owes the release cut (or the
//    release itself where the project releases on its own), the version linked;
// 3. an issue in progress → the issues, running a of b;
// 4. an issue open, approved or reopened with none of the above → the master, which takes them next,
//    since the oldest of them came to wait (`withTimes` reads it stuck where no master serves);
// 5. else (every one shipped with nothing else owed) → the issues, shipped a of b.
// Each is the workflow design's last `turn` condition (requirement-to-delivery r11: "otherwise →
// moving"), so the group stays moving; only the wait is named, as the step asks of every result
// (BC-19), and it reads Needs you only for the viewer it names (BC-22).

import type { ReleaseLeg } from '@forge/contracts/forecast';
import { PARK_STATUSES } from '@forge/contracts/issue-machine';
import type { IssueWaitingKind } from '@forge/contracts/issue-standing';
import type {
  RequirementAttentionGroup,
  RequirementWaitingKind,
  RequirementWaitingOn,
  RequirementWaitRefers,
} from '@forge/contracts/requirements';
import { type Said, say } from '@forge/contracts/said';
import { type WaitingOn, waitingOn } from '@forge/contracts/standing';
import type { StuckReading } from '@forge/contracts/steward';
import type { Carried } from '../lib/standing-times.js';

/** What a parked issue waits on, as its own standing says it. */
export type ParkedWait = WaitingOn<IssueWaitingKind>;

/** An unshipped issue's own standing, as the roll-up reads it (`issues/standing.ts`). */
export interface OwnStanding {
  waitingOn: ParkedWait;
  since: Date;
  stuck: StuckReading | null;
}

/** A live issue as this rule reads it: its key, its status and, where it is parked, its own wait. */
export interface WorkIssue {
  displayId: string;
  status: string;
  /** Its own standing's wait where it is parked (`PARK_STATUSES`); null otherwise. */
  parkedOn: ParkedWait | null;
  /** Its own standing while it is not shipped; null where it was not read (shipped, dropped). */
  own?: OwnStanding | null;
}

/** A turn and what `withTimes` reads beyond it: the issue it was carried from, and since when it waits. */
export interface WorkTurn {
  group: RequirementAttentionGroup;
  waitingOn: RequirementWaitingOn;
  carried?: Carried | null;
  since?: Date | null;
  /** The draft issue it waits on to be taken on, where its only unshipped issues are drafts. */
  draftCarrier?: string | null;
}

type Turn = WorkTurn;

/** An issue's party as a requirement's: the runs, the master and the judge are all agents to it. */
const KIND_OF: Record<IssueWaitingKind, RequirementWaitingKind> = {
  you: 'you',
  person: 'person',
  run: 'agent',
  master: 'agent',
  judge: 'agent',
  issue: 'issue',
  release: 'release',
  none: 'none',
};

const wait = (
  kind: RequirementWaitingKind,
  says: { who: Said; act: Said; rule: Said },
  about?: { refers: RequirementWaitRefers; ref: string | null },
): RequirementWaitingOn => ({
  ...waitingOn(kind, says, { ref: about?.ref ?? null }),
  ...(about ? { refers: about.refers } : {}),
});

const groupOf = (kind: RequirementWaitingKind): RequirementAttentionGroup =>
  kind === 'you' ? 'needs_you' : 'moving';

/** The requirement's wait on one of its issues, said as that issue's own wait (`standing.act.onIssue`). */
function onIssue(
  first: WorkIssue,
  w: ParkedWait,
  keys: readonly WorkIssue[],
  rule: 'requirements.rule.parked' | 'requirements.rule.carried',
): Turn {
  const kind = KIND_OF[w.kind];
  return {
    group: groupOf(kind),
    waitingOn: wait(
      kind,
      {
        who: w.says.who,
        act: say('standing.act.onIssue', { act: w.says.act, key: first.displayId }),
        rule: say(rule, {
          keys: keys.map((i) => i.displayId).join(', '),
          key: first.displayId,
          rule: w.says.rule,
        }),
      },
      { refers: 'issue', ref: first.displayId },
    ),
  };
}

function parkedTurn(parked: readonly WorkIssue[]): Turn {
  const [first] = parked;
  if (!first?.parkedOn) {
    throw new Error(
      `requirements: ${first?.displayId ?? 'an issue'} is parked but its own wait was not read; standing-read.ts gathers it for every parked issue`,
    );
  }
  return onIssue(first, first.parkedOn, parked, 'requirements.rule.parked');
}

/** The unshipped issues stuck by their own standing, oldest first; a blocked one is left to its blocker. */
function stuckIssues(unshipped: readonly WorkIssue[]) {
  return unshipped
    .flatMap((i) =>
      i.own?.stuck && i.own.stuck.code !== 'blocked' && i.status !== 'draft'
        ? [{ issue: i, own: i.own, stuck: i.own.stuck }]
        : [],
    )
    .sort((a, b) => a.stuck.since.localeCompare(b.stuck.since));
}

/** The oldest since of `issues`' own waits; null where none was read. */
const oldestSince = (issues: readonly WorkIssue[]): Date | null =>
  issues.reduce<Date | null>(
    (at, i) => (i.own && (at === null || i.own.since < at) ? i.own.since : at),
    null,
  );

function releaseTurn(leg: ReleaseLeg, landed: number): Turn {
  const about = { refers: 'release' as const };
  if (leg.kind !== 'person') {
    return {
      group: 'moving',
      waitingOn: wait(
        'release',
        {
          who: say('issues.standing.who.release'),
          act: say('issues.standing.act.nextRelease'),
          rule: say('requirements.rule.allLanded', {
            n: landed,
            reason: say('requirements.rule.releasesOnItsOwn'),
          }),
        },
        { ...about, ref: null },
      ),
    };
  }
  const kind = leg.says.who.key === 'standing.who.you' ? 'you' : 'person';
  return {
    group: groupOf(kind),
    waitingOn: wait(
      kind,
      {
        who: leg.says.who,
        act: leg.says.act,
        rule: say('requirements.rule.allLanded', { n: landed, reason: leg.says.reason }),
      },
      { ...about, ref: leg.version },
    ),
  };
}

/**
 * The turn of a requirement whose live issues exist and are not all drafts. `release` is what follows
 * a landing, read only where every issue not yet shipped has landed; it is a gather defect, refused
 * by name, for it to be missing there.
 */
export function workTurn(live: readonly WorkIssue[], release: ReleaseLeg | null): Turn {
  const unshipped = live.filter((i) => i.status !== 'closed');
  const stuck = stuckIssues(unshipped);
  const [carrier] = stuck;
  if (carrier) {
    return {
      ...onIssue(
        carrier.issue,
        carrier.own.waitingOn,
        stuck.map((s) => s.issue),
        'requirements.rule.carried',
      ),
      carried: { key: carrier.issue.displayId, stuck: carrier.stuck },
      since: carrier.own.since,
    };
  }
  const parked = unshipped.filter((i) => (PARK_STATUSES as readonly string[]).includes(i.status));
  if (parked.length > 0) return parkedTurn(parked);
  const landed = unshipped.filter((i) => i.status === 'awaiting_release');
  if (unshipped.length > 0 && landed.length === unshipped.length) {
    if (!release) {
      throw new Error(
        `requirements: ${landed.map((i) => i.displayId).join(', ')} all await release but the release was not read; standing-read.ts reads it whenever every unshipped issue has landed`,
      );
    }
    return releaseTurn(release, landed.length);
  }
  const running = unshipped.filter((i) => i.status === 'in_progress').length;
  if (running > 0) {
    return {
      group: 'moving',
      waitingOn: wait('issue', {
        who: say('standing.who.issues'),
        act: say('standing.act.running', { a: running, b: live.length }),
        rule: say('requirements.rule.moving'),
      }),
    };
  }
  const queued = unshipped.filter((i) => i.status !== 'awaiting_release' && i.status !== 'draft');
  if (queued.length > 0) {
    const keys = queued.map((i) => i.displayId).join(', ');
    return {
      group: 'moving',
      waitingOn: wait('agent', {
        who: say('standing.who.master'),
        act: say('standing.act.takeNext', { keys }),
        rule: say('requirements.rule.queued', { keys }),
      }),
      since: oldestSince(queued),
    };
  }
  return {
    group: 'moving',
    waitingOn: wait('issue', {
      who: say('standing.who.issues'),
      act: say('standing.act.shippedOf', { a: live.length - unshipped.length, b: live.length }),
      rule: say('requirements.rule.moving'),
    }),
  };
}

/** Whether a requirement's issues all landed and only the release is left, so its gather reads the release. */
export const awaitsReleaseOnly = (live: readonly { status: string }[]): boolean => {
  const unshipped = live.filter((i) => i.status !== 'closed' && i.status !== 'dropped');
  return unshipped.length > 0 && unshipped.every((i) => i.status === 'awaiting_release');
};
