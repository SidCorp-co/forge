/**
 * A reporter's reply to an answer, and an answer to a reply or reopen (REQ-47 r2 BC-12, BC-13), as
 * pure functions over what `reply.ts` read under the item's lock. One reply per answer, and an answer
 * to a reopened item names the reopen or reply it answers, so neither side writes past the other.
 */

import type {
  FeedbackPhase,
  FeedbackRefusal,
  FeedbackRoute,
  FeedbackStatus,
  FeedbackTriageRoute,
} from '@forge/contracts/feedback';
import { refusal } from './rules.js';

/** The reopen or reply an item stands on while it reads reopened: its latest such decision. */
export interface StandingReply {
  id: string;
  decision: 'reopened' | 'replied';
  said: string | null;
  at: Date;
}

const SAID_MAX = 200;

/** What the standing reopen or reply said, clipped for a refusal's one line. */
function saidOf(s: StandingReply): string {
  const said = (s.said ?? '').replace(/\s+/g, ' ').trim();
  if (!said) return 'nothing';
  return said.length > SAID_MAX ? `"${said.slice(0, SAID_MAX - 1)}…"` : `"${said}"`;
}

const named = (s: StandingReply) =>
  `the ${s.decision === 'replied' ? 'reply' : 'reopen'} ${s.id} of ${s.at.toISOString()}, which said ${saidOf(s)}`;

/**
 * The reporter replies to the item's standing answer, once (BC-12): an item already back with the
 * triager has spent its reply, and an item whose standing route is not an answer has none to reply to.
 */
export function replyRefusal(
  key: string,
  item: { status: FeedbackStatus; route: FeedbackRoute | null; phase: FeedbackPhase },
  standing: StandingReply | null,
  evidence: string | undefined,
): FeedbackRefusal | null {
  if (item.status === 'reopened') {
    return refusal(
      'FEEDBACK_REPLY_SPENT',
      '/feedback',
      `${key} is already back with its triager on ${standing ? named(standing) : 'a reopen'}; one reply per answer, so the next one follows its next answer.`,
    );
  }
  if (item.status !== 'triaged' || item.route !== 'answer') {
    const shipped =
      item.phase === 'resolved' ? ' Its fix shipped: verify it, or reopen it with evidence.' : '';
    return refusal(
      'FEEDBACK_REPLY_NO_ANSWER',
      '/feedback',
      `${key} reads ${item.phase} and stands on no answer, so there is nothing to reply to.${shipped}`,
    );
  }
  if (!evidence?.trim()) {
    return refusal(
      'FEEDBACK_EVIDENCE_REQUIRED',
      '/evidence',
      'a reply says what the answer leaves open, with what you ran and saw.',
    );
  }
  return null;
}

/**
 * An answer to a reopened item names the reopen or reply it answers, the one standing now (BC-13):
 * none named on a reopened item, or one named that does not stand, is refused before anything is
 * written. `inReplyTo` belongs to the answer route alone.
 */
export function answerAddressRefusal(
  key: string,
  route: FeedbackTriageRoute | undefined,
  inReplyTo: string | undefined,
  standing: StandingReply | null,
): FeedbackRefusal | null {
  if (inReplyTo !== undefined && route !== 'answer') {
    return refusal(
      'FEEDBACK_ROUTE_TARGET_MISMATCH',
      '/inReplyTo',
      `\`inReplyTo\` names the reopen or reply an answer answers; route ${route ?? 'issue'} takes none.`,
    );
  }
  if (route !== 'answer') return null;
  if (!standing) {
    return inReplyTo === undefined
      ? null
      : refusal(
          'FEEDBACK_ANSWER_STALE',
          '/inReplyTo',
          `${key} stands on no reopen or reply now, so ${inReplyTo} is answered already or never was; read the item again and answer it as it stands, without \`inReplyTo\`.`,
        );
  }
  if (inReplyTo === undefined) {
    return refusal(
      'FEEDBACK_ANSWER_UNADDRESSED',
      '/inReplyTo',
      `${key} was sent back on ${named(standing)}; answer that, naming it with \`inReplyTo: "${standing.id}"\`.`,
    );
  }
  if (inReplyTo !== standing.id) {
    return refusal(
      'FEEDBACK_ANSWER_STALE',
      '/inReplyTo',
      `${inReplyTo} is not what ${key} stands on now: it stands on ${named(standing)}; read it, then answer that one.`,
    );
  }
  return null;
}
