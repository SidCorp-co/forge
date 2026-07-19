import { beforeEach, describe, expect, it } from 'vitest';
import { wsClient } from './client';

// `rooms` is private (ref-counted Map, ISS-689) — cast to reach it for
// assertions rather than adding a test-only public accessor.
function rooms(): Map<string, number> {
  return (wsClient as unknown as { rooms: Map<string, number> }).rooms;
}

describe('ForgeWebSocket room ref-counting', () => {
  beforeEach(() => {
    rooms().clear();
  });

  it('keeps a room subscribed while any caller still holds it', () => {
    wsClient.subscribe('project:1');
    wsClient.subscribe('project:1');
    expect(rooms().get('project:1')).toBe(2);

    wsClient.unsubscribe('project:1');
    expect(rooms().get('project:1')).toBe(1);
  });

  it('drops the room only once every subscriber has unsubscribed', () => {
    wsClient.subscribe('project:2');
    wsClient.subscribe('project:2');
    wsClient.unsubscribe('project:2');
    wsClient.unsubscribe('project:2');
    expect(rooms().has('project:2')).toBe(false);
  });

  it('does not go negative when unsubscribed more than subscribed', () => {
    wsClient.subscribe('project:3');
    wsClient.unsubscribe('project:3');
    wsClient.unsubscribe('project:3');
    expect(rooms().has('project:3')).toBe(false);
  });
});
