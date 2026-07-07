import { describe, expect, it, vi } from 'vitest';

// system.ts imports db/client (which eagerly validates env) — stub both so this
// pure-function suite stays hermetic (same pattern as agent-sessions/chat-turn.test.ts).
vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { buildChatRoleSection } = await import('./system.js');

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
