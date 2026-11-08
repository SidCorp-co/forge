import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { paneAttachOf } = await import('./chat-pane.js');

const socket = '/home/dev/.forge-dev-runner/xdg/forge-runner/tmux.sock';

describe('paneAttachOf: the attach command comes from what the box declared, never a guess', () => {
  it('composes the command from the socket and the pane the box names for the session', () => {
    const caps = { chatPanes: { socket, sessions: { s1: 'forge-chat-adminhub-api' } } };
    expect(paneAttachOf(caps, 's1')).toBe(
      `tmux -S '${socket}' attach -t 'forge-chat-adminhub-api'`,
    );
  });

  it('gives none for a session no pane holds, a box with no socket, or one that runs no panes', () => {
    const caps = { chatPanes: { socket, sessions: { s1: 'forge-chat-p' } } };
    expect(paneAttachOf(caps, 's2')).toBeNull();
    expect(paneAttachOf({ chatPanes: { sessions: { s1: 'forge-chat-p' } } }, 's1')).toBeNull();
    expect(paneAttachOf({ confinedChat: true }, 's1')).toBeNull();
    expect(paneAttachOf(null, 's1')).toBeNull();
  });

  it('quotes a socket path holding a quote, so the command stays one argument', () => {
    const caps = { chatPanes: { socket: "/r/it's/tmux.sock", sessions: { s1: 'forge-chat-p' } } };
    expect(paneAttachOf(caps, 's1')).toBe(
      `tmux -S '/r/it'\\''s/tmux.sock' attach -t 'forge-chat-p'`,
    );
  });
});
