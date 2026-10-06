// What a `needs_info` park still waits on once its question was answered (ISS-258): read from what
// the answer said (its hold, ISS-257) and what the answer resume recorded it did. The blocker and
// the standing both word it from here, so the banner and the list cannot disagree.

import type { ParkAnsweredView } from '@forge/contracts/park';

export interface AnsweredWait {
  /** Whom it waits on, in the standing's vocabulary. */
  on: 'person' | 'run' | 'issue' | 'master';
  /** The blocking issue's key, where it waits on one. */
  ref: string | null;
  /** The few words a list shows. */
  act: string;
  /** One sentence: what it still waits on. */
  reason: string;
  /** Who acts next, and how. */
  who: string;
}

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const RESUME_IT = 'Resume it from the status menu once it can go on.';

export function answeredWait(answered: Pick<ParkAnsweredView, 'hold' | 'resume'>): AnsweredWait {
  const { hold, resume } = answered;
  if (hold?.blockedBy) {
    return {
      on: 'issue',
      ref: hold.blockedBy.key,
      act: `wait on ${hold.blockedBy.key}`,
      reason: `Its question was answered, and the answer says it still waits on ${hold.blockedBy.key}: ${hold.reason}`,
      who: `${hold.blockedBy.key} settles first; its blocks edge holds this issue until then.`,
    };
  }
  if (hold) {
    return {
      on: 'person',
      ref: null,
      act: `resume once: ${clip(hold.reason, 80)}`,
      reason: `Its question was answered, and the answer says it still waits: ${hold.reason}`,
      who: `A person resumes it once that wait is over. ${RESUME_IT}`,
    };
  }
  switch (resume?.kind) {
    case 'sent_to_run':
      return {
        on: 'run',
        ref: null,
        act: 'read the answer',
        reason: `Its question was answered, and the answer went to the run that asked (session ${resume.sessionId}).`,
        who: 'That run moves the issue on once it reads the answer.',
      };
    case 'box_reads':
      return {
        on: 'run',
        ref: null,
        act: 'read the answer back',
        reason: 'Its question was answered, and a box registered to read that answer back.',
        who: 'The run on that box moves the issue on once it reads the answer.',
      };
    case 'other_question':
      return {
        on: 'master',
        ref: null,
        act: 'answer the other question',
        reason: `Its question was answered, and another question on it is still open (${resume.questionIds.join(', ') || 'unnamed'}).`,
        who: 'It moves on once that question is answered.',
      };
    case 'no_left_status':
      return {
        on: 'person',
        ref: null,
        act: 'move it on',
        reason:
          'Its question was answered, and nothing recorded the status this park left, so the answer could not return it.',
        who: `A person names where it goes. ${RESUME_IT}`,
      };
    case 'staged':
      return {
        on: 'person',
        ref: null,
        act: 'resume it',
        reason:
          'Its question was answered; this project is not autonomous, so an answer moves nothing.',
        who: `A person resumes it where it stopped. ${RESUME_IT}`,
      };
    case 'refused':
      return {
        on: 'person',
        ref: null,
        act: `move it on: ${resume.code}`,
        reason: `Its question was answered, and returning it to work was refused: ${resume.code} — ${resume.detail}`,
        who: `Clear what the refusal names, then move it on. ${RESUME_IT}`,
      };
    default:
      return {
        on: 'person',
        ref: null,
        act: 'resume it',
        reason: 'Its question was answered, and nothing recorded what the answer did to it.',
        who: `A person resumes it where it stopped. ${RESUME_IT}`,
      };
  }
}
