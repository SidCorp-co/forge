/**
 * The claimed window row the connection-manager suites drive `routeOne` with.
 *
 * Four suites collect a message and then route the window it opened, because
 * that pair is what production runs; each of them needs the same row, and a
 * fourth copy of it is a field that can drift in one file and not the others.
 */

export interface OpenedConversation {
  id: string;
  shape: 'direct' | 'group';
  externalId: string;
}

/**
 * A window that has been claimed and is ready to route.
 */
// cm:guard `claimedAt` and `claimedBy` are BOTH set, because together they are the claim token every write the router makes is fenced on: a fixture missing either would make `routeWindow` refuse the window outright rather than test anything (ISS-1004).
export function claimedWindowFor(
  opened: OpenedConversation,
  projectId: string,
  lastSeq: number,
): Record<string, unknown> {
  return {
    id: `win:${opened.id}`,
    conversationId: opened.id,
    projectId,
    adapter: 'rocketchat',
    venueExternalId: opened.externalId,
    venueShape: opened.shape,
    openedAt: new Date(),
    extendedAt: new Date(),
    firstSeq: 0,
    lastSeq,
    claimedAt: new Date(),
    claimedBy: 'test',
    deliveryReservedAt: null,
    closedAt: null,
    decision: null,
    decisionDetail: null,
  };
}
