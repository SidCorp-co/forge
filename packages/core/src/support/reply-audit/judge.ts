// The verdict on one reply a room agent audited (ISS-1250): its own reading against the one rubric
// (`@forge/contracts/support-reply-audit`), with each line code can tell checked beside it
// (`code-lines.ts`: grant talk, a direction to a screen, an API-host link) and the reply-language
// reading. Code adds what the agent missed so the record is true; it decides nothing
// about the reply, which was already posted.

import type { SupportRoomKind } from '@forge/contracts/support-operations';
import type {
  ReplyFinding,
  ReplyRubricLine,
  ReplyVerdict,
  SupportAuditRequest,
} from '@forge/contracts/support-reply-audit';
import { confidentLanguageOf } from '../../conversations/index.js';
import { liveClaimIn } from '../live-claims.js';
import type { AnsweringFrom, AnsweringLanguage } from './answering-language.js';
import {
  apiHostLinkIn,
  grantTalkIn,
  liveStateClaimIn,
  screenClaimIn,
  uiDirectionIn,
  workaroundIn,
} from './code-lines.js';

/**
 * The reads of live state around a reply (ISS-1354): whether its own turn made one, and when the
 * session last made one in an earlier turn (null where none). A declared read, a run, a release or
 * deployment read and a look at a screen each count; `looked` is whether its turn looked at a screen
 * (ISS-1356).
 */
export interface TurnReads {
  thisTurn: boolean;
  earlierAt: Date | null;
  looked: boolean;
}

export interface AuditedReply {
  /** The reply as posted. */
  text: string;
  /**
   * The language the room is answered in, and where it was read (`answering-language.ts`): never the
   * project's content language, which is for Forge's records (ISS-1377).
   */
  language: AnsweringLanguage;
  roomKind: SupportRoomKind;
  /** The API's public hosts no person-facing link may point at (`code-lines.ts:apiHosts`). */
  apiHosts: readonly string[];
  /** The reads around the reply, where its turn is on the record; absent, none is judged. */
  reads?: TurnReads | undefined;
}

export interface Judgement {
  verdict: ReplyVerdict;
  failed: ReplyRubricLine[];
  findings: ReplyFinding[];
}

const LANGUAGE_NAME = { vi: 'Vietnamese', en: 'English' } as const;

/** What the reply was held to, said with where that language was read. */
const HELD_TO: Readonly<Record<AnsweringFrom, (language: string) => string>> = {
  asker: (l) => `the person it answers wrote in ${l}`,
  persona: (l) => `the room's persona names ${l}`,
  room: (l) => `the room's people write in ${l}`,
};

/** The rubric lines code tells on its own, each with the words that failed it. */
export function codeFindings(reply: AuditedReply): ReplyFinding[] {
  const found: ReplyFinding[] = [];
  const grant = grantTalkIn(reply.text);
  if (grant) found.push({ line: 'no_grant_talk', why: `it says "${grant}"`, by: 'code' });
  const direction = uiDirectionIn(reply.text, reply.roomKind === 'operations');
  if (direction) {
    found.push({ line: 'no_ui_directions', why: `it says "${direction}"`, by: 'code' });
  }
  const link = apiHostLinkIn(reply.text, reply.apiHosts);
  if (link) found.push({ line: 'web_links', why: `${link} is on the API host`, by: 'code' });
  const stale = staleStateClaim(reply);
  if (stale) found.push({ line: 'accurate', why: stale, by: 'code' });
  const unseen = unseenScreenClaim(reply);
  if (unseen) found.push({ line: 'accurate', why: unseen, by: 'code' });
  const workaround = workaroundIn(reply.text);
  if (workaround) {
    found.push({
      line: 'no_ui_directions',
      why: `it sends a workaround step ("${workaround}"): a screen that needs one goes to the project's master as a UI defect`,
      by: 'code',
    });
  }
  const written = confidentLanguageOf(reply.text);
  const held = reply.language;
  if (written && written !== held.language) {
    found.push({
      line: 'language',
      why: `it is in ${LANGUAGE_NAME[written]}, and ${HELD_TO[held.from](LANGUAGE_NAME[held.language])}`,
      by: 'code',
    });
  }
  return found;
}

/**
 * Why a reply's statement of a live setting, account or release rests on no read of this turn
 * (ISS-1354): one made in an earlier turn, or none. Null where it states none, or this turn read.
 */
function staleStateClaim(reply: AuditedReply): string | null {
  if (!reply.reads || reply.reads.thisTurn) return null;
  const claim = liveStateClaimIn(reply.text) ?? liveClaimIn(reply.text);
  if (!claim) return null;
  return reply.reads.earlierAt
    ? `it states "${claim}" from a read made in an earlier turn (${reply.reads.earlierAt.toISOString()}), not one made in this turn`
    : `it states "${claim}" with no read of it made in this turn`;
}

/**
 * Why a reply's claim about what a screen shows was made with no look at it in its turn (ISS-1356):
 * it has to see it to say it. Null where it makes none, or its turn looked.
 */
function unseenScreenClaim(reply: AuditedReply): string | null {
  if (!reply.reads || reply.reads.looked) return null;
  const claim = screenClaimIn(reply.text);
  return claim ? `it says what a screen shows ("${claim}") and this turn took no look at it` : null;
}

/**
 * The verdict: every line the agent failed, and every line code found that the agent did not name;
 * a pass only where neither failed one.
 */
export function judgeReply(reply: AuditedReply, reading: SupportAuditRequest['failed']): Judgement {
  const own: ReplyFinding[] = reading.map((f) => ({ line: f.line, why: f.why, by: 'agent' }));
  const missed = codeFindings(reply).filter((c) => !own.some((o) => o.line === c.line));
  const findings = [...own, ...missed];
  const failed = [...new Set(findings.map((f) => f.line))];
  return { verdict: failed.length > 0 ? 'fail' : 'pass', failed, findings };
}
