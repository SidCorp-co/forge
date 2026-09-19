import { afterEach, describe, expect, it, vi } from 'vitest';

// system.ts imports db/client (which eagerly validates env) — stub both so this
// pure-function suite stays hermetic (same pattern as agent-sessions/chat-turn.test.ts).
vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../db/client.js', () => {
  const select = vi.fn();
  return { db: { select } };
});

const { db } = await import('../db/client.js');
const { buildChatRoleSection, buildChatPreamble } = await import('./system.js');

const { registerAllIntegrations } = await import('../integrations/register-all.js');
registerAllIntegrations();

describe('buildChatRoleSection — role-aware chat lens', () => {
  it('no lens assigned → non-technical default voice (unchanged behaviour)', () => {
    const s = buildChatRoleSection([]);
    expect(s).toContain('non-technical');
    expect(s).toContain('Speak their language');
    expect(s).not.toContain('implementation depth');
  });

  it('product lens → same non-technical default', () => {
    const s = buildChatRoleSection(['product']);
    expect(s).toContain('non-technical');
    expect(s).not.toContain('implementation depth');
  });

  it('technical lens → implementation-depth voice, drops the non-technical default', () => {
    const s = buildChatRoleSection(['technical']);
    expect(s).toContain('implementation depth');
    expect(s).toContain('path:line');
    expect(s).not.toContain('non-technical by default');
  });

  it('both lenses → blended: outcome first, then technical detail', () => {
    const s = buildChatRoleSection(['technical', 'product']);
    expect(s).toContain('BOTH product and engineering');
    expect(s).toContain('Lead with the outcome');
  });

  it('every variant keeps the shared security posture + no-auto-implement rule', () => {
    const variants: ReadonlyArray<readonly ('technical' | 'product')[]> = [
      [],
      ['product'],
      ['technical'],
      ['technical', 'product'],
    ];
    for (const lenses of variants) {
      const s = buildChatRoleSection(lenses);
      expect(s).toContain('NEVER reveal secrets');
      expect(s).toContain('Do NOT jump into writing or changing code');
    }
  });
});

type Row = Record<string, unknown>;

/**
 * Queue one result per `db.select()` call, in order. The returned chain covers
 * both shapes the preamble path uses: `from→where→limit` (project/member rows)
 * and `from→innerJoin→where→orderBy` (listBindingsForProject).
 */
function queueSelects(...rowsList: Row[][]): void {
  // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
  const mockDb = db as any;
  mockDb.select.mockReset();
  for (const rows of rowsList) {
    mockDb.select.mockImplementationOnce(() => {
      const terminal = {
        limit: async () => rows,
        orderBy: async () => rows,
      };
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => terminal,
        ...terminal,
      };
      return chain;
    });
  }
}

const PROJECT_ID = 'p1';
const USER_ID = 'u1';

describe('buildChatPreamble — lens override (ISS-674)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('forceLenses=["product"] pins the product voice and skips the member-lens DB lookup', async () => {
    queueSelects(
      [{ baseBranch: 'main', liveBranch: 'main' }], // loadProjectBranches
      [],
    );

    const preamble = await buildChatPreamble(PROJECT_ID, USER_ID, ['product']);

    expect(preamble).toContain('Speak their language');
    expect(preamble).not.toContain('implementation depth');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    expect((db as any).select).toHaveBeenCalledTimes(2);
  });

  it('no forceLenses (normal chat) still resolves the principal member lens', async () => {
    queueSelects(
      [{ baseBranch: 'main', liveBranch: 'main' }], // loadProjectBranches
      [{ orgId: 'org1' }], // resolveMemberLenses: project → orgId
      [{ lenses: ['technical'] }], // resolveMemberLenses: member row
      [],
    );

    const preamble = await buildChatPreamble(PROJECT_ID, USER_ID);

    expect(preamble).toContain('implementation depth');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    expect((db as any).select).toHaveBeenCalledTimes(4);
  });
});

describe('buildChatPreamble — integrations + MCP diagnostics', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const BRANCHES = [{ baseBranch: 'main', liveBranch: 'main' }];
  const ACTIVE_EPODSYSTEM = [
    {
      binding: {
        provider: 'epodsystem',
        environment: 'prod',
        active: true,
        // ISS-1071 — the grant is a field on the binding, and it is what decides whether this
        // preamble tells a session how to use the integration or why it cannot.
        agentAccess: 'all',
      },
      connection: { active: true, lastHealthStatus: 'ok', config: {} },
    },
  ];

  it('renders the connected-integration tool-routing hint into a chat turn', async () => {
    queueSelects(BRANCHES, ACTIVE_EPODSYSTEM);

    const preamble = await buildChatPreamble(PROJECT_ID, null, ['technical']);

    expect(preamble).toContain('Project integrations');
    expect(preamble).toContain('epodsystem');
    expect(preamble).toContain('forge_storefront_target');
    expect(preamble).toContain('DRAFT theme');
  });

  // ISS-1038 — the same connected, healthy, active binding with agent access OFF. Before this, the
  // preamble printed the identical "reach for `forge_storefront_target`" line, so a session was sent
  // after tools it would never be handed and read their absence as a credential fault.
  it('tells a chat turn WHY an ungranted integration reaches it, instead of how to use it', async () => {
    queueSelects(BRANCHES, [
      {
        binding: { provider: 'epodsystem', environment: 'prod', active: true, agentAccess: 'none' },
        connection: { active: true, lastHealthStatus: 'ok', config: {} },
      },
    ]);

    const preamble = await buildChatPreamble(PROJECT_ID, null, ['technical']);

    // The provider is named INSIDE the reason. A preamble carries every connected integration, so
    // "agent access is off for this binding" on its own would not say WHICH one was refused.
    expect(preamble).toContain('agent access is off for this `epodsystem` binding');
    expect(preamble).toContain('Settings → Integrations');
    // The usage hint is REPLACED, not accompanied: a line saying how to use a tool the session will
    // not be given is the thing being removed, not something to print beside the reason.
    expect(preamble).not.toContain('forge_storefront_target');
    expect(preamble).not.toContain('DRAFT theme');
  });

  it('omits an integration whose connection is inactive', async () => {
    queueSelects(BRANCHES, [
      {
        binding: { provider: 'epodsystem', environment: 'prod', active: true },
        connection: { active: false, lastHealthStatus: 'ok', config: {} },
      },
    ]);

    const preamble = await buildChatPreamble(PROJECT_ID, null, ['technical']);

    expect(preamble).not.toContain('Project integrations');
  });

  it('warns about a declared sentinel that did not resolve', async () => {
    queueSelects(BRANCHES, []);

    const preamble = await buildChatPreamble(PROJECT_ID, null, ['technical'], {
      resolved: ['playwright'],
      dropped: ['epodsystem'],
    });

    expect(preamble).toContain('MCP servers — this session');
    expect(preamble).toContain('`mcp__playwright__*`');
    expect(preamble).toContain('did NOT resolve: `epodsystem`');
  });

  it('stays silent when every declared server resolved', async () => {
    queueSelects(BRANCHES, []);

    const preamble = await buildChatPreamble(PROJECT_ID, null, ['technical'], {
      resolved: ['playwright', 'epodsystem'],
      dropped: [],
    });

    expect(preamble).not.toContain('MCP servers — this session');
  });
});
