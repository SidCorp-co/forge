import type { HoldOutcome } from './channel-holds.js';
import type { InboxEntry, PartyView, threadAs } from './channel-read.js';
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

export const inboxView = (entries: readonly InboxEntry[]) =>
  entries.map((e) => ({
    ...viewOf(e),
    hold: e.hold,
    owesReply: e.owesReply,
    answered: e.answered,
    overdue: e.overdue,
  }));

export const outboxView = (views: readonly PartyView[]) =>
  views.map((v) => ({ ...viewOf(v), hold: v.hold }));

export const threadView = (t: Awaited<ReturnType<typeof threadAs>>) => ({
  thread: t.thread,
  documents: t.documents.map((v) => ({ ...viewOf(v), side: v.side })),
  holds: t.holds,
});

export const holdView = (thread: string, held: Extract<HoldOutcome, { ok: true }>) => ({
  thread,
  held: held.held,
  hold: held.hold,
});
