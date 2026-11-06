import {
  SUPPORT_CONFIRM_CODE_PATTERN,
  supportRoomConfigSchema,
  supportToolSchema,
} from '@forge/contracts/support';
import { describe, expect, it } from 'vitest';
import { settleSupportRoom } from '../integrations/rocketchat/support-binding.js';
import {
  clipMessage,
  type ItemResult,
  limitsOf,
  mintConfirmCode,
  resultNote,
  threadOf,
  visitorIdOf,
} from './rules.js';

// REQ-75: the pure rules of a support group.

describe('a proposal waits under a handle the session cites (BC-13, ISS-845)', () => {
  it('mints handles from the unambiguous alphabet the agreement schema reads', () => {
    for (let i = 0; i < 200; i++) expect(mintConfirmCode()).toMatch(SUPPORT_CONFIRM_CODE_PATTERN);
  });
});

describe('a group runs under limits and threads (BC-11, BC-16)', () => {
  it('reads limits over their defaults', () => {
    expect(limitsOf(null).messagesPerUserPerHour).toBe(30);
    expect(limitsOf({ limits: { messageMaxChars: 500 } })).toEqual({
      messagesPerUserPerHour: 30,
      messageMaxChars: 500,
      responseMaxBytes: 16_000,
    });
  });

  // ISS-876, owner 2026-11-02: no daily cap on handing work, so no limit counts a member's changes
  it('holds no limit on how many changes a member confirms, and refuses the old knob by name', () => {
    expect(Object.keys(limitsOf(null)).sort()).toEqual([
      'messageMaxChars',
      'messagesPerUserPerHour',
      'responseMaxBytes',
    ]);
    const refused = supportRoomConfigSchema.safeParse({ limits: { fixesPerUserPerDay: 1000 } });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues).toEqual([
      expect.objectContaining({
        code: 'unrecognized_keys',
        keys: ['fixesPerUserPerDay'],
        path: ['limits'],
      }),
    ]);
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

  it('tells the session a result once an item is final, and nothing for progress (r6 BC-15)', () => {
    const at = (phase: string) => resultNote({ ...SHIPPED, phase: phase as ItemResult['phase'] });
    for (const p of ['resolved', 'verified', 'declined'] as const) {
      expect(at(p)).toContain('Post its result in this thread, once');
    }
    for (const p of ['new', 'triaged', 'planned', 'reopened'] as const) {
      expect(at(p)).toBeNull();
    }
  });
});

// ISS-1032: FB-2 was triaged route answer and changed nothing, yet the sid-email room's session was
// told it was "live now" and told the asker the mailbox had been shared.
const SHIPPED: ItemResult = {
  phase: 'resolved',
  key: 'FB-3',
  route: 'issue',
  answer: null,
  declined: null,
  shipped: [],
  withheld: false,
};
const POST =
  "Post its result in this thread, once, in the asker's words: what changed for them, or that it will not be done. No keys, no process.";
const ANSWER = 'Nothing was shared: an admin adds them under Mail, then Delegation.';

describe('the note says what settled the item, by its route (ISS-1032)', () => {
  it('tells an answered item as answered, with the answer to restate, never as live', () => {
    const note = resultNote({ ...SHIPPED, route: 'answer', answer: ANSWER });
    expect(note).toContain('was answered by the team');
    expect(note).toContain('nothing was changed or shipped for it unless the answer says so');
    expect(note).toContain(`(restate it, never paste it): "${ANSWER}"`);
    expect(note).not.toMatch(/\blive\b/);
    expect(note?.endsWith(POST)).toBe(true);
  });

  it('tells an answer the policy withholds as answered, and says its words are withheld', () => {
    const note = resultNote({ ...SHIPPED, route: 'answer', withheld: true });
    expect(note).toContain('was answered by the team');
    expect(note).toContain("withheld from this session by the project's data policy");
    expect(note).not.toMatch(/\blive\b/);
  });

  it('keeps a shipped item’s note word for word where nothing names what shipped', () => {
    for (const route of ['issue', 'new_requirement', 'revision', 'duplicate'] as const) {
      expect(resultNote({ ...SHIPPED, route })).toBe(
        `FB-3, recorded from this thread, is live now. ${POST}`,
      );
    }
    expect(resultNote({ ...SHIPPED, phase: 'verified' })).toBe(
      `FB-3, recorded from this thread, is live and confirmed fixed. ${POST}`,
    );
  });

  it('carries what the team shipped, so the room hears what was done (owner, 2026-11-06)', () => {
    const shipped = ['CSV export of invoices', 'Invoices list paging'];
    expect(resultNote({ ...SHIPPED, shipped })).toBe(
      `FB-3, recorded from this thread, is live now. What the team shipped for it (restate it, never paste it): "CSV export of invoices; Invoices list paging" ${POST}`,
    );
    expect(resultNote({ ...SHIPPED, phase: 'verified', shipped })).toContain(
      'is live and confirmed fixed. What the team shipped for it',
    );
  });

  it('carries a decline’s reason, and says it declined where none was given', () => {
    const reason = 'The host owns that limit.';
    expect(resultNote({ ...SHIPPED, phase: 'declined', route: null, declined: reason })).toBe(
      `FB-3, recorded from this thread, will not be done: the team declined it. The reason they gave (restate it, never paste it): "${reason}" ${POST}`,
    );
    expect(resultNote({ ...SHIPPED, phase: 'declined', route: null, declined: '  ' })).toBe(
      `FB-3, recorded from this thread, will not be done: the team declined it. ${POST}`,
    );
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
