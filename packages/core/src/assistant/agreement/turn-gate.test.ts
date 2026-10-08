// REQ-30 BC-4 on the Assistant's side: a write the model calls is held for the person's agreement,
// never made, and only a reply core binds through forge_agree writes it. The store and the
// agreement are stood in for here; `agree.test.ts` holds the binding, and the integration suite the
// write itself (`tests/integration/chat-agreement-e2e.test.ts`).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const held: { id: string; kind: string; call: { name: string; arguments: string } }[] = [];
const restated: { id: string; args: string }[] = [];
const pending: { id: string; kind: string; summary: { title: string } }[] = [];
const agreed: { id: string; as: unknown }[] = [];
// the person's role: a viewer is refused a write by the permission it lacks, before anything is held
let role = 'member';

vi.mock('../../permissions/index.js', async () => {
  const { refuser } = await import('../../lib/refusal.js');
  const refuse = refuser<'PERMISSION_FORBIDDEN'>('PERMISSION_FORBIDDEN');
  return {
    actorFor: (userId: string) => ({ userId }),
    projectResource: (projectId: string) => ({ projectId }),
    requireCan: async (_actor: unknown, permission: string) => {
      if (role === 'viewer') {
        throw refuse(
          'PERMISSION_FORBIDDEN',
          `This needs ${permission} on project p; the caller holds viewer there`,
        );
      }
    },
  };
});

vi.mock('./store.js', () => ({
  pendingFor: async () => pending,
  recordProposal: async (p: { kind: string; call: { name: string; arguments: string } }) => {
    const row = { ...p, id: `p-${held.length + 1}`, createdAt: new Date() };
    held.push(row);
    return row;
  },
  restateProposal: async (id: string, call: { arguments: string }) => {
    restated.push({ id, args: call.arguments });
  },
}));
vi.mock('./agree.js', () => ({
  agreeProposal: async (id: string, as: unknown) => {
    agreed.push({ id, as });
    return {
      row: { id, kind: 'feedback' },
      outcome: {
        ok: true,
        record: { ref: 'FB-7', href: null },
        answered: '{"feedback":{"key":"FB-7"}}',
      },
    };
  },
}));

const { agreementGate } = await import('./turn-gate.js');

const writes: string[] = [];
const inner = {
  tools: [
    {
      type: 'function' as const,
      function: { name: 'forge_feedback', description: '', parameters: {} },
    },
  ],
  ranAs: () => 'u-1',
  async execute(name: string) {
    writes.push(name);
    return { content: [{ type: 'text' as const, text: `{"ran":"${name}"}` }] };
  },
};

const turn = {
  projectId: 'p',
  conversationId: 'c',
  personId: 'u-1',
  handleUserId: null,
  message: 'Yes, record it.',
  authority: { userId: 'u-1' } as never,
};

const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((b) => b.text ?? '').join('\n');

const feedback = (title: string) =>
  JSON.stringify({ kind: 'bug', title, body: 'The dock loses my draft.', requirement: 'REQ-30' });

beforeEach(() => {
  role = 'member';
  held.length = 0;
  restated.length = 0;
  pending.length = 0;
  agreed.length = 0;
  writes.length = 0;
});

describe('a chat write is held until the person agrees', () => {
  const calls: [string, string, string][] = [
    ['forge_feedback', feedback('Draft lost'), 'feedback'],
    [
      'forge_requirement_draft',
      JSON.stringify({
        title: 'Keep drafts',
        reason: 'r',
        criteria: [{ body: 'A draft is kept.' }],
      }),
      'requirement_draft',
    ],
    [
      'forge_requirement_revise',
      JSON.stringify({ requirement: 'REQ-30', baseRevision: 1, reason: 'r', criteria: [] }),
      'requirement_revision',
    ],
    ['forge', JSON.stringify({ argv: ['comment', 'ISS-12', '-'], body: 'Seen again.' }), 'comment'],
    ['forge', JSON.stringify({ argv: ['attach', 'issue', 'ISS-12', '/tmp/a.png'] }), 'attachment'],
    [
      'forge_memory_note',
      JSON.stringify({ text: 'The release code is bench-1a2b3c.' }),
      'memory_note',
    ],
  ];

  for (const [name, args, kind] of calls) {
    it(`refuses ${kind} by name, writes nothing, and keeps exactly the call`, async () => {
      const gate = await agreementGate(inner, turn);
      const result = await gate.tools.execute(name, args);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('CHAT_WRITE_AWAITS_AGREEMENT: nothing was written');
      expect(text(result)).toContain(`proposal p-1 (kind ${kind})`);
      expect(writes).toEqual([]);
      expect(held).toMatchObject([{ kind, call: { name, arguments: args } }]);
      expect(gate.heldThisTurn()).toBe(1);
    });
  }

  it('lets a read through, and a criteriaFrom preview, which writes nothing', async () => {
    const gate = await agreementGate(inner, turn);
    await gate.tools.execute('forge_requirements', '{}');
    await gate.tools.execute(
      'forge_requirement_draft',
      JSON.stringify({ title: 'x', criteriaFrom: { file: 'spec.md' }, preview: true }),
    );
    await gate.tools.execute('forge', JSON.stringify({ argv: ['issue', 'ISS-1'] }));
    expect(writes).toEqual(['forge_requirements', 'forge_requirement_draft', 'forge']);
    expect(held).toEqual([]);
    expect(gate.heldThisTurn()).toBe(0);
  });

  it('holds one proposal per title in a turn, the latest wording restating it', async () => {
    const gate = await agreementGate(inner, turn);
    await gate.tools.execute('forge_feedback', feedback('Tags sync from Hub'));
    await gate.tools.execute('forge_feedback', feedback('  tags sync from hub. '));
    await gate.tools.execute('forge_feedback', feedback('A second report'));
    expect(held.map((h) => h.id)).toEqual(['p-1', 'p-2']);
    expect(restated).toEqual([{ id: 'p-1', args: feedback('  tags sync from hub. ') }]);
  });

  it('holds one proposal when the model asks for the same record twice in one round', async () => {
    const gate = await agreementGate(inner, turn);
    await Promise.all([
      gate.tools.execute('forge_feedback', feedback('Same title')),
      gate.tools.execute('forge_feedback', feedback('Same title')),
    ]);
    expect(held).toHaveLength(1);
  });
});

describe('a reply agrees only through forge_agree', () => {
  it('is not offered while nothing waits on the person', async () => {
    const gate = await agreementGate(inner, turn);
    expect(gate.tools.tools.map((t) => t.function.name)).not.toContain('forge_agree');
  });

  it('is offered with what waits, and hands core the reply to bind', async () => {
    pending.push({ id: 'p-9', kind: 'feedback', summary: { title: 'Feedback (bug): Draft lost' } });
    const gate = await agreementGate(inner, turn);
    const agree = gate.tools.tools.find((t) => t.function.name === 'forge_agree');
    expect(agree?.function.description).toContain('p-9 (feedback): Feedback (bug): Draft lost');
    const result = await gate.tools.execute(
      'forge_agree',
      JSON.stringify({
        proposal: '00000000-0000-4000-8000-000000000009',
        kind: 'feedback',
        words: 'Yes, record it.',
      }),
    );
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('FB-7');
    expect(agreed).toMatchObject([
      {
        id: '00000000-0000-4000-8000-000000000009',
        as: {
          via: 'reply',
          userId: 'u-1',
          reply: {
            conversationId: 'c',
            message: 'Yes, record it.',
            words: 'Yes, record it.',
            kind: 'feedback',
          },
        },
      },
    ]);
    expect(writes).toEqual([]);
  });

  it('refuses an agreement with no words by its shape, binding nothing', async () => {
    const gate = await agreementGate(inner, turn);
    const result = await gate.tools.execute(
      'forge_agree',
      JSON.stringify({ proposal: '00000000-0000-4000-8000-000000000009', kind: 'feedback' }),
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('words');
    expect(agreed).toEqual([]);
  });
});

describe("a write the person's role could not make is refused for that, not held", () => {
  it('refuses a viewer by the permission it lacks, and holds nothing', async () => {
    role = 'viewer';
    const gate = await agreementGate(inner, turn);
    const r = await gate.tools.execute('forge_feedback', feedback('Draft lost'));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('needs project.write');
    expect(text(r)).not.toContain('CHAT_WRITE_AWAITS_AGREEMENT');
    expect(held).toEqual([]);
    expect(writes).toEqual([]);
    expect(gate.heldThisTurn()).toBe(0);
  });

  it("holds a viewer's change to their own reply preferences, which every role makes", async () => {
    role = 'viewer';
    const gate = await agreementGate(inner, turn);
    const r = await gate.tools.execute(
      'forge_preferences',
      JSON.stringify({ action: 'set', tone: 'brief' }),
    );
    expect(text(r)).toContain('CHAT_WRITE_AWAITS_AGREEMENT');
    expect(held.map((h) => h.kind)).toEqual(['preferences']);
  });
});
