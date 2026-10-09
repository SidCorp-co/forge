// ISS-464 (REQ-35 BC-10 with REQ-30 BC-4): the turn gate holds a write without running it, so a
// draft its press would only see refused is refused before its card is offered, by the record tool's
// own check. The store is stood in for; the check is the real one the process entry hands over.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const held: { kind: string }[] = [];

vi.mock('../../permissions/index.js', async (original) => ({
  ...(await original<typeof import('../../permissions/index.js')>()),
  requireCan: async () => undefined,
}));
vi.mock('./store.js', () => ({
  recordProposal: async (p: { kind: string }) => {
    const row = { ...p, id: `p-${held.length + 1}`, createdAt: new Date() };
    held.push(row);
    return row;
  },
  restateProposal: async () => undefined,
}));

const { agreementGate } = await import('./turn-gate.js');
const { provideHeldWriteVets, vetHeld } = await import('./vet.js');
const { REQUIREMENT_RECORD_VETS } = await import('../../requirements/tool.js');
const { RefusalError } = await import('../../lib/refusal.js');

const PROJECT = '11111111-1111-4111-8111-111111111111';
const ran: string[] = [];
const inner = {
  tools: [],
  ranAs: () => 'u-1',
  async execute(name: string) {
    ran.push(name);
    return { content: [{ type: 'text' as const, text: '{}' }] };
  },
  grantOf: () => 'projects:write' as const,
};
const gate = () =>
  agreementGate(inner, {
    projectId: PROJECT,
    conversationId: 'c',
    personId: 'u-1',
    handleUserId: null,
  }).tools;
const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((b) => b.text ?? '').join('\n');

const draft = {
  title: 'Refunds within 14 days',
  reason: 'Buyers ask for refunds by email today.',
  criteria: [{ body: 'A buyer asks for a refund from the order page.' }],
};
const flow = {
  kind: 'flow',
  content: {
    nodes: [
      { id: 'ask', label: 'Buyer asks' },
      { id: 'paid', label: 'Refund paid' },
    ],
    edges: [{ from: 'ask', to: 'paid' }],
  },
};

provideHeldWriteVets(REQUIREMENT_RECORD_VETS);

beforeEach(() => {
  held.length = 0;
  ran.length = 0;
});

describe("the assistant's draft is checked before its card is offered", () => {
  it('refuses a draft that draws no picture by name, holding nothing and running nothing', async () => {
    const r = await gate().execute('forge_requirement_draft', JSON.stringify(draft));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('REQUIREMENT_PICTURE_NOT_DRAWN');
    expect(text(r)).not.toContain('CHAT_WRITE_AWAITS_AGREEMENT');
    expect(held).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('refuses a picture of another kind than the one the draft names', async () => {
    const r = await gate().execute(
      'forge_requirement_draft',
      JSON.stringify({ ...draft, kind: 'rule', picture: flow }),
    );
    expect(text(r)).toContain('REQUIREMENT_PICTURE_KIND_MISMATCH');
    expect(held).toEqual([]);
  });

  it('refuses a text alternative written blank', async () => {
    const r = await gate().execute(
      'forge_requirement_draft',
      JSON.stringify({ ...draft, kind: 'process', picture: { ...flow, alt: ' ' } }),
    );
    expect(text(r)).toContain('REQUIREMENT_PICTURE_ALT_REQUIRED');
    expect(held).toEqual([]);
  });

  it('holds a draft that names its kind and draws it, as before', async () => {
    const r = await gate().execute(
      'forge_requirement_draft',
      JSON.stringify({ ...draft, kind: 'process', picture: flow }),
    );
    expect(text(r)).toContain('CHAT_WRITE_AWAITS_AGREEMENT');
    expect(held.map((h) => h.kind)).toEqual(['requirement_draft']);
  });
});

describe('a check, as the gate runs it', () => {
  it('leaves a tool with no check to be held', async () => {
    expect(await vetHeld('forge_feedback', '{}', PROJECT)).toBeNull();
  });

  it("pins the turn's project, as the toolset does", async () => {
    let seen: unknown = null;
    provideHeldWriteVets({
      probe_tool: async (args) => {
        seen = args.projectId;
        return null;
      },
    });
    expect(await vetHeld('probe_tool', '{"projectId":"another"}', PROJECT)).toBeNull();
    expect(seen).toBe(PROJECT);
  });

  it('answers a refusal thrown by name, and arguments that are not JSON', async () => {
    provideHeldWriteVets({
      probe_tool: async () => {
        throw new RefusalError(
          [{ code: 'REQUIREMENT_REFUSED', path: '/x', detail: 'no such requirement' }],
          'REQUIREMENT_REFUSED',
        );
      },
    });
    const thrown = await vetHeld('probe_tool', '{}', PROJECT);
    expect(thrown && text(thrown)).toContain('no such requirement');
    const broken = await vetHeld('probe_tool', '{not json', PROJECT);
    expect(broken && text(broken)).toContain('arguments were not valid JSON');
  });
});
