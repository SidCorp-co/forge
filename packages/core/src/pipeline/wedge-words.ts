/**
 * What a stuck-work notice says when the detector that raised it gave no words of its own: a title
 * and a body a person reads, by which part of the work stopped and what it was. The detector's own
 * reason stays in the log, where its vocabulary belongs (ISS-1228).
 */

export type WedgeWordsHop = 'ack' | 'claim' | 'heartbeat' | 'result' | 'dispatch';

export interface WedgeWords {
  title: string;
  body: string;
}

const BY_HOP_AND_ENTITY: Readonly<Record<string, WedgeWords>> = {
  'ack:job': {
    title: 'A box never took up work it was sent',
    body: 'Core sent this work to a box, and the box never said it had taken it. Check that the box is online and its runner is running.',
  },
  'claim:session': {
    title: 'No box started a session it was given',
    body: 'Core gave this session to a box, and nothing on that box started it in time. Check that a box bound to this project is online.',
  },
  'claim:job': {
    title: 'No box took up this work',
    body: 'This work waited for a box, and none took it up in time. Check that a box bound to this project is online.',
  },
  'heartbeat:session': {
    title: 'A session stopped checking in',
    body: "This session stopped reporting to core while it was meant to be working. Open the session's page to see what it last reported, and check its box.",
  },
  'heartbeat:job': {
    title: 'Work stopped checking in',
    body: 'The work on this step stopped reporting to core. Check the box it was running on.',
  },
  'result:job': {
    title: 'Work went quiet without finishing',
    body: "The work on this step has said nothing for a long time and has not reported how it ended. Open the step's session to see what it last did, and cancel the work if it is stuck.",
  },
  'dispatch:job': {
    title: 'Work could not be sent to a box',
    body: 'Core could not hand this work to any box. Check that a box bound to this project is online.',
  },
};

const FALLBACK: WedgeWords = {
  title: 'Work has stopped moving',
  body: 'Core found work that has stopped moving and could not tell why. Open it to see what it last reported.',
};

export function wedgeWordsFor(hop: WedgeWordsHop, entity: string): WedgeWords {
  return BY_HOP_AND_ENTITY[`${hop}:${entity}`] ?? FALLBACK;
}

/** A notice's body from a detector's own words: what is wrong, then the next step on a line of its own. */
export function wedgeBody(summary: string, nextStep?: string | null): string {
  return nextStep ? `${summary}\nNext: ${nextStep}` : summary;
}
