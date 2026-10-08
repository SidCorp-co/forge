// Who may agree to a held chat write (REQ-30 BC-4): the person it waits on, by pressing its card,
// once. Every refusal here writes nothing: the write stand-in records each call it is asked to make.
// That no chat credential agrees, whatever was typed, is `agreement-door.test.ts`'s.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const PERSON = 'u-person';
const OTHER = 'u-other';
const before = new Date('2026-10-08T10:00:00Z');

type Row = {
  id: string;
  conversationId: string;
  proposedTo: string;
  status: string;
  kind: string;
  createdAt: Date;
};
let row: Row;
let claimable = true;
const written: string[] = [];
const claims: unknown[][] = [];
const settled: { id: string; ok: boolean }[] = [];

vi.mock('./store.js', () => ({
  readProposal: async (id: string) => (id === row.id ? row : null),
  claimAgreement: async (...args: unknown[]) => {
    claims.push(args);
    return claimable ? { ...row, status: 'agreed', decidedBy: args[1], agreedVia: 'card' } : null;
  },
  settleProposal: async (id: string, outcome: { ok: boolean }) => {
    settled.push({ id, ok: outcome.ok });
    return { ...row, status: outcome.ok ? 'recorded' : 'failed' };
  },
  declineProposal: async () => ({ ...row, status: 'declined' }),
}));
vi.mock('./execute.js', () => ({
  writeAgreed: async (claimed: Row) => {
    written.push(claimed.id);
    return { ok: true, record: { ref: 'FB-3', href: null }, answered: '{}' };
  },
}));

const { agreeProposal, declineAs } = await import('./agree.js');

const authority = { userId: PERSON } as never;
const card = { userId: PERSON, authority };

const refusedWith = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toMatchObject({ refusals: [expect.objectContaining({ code })] });
  expect(written).toEqual([]);
};

beforeEach(() => {
  row = {
    id: 'p-1',
    conversationId: 'room',
    proposedTo: PERSON,
    status: 'pending',
    kind: 'feedback',
    createdAt: before,
  };
  claimable = true;
  written.length = 0;
  claims.length = 0;
  settled.length = 0;
});

describe('the person it waits on agrees by the card, once', () => {
  it('writes the held call and settles it recorded', async () => {
    const { outcome } = await agreeProposal('p-1', card);
    expect(written).toEqual(['p-1']);
    expect(claims, 'the press is the person, and carries no words to bind').toEqual([
      ['p-1', PERSON],
    ]);
    expect(settled).toEqual([{ id: 'p-1', ok: true }]);
    expect(outcome).toMatchObject({ ok: true, record: { ref: 'FB-3' } });
  });

  it('refuses anyone else by name', async () => {
    await refusedWith(agreeProposal('p-1', { ...card, userId: OTHER }), 'CHAT_PROPOSAL_NOT_YOURS');
  });

  it('refuses a proposal already decided, and one decided while the agreement was on its way', async () => {
    row.status = 'declined';
    await refusedWith(agreeProposal('p-1', card), 'CHAT_PROPOSAL_SETTLED');
    row.status = 'pending';
    claimable = false;
    await refusedWith(agreeProposal('p-1', card), 'CHAT_PROPOSAL_SETTLED');
  });

  it('refuses a proposal that does not exist', async () => {
    await refusedWith(agreeProposal('p-404', card), 'CHAT_PROPOSAL_UNKNOWN');
  });
});

describe('declining', () => {
  it('is the person it waits on, and writes nothing', async () => {
    expect((await declineAs('p-1', PERSON)).status).toBe('declined');
    await refusedWith(declineAs('p-1', OTHER), 'CHAT_PROPOSAL_NOT_YOURS');
  });
});
