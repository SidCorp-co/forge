import { beforeEach, describe, expect, it, vi } from 'vitest';

let listening = false;
const sent: Array<{ deviceId: string; event: string }> = [];

vi.mock('./ports.js', () => ({
  agentSessionsPorts: () => ({
    boxIsListening: () => listening,
    sendToBoxNow: (deviceId: string, envelope: { event: string }) => {
      sent.push({ deviceId, event: envelope.event });
      return listening ? 1 : 0;
    },
  }),
}));

const { requireListeningBox } = await import('./chat-device.js');

describe('a chat turn asks the WebSocket door whether its box is listening', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it('refuses by name when nobody reads the box room', () => {
    listening = false;
    expect(() => requireListeningBox('d-1')).toThrow(
      expect.objectContaining({
        refusals: [expect.objectContaining({ code: 'NO_CLAUDE_CLIENT' })],
      }),
    );
  });

  it('lets the turn go on when the box is listening', () => {
    listening = true;
    expect(() => requireListeningBox('d-1')).not.toThrow();
  });
});
