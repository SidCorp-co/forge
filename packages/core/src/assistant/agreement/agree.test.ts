// Who may agree to a held chat write, and when a reply counts as agreeing (REQ-30 BC-4). Every
// refusal here writes nothing: the write stand-in records each call it is asked to make.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const PERSON = 'u-person';
const OTHER = 'u-other';
const before = new Date('2026-10-08T10:00:00Z');
const turnStart = new Date('2026-10-08T10:05:00Z');

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
const settled: { id: string; ok: boolean }[] = [];

vi.mock('./store.js', () => ({
  readProposal: async (id: string) => (id === row.id ? row : null),
  claimAgreement: async (_id: string, by: string, via: string, words: string | null) =>
    claimable
      ? { ...row, status: 'agreed', decidedBy: by, agreedVia: via, agreedWords: words }
      : null,
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
const card = { via: 'card' as const, userId: PERSON, authority };
const reply = (
  over: Partial<{
    words: string;
    kind: string;
    message: string;
    startedAt: Date;
    conversationId: string;
  }> = {},
) => ({
  via: 'reply' as const,
  userId: PERSON,
  authority,
  reply: {
    conversationId: 'room',
    message: 'Yes — record it as you said.',
    startedAt: turnStart,
    words: 'yes — record it as you said. ',
    kind: 'feedback' as const,
    ...over,
  } as never,
});

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
  settled.length = 0;
});

describe('the person it waits on agrees by the card, once', () => {
  it('writes the held call and settles it recorded', async () => {
    const { outcome } = await agreeProposal('p-1', card);
    expect(written).toEqual(['p-1']);
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

describe('a reply agrees only when core can bind it to what was proposed', () => {
  it('binds the whole message, in any case and spacing, and writes', async () => {
    await agreeProposal('p-1', reply());
    expect(written).toEqual(['p-1']);
  });

  it('refuses a quote that is only part of the message: "no, don\'t record it" holds "record it"', async () => {
    await refusedWith(
      agreeProposal('p-1', reply({ message: "No, don't record it.", words: 'record it' })),
      'CHAT_AGREEMENT_UNBOUND',
    );
  });

  it('refuses a kind other than the one proposed', async () => {
    await refusedWith(
      agreeProposal('p-1', reply({ kind: 'requirement_draft' })),
      'CHAT_AGREEMENT_UNBOUND',
    );
  });

  it('refuses a proposal made in the same turn, which the person has not seen', async () => {
    row.createdAt = new Date(turnStart.getTime() + 1_000);
    await refusedWith(agreeProposal('p-1', reply()), 'CHAT_AGREEMENT_UNBOUND');
  });

  it('refuses a proposal of another conversation as unknown here', async () => {
    await refusedWith(
      agreeProposal('p-1', reply({ conversationId: 'elsewhere' })),
      'CHAT_PROPOSAL_UNKNOWN',
    );
  });

  it('refuses a reply bound for someone the proposal does not wait on', async () => {
    await refusedWith(
      agreeProposal('p-1', { ...reply(), userId: OTHER }),
      'CHAT_PROPOSAL_NOT_YOURS',
    );
  });
});

describe('declining', () => {
  it('is the person it waits on, and writes nothing', async () => {
    expect((await declineAs('p-1', PERSON)).status).toBe('declined');
    await refusedWith(declineAs('p-1', OTHER), 'CHAT_PROPOSAL_NOT_YOURS');
  });
});
