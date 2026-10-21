import { beforeEach, describe, expect, it, vi } from 'vitest';

// Criterion 156 of ISS-1229 (r25): a display name that is an email address can no longer be saved
// (criterion 189), so the live product cannot show a mention by such a member. The title is pinned
// here instead, against the subscriber that writes it, with a legacy name planted in the user row.

const rows: { issue: { title: string } | null; actor: { displayName: string | null } | null } = {
  issue: null,
  actor: null,
};

vi.mock('../db/client.js', () => ({
  db: {
    select: (shape: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const row = 'title' in shape ? rows.issue : rows.actor;
            return row ? [row] : [];
          },
        }),
      }),
    }),
  },
}));

const emitted: Array<{ userId: string; title: string }> = [];
vi.mock('./emit.js', () => ({
  emitNotification: async (n: { userId: string; title: string }) => {
    emitted.push(n);
  },
}));

const { registerNotifyMentionsSubscriber } = await import('./notify-mentions.js');

type Handler = (p: unknown) => Promise<void>;

function mentionedBy(displayName: string | null): Promise<void> {
  rows.issue = { title: 'Fix login' };
  rows.actor = { displayName };
  let handler: Handler | undefined;
  registerNotifyMentionsSubscriber({
    on: (_event: string, fn: Handler) => {
      handler = fn;
    },
  } as never);
  return (handler as Handler)({
    actor: { type: 'user', id: 'u-mentioner' },
    issueId: 'i-1',
    projectId: 'p-1',
    commentId: 'c-1',
    mentionedUserIds: ['u-reader'],
  });
}

describe('a mention notice names who mentioned you, never their address (criterion 156)', () => {
  beforeEach(() => {
    emitted.length = 0;
  });

  it('reads "Another member mentioned you in" where the display name is an email address', async () => {
    await mentionedBy('mai.tran@example.com');
    expect(emitted).toEqual([
      expect.objectContaining({
        userId: 'u-reader',
        title: 'Another member mentioned you in "Fix login"',
      }),
    ]);
    expect(emitted[0]?.title).not.toContain('@');
  });

  it('reads the same where no display name is set (criterion 155)', async () => {
    await mentionedBy(null);
    expect(emitted[0]?.title).toBe('Another member mentioned you in "Fix login"');
  });

  it('names a member by their display name (criterion 154)', async () => {
    await mentionedBy('Mai Tran');
    expect(emitted[0]?.title).toBe('Mai Tran mentioned you in "Fix login"');
  });
});
