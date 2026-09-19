import type { DoorId, MessageVerdict } from './contract.js';
import type { MessageFacts } from './facts.js';
import { judgedSegments, screenAtDoor } from './screen.js';

declare const admittedByADoor: unique symbol;

export interface ProvenMessage {
  readonly [admittedByADoor]: true;
  readonly text: string;
  readonly door: DoorId;
}

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
export function reframed(message: ProvenMessage, framed: string): ProvenMessage | null {
  if (!framed.includes(message.text)) return null;
  return { text: framed, door: message.door } as ProvenMessage;
}

/**
 * Screen a message at a door and mint its proof in one step.
 */
export function screenForDoor(
  door: DoorId,
  message: RoomMessage,
  facts?: MessageFacts,
): { ok: true; proven: ProvenMessage } | { ok: false; verdict: MessageVerdict } {
  const verdict = screenAtDoor(door, message.screened, facts);
  const admitted = proven(door, message, verdict);
  return admitted ? { ok: true, proven: admitted } : { ok: false, verdict };
}
