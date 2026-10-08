// REQ-30 BC-4 on the Assistant's side: a write the model calls is held for the person's agreement,
// never made, and the turn has no tool that agrees: only the person's press on the card writes it.
// The store is stood in for here; `agree.test.ts` holds the press, and the integration suite the
// write itself (`tests/integration/chat-agreement-e2e.test.ts`).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolGrantEntry } from '../../lib/tool.js';

const held: { id: string; kind: string; call: { name: string; arguments: string } }[] = [];
const restated: { id: string; args: string }[] = [];
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
    requireOrgHeld: (_org: string, orgRole: string, permission: string) => {
      if (orgRole !== 'admin') {
        throw refuse('PERMISSION_FORBIDDEN', `This needs ${permission} on the organization`);
      }
    },
  };
});
vi.mock('../../lib/authz.js', () => ({
  loadProjectAccess: async () => ({ orgId: 'o', orgRole: role === 'admin' ? 'admin' : 'member' }),
}));

vi.mock('./store.js', () => ({
  recordProposal: async (p: { kind: string; call: { name: string; arguments: string } }) => {
    const row = { ...p, id: `p-${held.length + 1}`, createdAt: new Date() };
    held.push(row);
    return row;
  },
  restateProposal: async (id: string, call: { arguments: string }) => {
    restated.push({ id, args: call.arguments });
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
  // the grant each tool declares, as `mcp-adapter.ts:buildToolset` reports it; a name absent here is
  // a tool that declares none, as a hand-built toolset's are
  grantOf: (name: string) => GRANTS[name] ?? null,
};
const GRANTS: Record<string, ToolGrantEntry> = {
  forge_requirements: 'projects:read',
  forge_requirement_draft: 'projects:write',
  forge_feedback: 'projects:write',
  forge_channel: 'projects:write',
  forge_show: 'assistant:write',
  forge: { none: 'it runs the forge CLI under the turn token' },
};

const turn = {
  projectId: 'p',
  conversationId: 'c',
  personId: 'u-1',
  handleUserId: null,
};

const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((b) => b.text ?? '').join('\n');

const feedback = (title: string) =>
  JSON.stringify({ kind: 'bug', title, body: 'The dock loses my draft.', requirement: 'REQ-30' });

beforeEach(() => {
  role = 'member';
  held.length = 0;
  restated.length = 0;
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
    // the report save and the issue change are held like every record (ISS-439 round 2: the judge
    // found removing either hold turned no test red)
    ['forge_template_save', JSON.stringify({ templateId: 'weekly', runs: ['r-1'] }), 'report_save'],
    [
      'forge',
      JSON.stringify({ argv: ['issue', 'ISS-12', '--set', 'priority=urgent', '--why', 'asked'] }),
      'issue_change',
    ],
    ['forge', JSON.stringify({ argv: ['issue', 'ISS-12', '--blocks', 'ISS-13'] }), 'issue_change'],
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

describe('a typed reply agrees to nothing: the turn has no tool that agrees', () => {
  it('offers no agreeing tool, whether or not a proposal waits', async () => {
    const gate = await agreementGate(inner, turn);
    await gate.tools.execute('forge_feedback', feedback('Draft lost'));
    expect(gate.tools.tools.map((t) => t.function.name)).toEqual(['forge_feedback']);
  });

  it('tells the model only the press records it, and a typed yes or no writes nothing', async () => {
    const gate = await agreementGate(inner, turn);
    const r = await gate.tools.execute('forge_feedback', feedback('Draft lost'));
    expect(text(r)).toContain('Only their press records it');
    expect(text(r)).toContain('a reply they type, yes or no, writes nothing');
    expect(text(r)).not.toContain('forge_agree');
  });
});

describe('a project change from the Assistant is held, and needs the org admin to be offered', () => {
  const setName = JSON.stringify({ argv: ['project', 'forge', '--set', 'name=Forge 2'] });

  it('holds forge project --set for an org admin as a project change, writing nothing', async () => {
    role = 'admin';
    const gate = await agreementGate(inner, turn);
    const r = await gate.tools.execute('forge', setName);
    expect(text(r)).toContain('(kind project_change)');
    expect(held.map((h) => h.kind)).toEqual(['project_change']);
    expect(writes).toEqual([]);
  });

  it('refuses a project member who is no org admin for the right they lack, holding nothing', async () => {
    const gate = await agreementGate(inner, turn);
    const r = await gate.tools.execute('forge', setName);
    expect(text(r)).toContain('needs org.admin');
    expect(held).toEqual([]);
    expect(writes).toEqual([]);
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

describe('every write is held or refused by default: one rule, not a list of held tools (ISS-439 round 3)', () => {
  it("refuses a write no card carries by name, before the tool runs (the judge's forge_channel draft)", async () => {
    const gate = await agreementGate(inner, turn);
    const r = await gate.tools.execute(
      'forge_channel',
      JSON.stringify({ action: 'draft', type: 'change-notice', subject: 'x' }),
    );
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('CHAT_WRITE_REFUSED');
    expect(text(r)).toContain('channel document');
    expect(writes).toEqual([]);
    expect(held).toEqual([]);
  });

  it('refuses a tool added later that declares no grant and no list names, never letting it write', async () => {
    const gate = await agreementGate(inner, turn);
    const r = await gate.tools.execute('forge_new_writer', JSON.stringify({ title: 'x' }));
    expect(text(r)).toContain('CHAT_WRITE_REFUSED');
    expect(text(r)).toContain('write no list names');
    expect(writes).toEqual([]);
  });

  it('refuses a tool whose declared grant is a write that no hold and no list names', async () => {
    GRANTS.forge_brand_new = 'projects:write';
    try {
      const gate = await agreementGate(inner, turn);
      const r = await gate.tools.execute('forge_brand_new', '{}');
      expect(text(r)).toContain('CHAT_WRITE_REFUSED');
      expect(writes).toEqual([]);
    } finally {
      delete GRANTS.forge_brand_new;
    }
  });

  it('lets through a call the one list names as not a business write: a block drawn into the room, a UI move', async () => {
    const gate = await agreementGate(inner, turn);
    await gate.tools.execute('forge_show', JSON.stringify({ block: { kind: 'kpi' } }));
    await gate.tools.execute('ui_navigate', JSON.stringify({ to: '/projects/forge' }));
    expect(writes).toEqual(['forge_show', 'ui_navigate']);
    expect(held).toEqual([]);
  });
});
