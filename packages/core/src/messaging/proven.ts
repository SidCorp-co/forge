/**
 * The text a door admitted, and the verdict that admitted it, as one value.
 *
 * A verdict says a screen passed. It does not say WHAT it passed, so a verdict
 * travelling beside a string proves nothing about that string — which is how
 * five reply paths came to post a rendered message under a screen run over
 * something else. A `ProvenMessage` carries the exact string that may be sent,
 * and the outbound door compares it against what it is about to send (ISS-978).
 */

import type { DoorId, MessageVerdict } from './contract.js';
import type { MessageFacts } from './facts.js';
import { judgedSegments, screenAtDoor } from './screen.js';

declare const admittedByADoor: unique symbol;

/**
 * A string a door's screen admitted.
 */
// cm:guard NOMINAL, and the brand is what makes it so: `admittedByADoor` is a module-private `unique
// symbol`, so `proven` below is the only thing anywhere that can produce one of these. That is the
// half of ISS-978 F5 the type system enforces — the other half, that the screened segments cover
// every model-written part of `text`, is NOT enforced here and cannot be: `agentAuthoredSegments`
// legitimately screens more than a round renders (a fingerprint on an option that does not bind to
// one call is judged and never printed), so a containment check would refuse rounds that are right.
// What covers it instead is that the ask door and the delivery door read ONE segment list — the
// `cm:edge` on `question-render.ts` — so a part that reaches a room unscreened is a part missing
// from that list rather than a pairing anyone chose at a call site.
export interface ProvenMessage {
  readonly [admittedByADoor]: true;
  /** The exact string that may be sent. Anything else is a different message. */
  readonly text: string;
  /** Which door's screen admitted it, so a mismatch can name where the proof came from. */
  readonly door: DoorId;
}

/** What is being sent, and which parts of it a model wrote. */
export interface RoomMessage {
  /** Exactly what goes out. */
  readonly text: string;
  /** The parts of `text` a model wrote — what the screen reads. */
  readonly screened: readonly string[];
}

/** A message that is model text end to end: the whole of it is screened. */
export function wholeAgentText(text: string): RoomMessage {
  return { text, screened: [text] };
}

/**
 * The one mint. `null` on anything but an `ok` verdict.
 */
// cm:guard the verdict cannot be forged — `MessageVerdict`'s `ok` arm is nominal since ISS-978, so
// reaching this function with a passing verdict means a screen ran. Before that, `proven(door, msg,
// { ok: true })` would have compiled anywhere in the tree and this mint would have been decoration.
// cm:guard and the verdict must have been passed over THESE segments, which the nominal flag alone
// cannot say: a genuine verdict for one string would otherwise mint a proof for another — screen A,
// call `proven(door, wholeAgentText(B), verdictForA)`, and B goes out under A's screening with no cast
// anywhere. That is the ISS-978 F5 pairing moved rather than closed, and this comparison is what
// closes it (whole-set review F2).
export function proven(
  door: DoorId,
  message: RoomMessage,
  verdict: MessageVerdict,
): ProvenMessage | null {
  if (!verdict.ok) return null;
  const judged = judgedSegments(verdict);
  if (!judged || !sameSegments(judged, message.screened)) return null;
  return { text: message.text, door } as ProvenMessage;
}

const sameSegments = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((s, i) => s === b[i]);

/**
 * The same admitted text inside a frame this codebase wrote.
 */
// cm:guard the frame must CONTAIN the admitted text, checked here rather than trusted: an addressee
// prefix is ours to add and the answer underneath it is the model's, but a "frame" that replaced or
// truncated the admitted string would be a different message carrying an older message's proof. Null
// where it does not contain it, and the caller is refused at the door rather than posting anyway.
export function reframed(message: ProvenMessage, framed: string): ProvenMessage | null {
  if (!framed.includes(message.text)) return null;
  return { text: framed, door: message.door } as ProvenMessage;
}

/**
 * Screen a message at a door and mint its proof in one step.
 */
// cm:guard the mint and the screen in ONE call is the point: a caller that screens in one place and
// mints in another is a caller that can pair the wrong two, which is the defect this whole file
// answers. Callers whose screen is asynchronous or gathers facts (`screenReplyAtDoor`, `withRepairs`)
// pass their own passing verdict to `proven` instead, and the nominal `ok` arm is what keeps that
// honest.
export function screenForDoor(
  door: DoorId,
  message: RoomMessage,
  facts?: MessageFacts,
): { ok: true; proven: ProvenMessage } | { ok: false; verdict: MessageVerdict } {
  const verdict = screenAtDoor(door, message.screened, facts);
  const admitted = proven(door, message, verdict);
  return admitted ? { ok: true, proven: admitted } : { ok: false, verdict };
}
