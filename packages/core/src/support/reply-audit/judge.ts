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
import type { AnsweringFrom, AnsweringLanguage } from './answering-language.js';
import { apiHostLinkIn, grantTalkIn, uiDirectionIn } from './code-lines.js';

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
