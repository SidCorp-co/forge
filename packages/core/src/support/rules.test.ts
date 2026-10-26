import { supportToolSchema } from '@forge/contracts/support';
import { describe, expect, it } from 'vitest';
import { settleSupportRoom } from '../integrations/rocketchat/support-binding.js';
import {
  clipMessage,
  closesThread,
  confirmRefusal,
  limitsOf,
  mintConfirmCode,
  parseConfirm,
  threadOf,
  visitorIdOf,
} from './rules.js';

// REQ-75: the pure rules of a support group.

describe('a confirm is the asker’s own message naming the code (BC-13)', () => {
  it('reads confirm and cancel with a code, in any case, and nothing else', () => {
    expect(parseConfirm('confirm K7QX2M')).toEqual({ verb: 'confirm', code: 'K7QX2M' });
    expect(parseConfirm('  Cancel k7qx2m ')).toEqual({ verb: 'cancel', code: 'K7QX2M' });
    expect(parseConfirm('please confirm K7QX2M')).toBeNull();
    expect(parseConfirm('confirm K7QX2M and also delete')).toBeNull();
    expect(parseConfirm('confirm K7QX1M')).toBeNull();
  });

  it('mints codes from the unambiguous alphabet the pattern reads', () => {
    for (let i = 0; i < 200; i++) {
      const code = mintConfirmCode();
      expect(parseConfirm(`confirm ${code}`)?.code).toBe(code);
    }
  });

  it('lets only the asker’s account confirm, naming the asker to anyone else', () => {
    const fix = { askerKey: 'u-alice', askerLabel: 'alice' };
    expect(confirmRefusal(fix, 'u-alice')).toBeNull();
    expect(confirmRefusal(fix, 'u-bob')).toBe(
      'Only @alice can confirm this change. Nothing was run.',
    );
  });
});

describe('a group runs under limits and threads (BC-11, BC-16)', () => {
  it('reads limits over their defaults', () => {
    expect(limitsOf(null).messagesPerUserPerHour).toBe(30);
    expect(limitsOf({ limits: { fixesPerUserPerDay: 2 } })).toMatchObject({
      fixesPerUserPerDay: 2,
      messagesPerUserPerHour: 30,
    });
  });

  it('cuts a long message and says where', () => {
    expect(clipMessage('abcdef', 3)).toBe('abc … [cut at 3 characters]');
    expect(clipMessage('abc', 3)).toBe('abc');
  });

  it('keys a message to the thread it is in, or the one it opens', () => {
    expect(threadOf({ id: 'm2', tmid: 'm1' })).toBe('m1');
    expect(threadOf({ id: 'm1' })).toBe('m1');
  });

  it('files one Rocket.Chat account under one stable visitor id per server', () => {
    const a = visitorIdOf('chat.example.test', 'u1');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(visitorIdOf('chat.example.test', 'u1')).toBe(a);
    expect(visitorIdOf('chat.other.test', 'u1')).not.toBe(a);
  });

  it('stops following an item once it shipped, was confirmed or declined (BC-15)', () => {
    expect(['resolved', 'verified', 'declined'].every((p) => closesThread(p as never))).toBe(true);
    expect(closesThread('triaged')).toBe(false);
  });
});

describe('a support binding is one group, and its tools are declared to read or to change (BC-10, BC-12)', () => {
  it('refuses a support binding naming two rooms, and keeps a team binding’s many', async () => {
    const two = await settleSupportRoom({
      bindingId: 'b',
      config: { rids: ['r1', 'r2'], support: {} },
      held: null,
    });
    expect(two).toMatchObject({
      ok: false,
      refusals: [{ code: 'SUPPORT_ROOM_NOT_ONE_GROUP', path: '/rids' }],
    });
    expect(
      await settleSupportRoom({
        bindingId: 'b',
        config: { rids: ['r1'], support: {} },
        held: null,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await settleSupportRoom({ bindingId: 'b', config: { rids: ['r1', 'r2'] }, held: null }),
    ).toMatchObject({ ok: true });
  });

  it('refuses a diagnose tool that writes, and a path placeholder no parameter declares', () => {
    const writes = supportToolSchema.safeParse({
      name: 'wipe',
      kind: 'diagnose',
      method: 'DELETE',
      path: '/cache',
      summary: 'clear the cache',
    });
    expect(writes.success).toBe(false);
    expect(writes.error?.issues[0]?.message).toContain('GET or HEAD');
    const loose = supportToolSchema.safeParse({
      name: 'order',
      kind: 'diagnose',
      method: 'GET',
      path: '/orders/{id}',
      summary: 'read an order',
    });
    expect(loose.success).toBe(false);
  });
});
