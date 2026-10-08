// Whose turn an agreed requirement is once its issues exist and none of the earlier rules in
// `standing.ts:turnOf` holds: the party it actually waits on, never "its issues" while nobody is
// working them (ISS-461 round 3). First rule wins:
// 1. an issue parked (`PARK_STATUSES`) → what that issue waits on, by its own standing, its key linked;
// 2. every issue not yet shipped has landed (`awaiting_release`) → whoever owes the release cut (or the
//    release itself where the project releases on its own), the version linked;
// 3. an issue in progress → the issues, running a of b;
// 4. an issue open, approved or reopened with none of the above → the master, which takes them next;
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

/** What a parked issue waits on, as its own standing says it. */
export type ParkedWait = WaitingOn<IssueWaitingKind>;

/** A live issue as this rule reads it: its key, its status and, where it is parked, its own wait. */
export interface WorkIssue {
  displayId: string;
  status: string;
  /** Its own standing's wait where it is parked (`PARK_STATUSES`); null otherwise. */
  parkedOn: ParkedWait | null;
}

interface Turn {
  group: RequirementAttentionGroup;
  waitingOn: RequirementWaitingOn;
}

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

function parkedTurn(parked: readonly WorkIssue[]): Turn {
  const [first] = parked;
  if (!first?.parkedOn) {
    throw new Error(
      `requirements: ${first?.displayId ?? 'an issue'} is parked but its own wait was not read; standing-read.ts gathers it for every parked issue`,
    );
  }
  const w = first.parkedOn;
  const kind = KIND_OF[w.kind];
  return {
    group: groupOf(kind),
    waitingOn: wait(
      kind,
      {
        who: w.says.who,
        act: say('standing.act.onIssue', { act: w.says.act, key: first.displayId }),
        rule: say('requirements.rule.parked', {
          keys: parked.map((i) => i.displayId).join(', '),
          key: first.displayId,
          rule: w.says.rule,
        }),
      },
      { refers: 'issue', ref: first.displayId },
    ),
  };
}

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
