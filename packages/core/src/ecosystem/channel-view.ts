import type { ServedDocument } from './channel-world.js';

/** A served document as both doors answer it: the document, and every event on it with who did it and through what. */
export const viewOf = (s: ServedDocument) => ({
  id: s.id,
  document: s.document,
  events: s.events.map((e) => ({
    verb: e.verb,
    from: e.fromState,
    to: e.toState,
    by: { kind: e.actorKind, id: e.actorId, via: e.actorVia },
    ...(e.reason ? { reason: e.reason } : {}),
    ...(e.supersededBy ? { supersededBy: e.supersededBy } : {}),
    at: e.at.toISOString(),
  })),
});
