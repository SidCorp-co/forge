import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { roomAttachOf } = await import('./chat-room.js');

describe('roomAttachOf: the attach command comes from what the box declared, never a guess', () => {
  it('composes the command from the project the box names for the session', () => {
    const caps = { chatRooms: { sessions: { s1: 'adminhub-api' } } };
    expect(roomAttachOf(caps, 's1')).toBe(`forge-runner chat attach 'adminhub-api'`);
  });

  it('gives none for a session no room holds, or a box that runs no rooms', () => {
    const caps = { chatRooms: { sessions: { s1: 'p' } } };
    expect(roomAttachOf(caps, 's2')).toBeNull();
    expect(roomAttachOf({ chatRooms: { sessions: { s1: '' } } }, 's1')).toBeNull();
    // a box still declaring the tmux panes this replaced names no room
    expect(
      roomAttachOf({ chatPanes: { socket: '/s', sessions: { s1: 'forge-chat-p' } } }, 's1'),
    ).toBeNull();
    expect(roomAttachOf({ confinedChat: true }, 's1')).toBeNull();
    expect(roomAttachOf(null, 's1')).toBeNull();
  });

  it('quotes a slug holding a quote, so the command stays one argument', () => {
    const caps = { chatRooms: { sessions: { s1: "it's" } } };
    expect(roomAttachOf(caps, 's1')).toBe(`forge-runner chat attach 'it'\\''s'`);
  });
});
