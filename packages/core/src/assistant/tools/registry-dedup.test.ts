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
vi.mock('../../issues/issue-prefix-read.js', () => ({
  activeIssuePrefix: async () => null,
  heldIssuePrefixes: async () => ['APP'],
}));
/** Every call the duplicate detector was asked for, so a case can prove it was NOT asked. */
const duplicateCalls: unknown[] = [];
vi.mock('./issue-dedup.js', () => ({
  findDuplicateIssue: async (...args: unknown[]) => {
    duplicateCalls.push(args);
    return { id: 'x', issSeq: 7, title: 'Dark mode broken on settings' };
  },
}));

const { CHAT_TOOL_ALLOWLIST } = await import('./registry.js');

const guard = CHAT_TOOL_ALLOWLIST.find((s) => s.allowedActions?.includes('create'))?.guard;

/** A bug body carrying every section `cli/kinds.ts` makes a bug owe, so a case about the dedup reaches the dedup. */
const WHOLE_BUG_BODY = [
  '## What happened',
  'On the profile page with dark mode on the header keeps its light background.',
  '',
  '## Why it happens',
  'The header reads the theme from a prop the profile route never passes down.',
  '',
  '## Outcome',
  'The header follows the active theme on the profile page like every other page.',
  '',
  '## Rules',
  'A page that switches theme switches every element inside it, header included.',
  '',
  '## Out of scope',
  'The theme toggle control itself is unchanged by this.',
].join('\n');

function createArgs(data: Record<string, unknown>): Record<string, unknown> {
  return {
    action: 'create',
    data: {
      title: '[Bug] Dark mode broken on the profile page',
      description: WHOLE_BUG_BODY,
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

describe('create-path shape guard (ISS-1006)', () => {
  it('refuses a body with no rules heading, and names the section', async () => {
    const args = createArgs({
      description: WHOLE_BUG_BODY.replace(/## Rules\n.*\n/u, ''),
    });
    const rejection = await guard?.(args, { projectId: 'p1' });
    expect(rejection).toContain('Rules');
    expect(rejection).toContain('required of a bug');
  });

  it('lets a whole body through to the duplicate check', async () => {
    const rejection = await guard?.(createArgs({ confirmNotDuplicate: true }), {
      projectId: 'p1',
    });
    expect(rejection).toBeNull();
  });

  // cm:guard a filing naming NO category PASSES, and that is the plugin's decision rather than a hole: `forge new -h` states it — "a create sent through the tracker's own tool carries no flag to refuse, so one arriving there is read as a feature". Core used to refuse here; restoring that refusal would be the server overruling the reader it delegates to (ISS-1006).
  it('reads a filing naming no category as a feature, the way the plugin does', async () => {
    const rejection = await guard?.(
      createArgs({ category: undefined, confirmNotDuplicate: true }),
      {
        projectId: 'p1',
      },
    );
    expect(rejection).toBeNull();
  });

  it('refuses a title naming a file path', async () => {
    const rejection = await guard?.(
      createArgs({ title: 'Dark mode broken in src/profile/header.tsx' }),
      { projectId: 'p1' },
    );
    expect(rejection).toContain('file path in the title');
  });

  it('refuses an html body by naming markdown, never by naming the sections it carries', async () => {
    const rejection = await guard?.(createArgs({ descriptionFormat: 'html' }), {
      projectId: 'p1',
    });
    expect(rejection).toContain('markdown');
    expect(rejection).not.toContain('required of a bug');
  });

  it("refuses a parts claim, by the plugin's own arm", async () => {
    const rejection = await guard?.(
      createArgs({ description: `${WHOLE_BUG_BODY}\n\nIts parts are ISS-1 and ISS-2.` }),
      { projectId: 'p1' },
    );
    expect(rejection).toContain("as this issue's parts");
  });

  /**
   * Two things this door INHERITS by delegating, asserted so neither is a surprise.
   */
  // cm:guard both are forge-plugin's and are reported there, never worked around here: a server-side override is the third reader ISS-1006 removed, and the whole point of one reader is that a fix in it reaches both doors. The `clear` names `--with`, a flag no chat caller holds; the parts arm matches `ISS-` alone, so a held `APP-` prefix is invisible to it (ISS-261).
  it("inherits the plugin's CLI-shaped way out, and the prefix its parts arm cannot see", async () => {
    const parts = await guard?.(
      createArgs({ description: `${WHOLE_BUG_BODY}\n\nIts parts are ISS-1 and ISS-2.` }),
      { projectId: 'p1' },
    );
    expect(parts).toContain('--with');

    const appPrefix = await guard?.(
      createArgs({
        description: `${WHOLE_BUG_BODY}\n\nIts parts are APP-1 and APP-2.`,
        confirmNotDuplicate: true,
      }),
      { projectId: 'p1' },
    );
    expect(appPrefix).toBeNull();
  });

  it('runs no duplicate query for a filing it refuses on shape', async () => {
    duplicateCalls.length = 0;
    await guard?.(createArgs({ description: 'nothing like a body' }), { projectId: 'p1' });
    expect(duplicateCalls).toEqual([]);
  });
});
