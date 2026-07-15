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

/** Queue one `db.select(...).from(...).where(...).limit(...)` result per call, in order. */
function queueSelects(...rowsList: Row[][]): void {
  // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
  const mockDb = db as any;
  mockDb.select.mockReset();
  for (const rows of rowsList) {
    mockDb.select.mockImplementationOnce(() => ({
      from: () => ({ where: () => ({ limit: async () => rows }) }),
    }));
  }
}

const PROJECT_ID = 'p1';
const USER_ID = 'u1';

describe('buildChatPreamble — lens override (ISS-674)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('forceLenses=["product"] pins the product voice and skips the member-lens DB lookup', async () => {
    // Only loadProjectBranches should query the DB — resolveMemberLenses (the
    // principal-lens inheritance path) must never fire when the pin is set.
    queueSelects([{ baseBranch: 'main', productionBranch: 'main' }]);

    const preamble = await buildChatPreamble(PROJECT_ID, USER_ID, ['product']);

    expect(preamble).toContain('Speak their language');
    expect(preamble).not.toContain('implementation depth');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    expect((db as any).select).toHaveBeenCalledTimes(1);
  });

  it('no forceLenses (normal chat) still resolves the principal member lens', async () => {
    queueSelects(
      [{ baseBranch: 'main', productionBranch: 'main' }], // loadProjectBranches
      [{ orgId: 'org1' }], // resolveMemberLenses: project → orgId
      [{ lenses: ['technical'] }], // resolveMemberLenses: member row
    );

    const preamble = await buildChatPreamble(PROJECT_ID, USER_ID);

    expect(preamble).toContain('implementation depth');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    expect((db as any).select).toHaveBeenCalledTimes(3);
  });
});
