// The words a stuck-work notice is written in, as a person reads it on the bell (REQ-12 BC-6,
// ISS-1184): what got stuck and how, in plain words, then what was seen and what to do. Where the
// loop stuck (`hop`), the entity's raw id and the detector's labels stay in the log, never on the
// row: forge-dev's bell read "Pipeline wedge: claim hop miss on session". Migration 0646 rewrote
// the rows written in the old words to these, so the bell holds one wording.

export const WEDGE_HOPS = ['ack', 'claim', 'heartbeat', 'result', 'dispatch'] as const;
export type WedgeHop = (typeof WEDGE_HOPS)[number];

export const WEDGE_ENTITIES = ['job', 'session', 'run', 'issue', 'capacity', 'runner'] as const;
export type WedgeEntity = (typeof WEDGE_ENTITIES)[number];

/** What got stuck, as the title's subject. */
export const WEDGE_SUBJECT: Record<WedgeEntity, string> = {
  job: 'A job',
  session: 'An agent session',
  run: 'A run',
  issue: 'An issue',
  capacity: 'Work for the project’s runners',
  runner: 'A runner',
};

/** How it got stuck, after its subject. */
export const WEDGE_HOW: Record<WedgeHop, string> = {
  ack: 'was handed out and never confirmed',
  claim: 'was never picked up by a machine',
  heartbeat: 'stopped answering',
  result: 'ended without reporting a result',
  dispatch: 'is waiting and nothing starts it',
};

/** The notice's title where its caller names none: "An agent session was never picked up by a machine". */
export const wedgeTitle = (hop: WedgeHop, entity: WedgeEntity): string =>
  `${WEDGE_SUBJECT[entity]} ${WEDGE_HOW[hop]}`;

const sentence = (s: string) => {
  const t = s.trim();
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}`;
};

/** The notice's body where its caller gives no summary: what the detector saw, then what to do. */
export const wedgeBody = (ev: { reason: string; action: string }): string =>
  [sentence(ev.reason), `Next: ${ev.action}`].join('\n');
