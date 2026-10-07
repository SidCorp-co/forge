// What a `needs_info` park still waits on once its question was answered (ISS-258): read from what
// the answer said (its hold, ISS-257) and what the answer resume recorded it did. The blocker and
// the standing both word it from here, so the banner and the list cannot disagree.

import type { ParkAnsweredView } from '@forge/contracts/park';
import { type Said, say, verbatim } from '@forge/contracts/said';

export interface AnsweredWait {
  /** Whom it waits on, in the standing's vocabulary. */
  on: 'person' | 'run' | 'issue' | 'master';
  /** The blocking issue's key, where it waits on one. */
  ref: string | null;
  /** The few words a list shows. */
  act: Said;
  /** One sentence: what it still waits on. */
  reason: Said;
  /** Who acts next, and how. */
  who: Said;
}

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

export function answeredWait(answered: Pick<ParkAnsweredView, 'hold' | 'resume'>): AnsweredWait {
  const { hold, resume } = answered;
  if (hold?.blockedBy) {
    const key = hold.blockedBy.key;
    return {
      on: 'issue',
      ref: key,
      act: say('issues.standing.act.waitOn', { key }),
      reason: say('issues.blocker.waitsOnKey', { key, why: hold.reason }),
      who: say('issues.blocker.whoSettles', { key }),
    };
  }
  if (hold) {
    return {
      on: 'person',
      ref: null,
      act: say('issues.standing.act.resumeOnce', { why: verbatim(clip(hold.reason, 80)) }),
      reason: say('issues.blocker.stillWaits', { why: hold.reason }),
      who: say('issues.blocker.whoWaitOver'),
    };
  }
  switch (resume?.kind) {
    case 'sent_to_run':
      return {
        on: 'run',
        ref: null,
        act: say('issues.standing.act.readAnswer'),
        reason: say('issues.blocker.sentToRun', { id: resume.sessionId }),
        who: say('issues.blocker.whoRunReads'),
      };
    case 'box_reads':
      return {
        on: 'run',
        ref: null,
        act: say('issues.standing.act.readAnswerBack'),
        reason: say('issues.blocker.boxReads'),
        who: say('issues.blocker.whoBoxReads'),
      };
    case 'other_question':
      return {
        on: 'master',
        ref: null,
        act: say('issues.standing.act.answerOther'),
        reason:
          resume.questionIds.length > 0
            ? say('issues.blocker.otherQuestion', { ids: resume.questionIds.join(', ') })
            : say('issues.blocker.otherQuestionUnnamed'),
        who: say('issues.blocker.whoOtherQuestion'),
      };
    case 'no_left_status':
      return {
        on: 'person',
        ref: null,
        act: say('issues.standing.act.moveOn'),
        reason: say('issues.blocker.noLeftStatus'),
        who: say('issues.blocker.whoNamesWhere'),
      };
    case 'staged':
      return {
        on: 'person',
        ref: null,
        act: say('issues.standing.act.resume'),
        reason: say('issues.blocker.staged'),
        who: say('issues.blocker.whoResumes'),
      };
    case 'refused':
      return {
        on: 'person',
        ref: null,
        act: say('issues.standing.act.moveOnRefused', { code: resume.code }),
        reason: say('issues.blocker.refused', { code: resume.code, detail: resume.detail }),
        who: say('issues.blocker.whoRefused'),
      };
    default:
      return {
        on: 'person',
        ref: null,
        act: say('issues.standing.act.resume'),
        reason: say('issues.blocker.unrecorded'),
        who: say('issues.blocker.whoResumes'),
      };
  }
}
