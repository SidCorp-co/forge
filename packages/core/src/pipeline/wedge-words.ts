// The words a stuck-work notice is written in: its title and its body, from where the loop stuck
// (`hop`), on what (`entity`), what the detector saw and what to do.

export const WEDGE_HOPS = ['ack', 'claim', 'heartbeat', 'result', 'dispatch'] as const;
export type WedgeHop = (typeof WEDGE_HOPS)[number];

export const WEDGE_ENTITIES = ['job', 'session', 'run', 'issue', 'capacity', 'runner'] as const;
export type WedgeEntity = (typeof WEDGE_ENTITIES)[number];

/** The notice's title where its caller names none. */
export const wedgeTitle = (hop: WedgeHop, entity: WedgeEntity): string =>
  `Pipeline wedge: ${hop} hop miss on ${entity}`;

/** The notice's body where its caller gives no summary: what the detector saw, and what to do. */
export const wedgeBody = (ev: { reason: string; action: string }): string =>
  [`WHY: ${ev.reason}`, `WHAT: ${ev.action}`].join('\n');
