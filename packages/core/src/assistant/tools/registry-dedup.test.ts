/**
 * The create-path dedup guard blocks on word overlap, which cannot tell a real
 * repeat from two issues about different screens — so the block has to be
 * escapable, and the escape has to be consumed here rather than forwarded onto
 * a `data` object the issues handler validates strictly.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('./issue-ref.js', () => ({ resolveIssueDisplayId: async () => null }));
vi.mock('./issue-dedup.js', () => ({
  findDuplicateIssue: async () => ({ id: 'x', issSeq: 7, title: 'Dark mode broken on settings' }),
}));

const { CHAT_TOOL_ALLOWLIST } = await import('./registry.js');

const guard = CHAT_TOOL_ALLOWLIST.find((s) => s.allowedActions?.includes('create'))?.guard;

function createArgs(data: Record<string, unknown>): Record<string, unknown> {
  return {
    action: 'create',
    data: {
      title: '[Bug] Dark mode broken on the profile page',
      description:
        'On the profile page with dark mode on, the header keeps the light background while the body switches, so the nav links are white on white. Expected the header to follow the theme like every other page. Reported in #support, reproduced on Chrome 141 and Firefox 145.',
      priority: 'medium',
      category: 'bug',
      ...data,
    },
  };
}

describe('create-path dedup guard', () => {
  it('rejects a near-duplicate and names the way past it', async () => {
    const rejection = await guard?.(createArgs({}), { projectId: 'p1' });
    expect(rejection).toContain('ISS-7');
    expect(rejection).toContain('confirmNotDuplicate');
  });

  it('lets the create through when the model confirms it is not one', async () => {
    const args = createArgs({ confirmNotDuplicate: true });
    expect(await guard?.(args, { projectId: 'p1' })).toBeNull();
  });

  it('strips the flag so it never reaches the strict issues handler', async () => {
    const args = createArgs({ confirmNotDuplicate: true });
    await guard?.(args, { projectId: 'p1' });
    expect(args.data).not.toHaveProperty('confirmNotDuplicate');
  });

  it('strips the flag on the rejected path too', async () => {
    const args = createArgs({ confirmNotDuplicate: false });
    await guard?.(args, { projectId: 'p1' });
    expect(args.data).not.toHaveProperty('confirmNotDuplicate');
  });
});
