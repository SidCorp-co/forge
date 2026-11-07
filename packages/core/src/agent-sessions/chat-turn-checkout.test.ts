import { describe, expect, it, vi } from 'vitest';

const bound = vi.hoisted(() => ({ path: '/srv/new' as string | null }));
vi.mock('../lib/device-pool.js', () => ({
  resolveSessionRepoPathForDevice: vi.fn(async () => bound.path),
}));

const { checkoutMovedFrom, movedNotice, turnCheckout } = await import('./chat-turn-checkout.js');

// ISS-1101: epod's session kept the checkout it was made with after its box was rebound, and every
// turn ran there, gone, for 13 hours.
describe('the checkout a chat turn runs in', () => {
  const session = { repoPath: '/srv/gone', deviceId: 'd-1' };

  it('is the one the binding names now, the stored one named as where the session moved from', async () => {
    await expect(turnCheckout(session, 'p-1', 'd-1', false)).resolves.toEqual({
      repoPath: '/srv/new',
      movedFrom: '/srv/gone',
    });
  });

  it('a binding naming none is refused CHECKOUT_UNBOUND, never the stored path', async () => {
    bound.path = null;
    await expect(turnCheckout(session, 'p-1', 'd-1', false)).rejects.toMatchObject({
      refusals: [expect.objectContaining({ code: 'CHECKOUT_UNBOUND' })],
    });
    bound.path = '/srv/new';
  });

  it('is no move where it runs where it ran, on another box, or after a migration', () => {
    expect(checkoutMovedFrom(session, 'd-1', '/srv/gone')).toBeNull();
    expect(checkoutMovedFrom(session, 'd-2', '/srv/new')).toBeNull();
    expect(checkoutMovedFrom(session, 'd-1', '/srv/new', true)).toBeNull();
    expect(checkoutMovedFrom({ ...session, repoPath: null }, 'd-1', '/srv/new')).toBeNull();
    expect(checkoutMovedFrom(session, 'd-1', '/srv/new')).toBe('/srv/gone');
  });

  it('a move is said on the transcript naming both checkouts', () => {
    const at = new Date('2026-11-07T10:00:00Z');
    expect(movedNotice('/srv/gone', '/srv/new', at)).toEqual({
      id: expect.any(String),
      type: 'system',
      content:
        'This session ran in the checkout /srv/gone; its binding names /srv/new now, so this turn and every one after it run there.',
      timestamp: at.getTime(),
    });
  });
});
