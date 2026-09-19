export interface OpenedConversation {
  id: string;
  shape: 'direct' | 'group';
  externalId: string;
}

/**
 * A window that has been claimed and is ready to route.
 */
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
