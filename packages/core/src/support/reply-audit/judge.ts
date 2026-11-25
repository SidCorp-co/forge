// The verdict on one reply a room agent audited (ISS-1250): its own reading against the one rubric
// (`@forge/contracts/support-reply-audit`), with each line code can tell checked beside it
// (`code-lines.ts`: grant talk, a direction to a screen, an API-host link). The reply's language is
// no line code tells (ISS-1451: a guess at it is a hint, never a finding). Code adds what the agent
// missed so the record is true; it decides nothing about the reply, which was already posted.

import type { SupportRoomKind } from '@forge/contracts/support-operations';
import type {
  ReplyFinding,
  ReplyRubricLine,
  ReplyVerdict,
  SupportAuditRequest,
} from '@forge/contracts/support-reply-audit';
import { LIVE_CLAIM_RE } from '../live-claims.js';
import {
  actClaimIn,
  apiHostLinkIn,
  assertedStateClaimIn,
  behaviourClaimIn,
  grantTalkIn,
  namesMaster,
  screenClaimIn,
  servedClaimIn,
  uiDirectionIn,
  workaroundIn,
} from './code-lines.js';

/**
 * The reads of live state around a reply (ISS-1354): whether its own turn made one, and when the
 * session last made one in an earlier turn (null where none). A declared read, a run, a release or
 * deployment read and a look at a screen each count; `looked` is whether its turn looked at a screen
 * (ISS-1356), and `handedOn` whether an act landed somewhere else: a raise, a route, an ask or a
 * filing (ISS-1416, `dated-reads.ts:handedOn`), in its turn or earlier in its thread (ISS-1423).
 * `masterAnswered` is whether a master's answer to the room's ask was handed in its turn
 * (`master-ask.ts:masterAnsweredNote`): his fresh check of what he reports, said as his (ISS-1430).
 */
export interface TurnReads {
  thisTurn: boolean;
  earlierAt: Date | null;
  looked: boolean;
  handedOn: boolean;
  masterAnswered?: boolean;
  /**
   * Whether its turn read what a deployment serves (a release or deployment read, or a note core
   * handed in after reading one), and whether it read the product itself (a look, a read or a run)
   * (ISS-1440). Unset, the turn's own read stands for both, as before.
   */
  servedRead?: boolean;
  behaviourRead?: boolean;
}

export interface AuditedReply {
  /** The reply as posted. */
  text: string;
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
  const unlanded = unlandedActClaim(reply);
  if (unlanded) found.push({ line: 'accurate', why: unlanded, by: 'code' });
  const workaround = workaroundIn(reply.text);
  if (workaround) {
    found.push({
      line: 'no_ui_directions',
      why: `it sends a workaround step ("${workaround}"): a screen that needs one goes to the project's master as a UI defect`,
      by: 'code',
    });
  }
  return found;
}

const RECORD_HINT = /\b(?:issues?|tickets?|release|ISS-\d+|v?\d+\.\d+\.\d+)\b|phát\s+hành/iu; // i18n-allow: the Vietnamese noun of a release
const RECORD_READ =
  ": a Forge issue's or release's status needs a read of it now (support.issues or support.releases)";
const STATE_READ =
  ': read it again in this turn (support.read) before stating it, or say plainly it is not checked now';

/** What the turn read of the one thing a claim is about; a reply with no turn on the record is not judged. */
const readOf = (reads: TurnReads, kind: 'served' | 'behaviour'): boolean =>
  (kind === 'served' ? reads.servedRead : reads.behaviourRead) ?? reads.thisTurn;

const SERVED_READ =
  ': what a deployment serves is read in this turn with support.releases or support.deployment, quoting the version it returns, or said plainly not confirmed now';
const BEHAVIOUR_READ =
  ': how the product behaves is read in this turn (support.look, support.read or a run), or said plainly not confirmed now; a master’s answer is his report, said as his and when he made it, never as your own read';

/**
 * Why a reply's statement of a live setting, account, release, served version or product behaviour
 * rests on no read of this turn (ISS-1354, ISS-1440): one made in an earlier turn, or none, whether or
 * not the reply dates it. A state the reply says plainly it has not checked now is no statement of it.
 * A master's answer handed in the turn is his check, so it covers a claim only where the reply says
 * it as his (`namesMaster`); it is never the agent's read of a product. Null where it states none.
 */
function staleStateClaim(reply: AuditedReply): string | null {
  const reads = reply.reads;
  if (!reads) return null;
  const hisCheck = Boolean(reads.masterAnswered) && namesMaster(reply.text);
  const why = (claim: string, read: string) =>
    reads.earlierAt
      ? `it states "${claim}" from a read made in an earlier turn (${reads.earlierAt.toISOString()}), not one made in this turn${read}`
      : `it states "${claim}" with no read of it made in this turn${read}`;
  if (!reads.thisTurn && !hisCheck) {
    const claim = assertedStateClaimIn(reply.text, [LIVE_CLAIM_RE]);
    if (claim) return why(claim, RECORD_HINT.test(claim) ? RECORD_READ : STATE_READ);
  }
  if (!readOf(reads, 'served') && !hisCheck) {
    const claim = servedClaimIn(reply.text, [LIVE_CLAIM_RE]);
    if (claim) return why(claim, SERVED_READ);
  }
  if (!readOf(reads, 'behaviour') && !hisCheck) {
    const claim = behaviourClaimIn(reply.text);
    if (claim) return why(claim, BEHAVIOUR_READ);
  }
  return null;
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
 * Why a reply's report of an act it took (a raise, a post elsewhere) has no result behind it
 * (ISS-1416, FB-824): "raised in AdminHub API's thread" when that raise was refused. Null where it
 * reports none, or an act landed in its turn or earlier in its thread (ISS-1423).
 */
function unlandedActClaim(reply: AuditedReply): string | null {
  if (!reply.reads || reply.reads.handedOn) return null;
  const claim = actClaimIn(reply.text);
  return claim
    ? `it says "${claim}" and no act landed in this turn or earlier in this thread: report an act from its result, refused or landed and where`
    : null;
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
