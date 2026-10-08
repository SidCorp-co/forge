// Agreement is the person's press on the card alone (REQ-30 BC-4, ISS-439): no chat credential
// agrees or declines, whatever the person typed. The judge's probe A had a model pass a typed "No.
// Do not record this" to the agreement, and core wrote it; there is no longer anything to pass.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Door =
  | { door: 'assistant-turn' }
  | { door: 'box-session'; sessionId: string }
  | { door: 'agreement'; proposalId: string }
  | null;
let scope: { tokenId: string } | null = null;
let door: Door = null;
const readable: string[] = [];

vi.mock('../../credentials/pat-scope.js', () => ({ currentPatScope: () => scope }));
vi.mock('../../agent-sessions/index.js', () => ({ chatDoorOfToken: async () => door }));
vi.mock('../../conversations/index.js', () => ({
  readableConversation: async (id: string) => {
    readable.push(id);
  },
}));
vi.mock('../../permissions/index.js', () => ({
  resolveTurnAuthority: async ({ userId }: { userId: string }) => ({
    ok: true,
    authority: { userId },
  }),
}));

const { agreementOf, refuseChatDecline } = await import('./agreement-door.js');

const proposal = { id: 'p-1', projectId: 'proj', conversationId: 'room' } as never;

beforeEach(() => {
  scope = null;
  door = null;
  readable.length = 0;
});

describe('the person pressing the card agrees, as themselves', () => {
  it('from their own sign-in', async () => {
    expect(await agreementOf('room', proposal, 'u-1')).toEqual({
      userId: 'u-1',
      authority: { userId: 'u-1' },
    });
    expect(readable).toEqual(['room']);
  });

  it('from a token of their own that no chat holds', async () => {
    scope = { tokenId: 't-own' };
    expect((await agreementOf('room', proposal, 'u-1')).userId).toBe('u-1');
  });
});

describe('no chat credential agrees, whatever was typed', () => {
  for (const held of [
    { door: 'assistant-turn' },
    { door: 'box-session', sessionId: 's-1' },
    { door: 'agreement', proposalId: 'p-0' },
  ] as const) {
    it(`refuses the ${held.door} credential by name`, async () => {
      scope = { tokenId: 't-chat' };
      door = held;
      await expect(agreementOf('room', proposal, 'u-1')).rejects.toMatchObject({
        refusals: [expect.objectContaining({ code: 'CHAT_AGREEMENT_DOOR' })],
      });
      await expect(refuseChatDecline()).rejects.toMatchObject({
        refusals: [expect.objectContaining({ code: 'CHAT_AGREEMENT_DOOR' })],
      });
    });
  }
});
