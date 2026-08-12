import { beforeEach, describe, expect, it, vi } from 'vitest';

const applyUxScan = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const assertPrincipalIsAdmin = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('../../projects/ux-stack-apply.js', () => ({
  applyUxScan: (...args: unknown[]) => applyUxScan(...args),
}));

vi.mock('./lib.js', () => ({
  assertPrincipalIsAdmin: (...args: unknown[]) => assertPrincipalIsAdmin(...args),
  resolveEffectiveProjectId: async (_ctx: unknown, id?: string) => id ?? PROJECT_ID,
  zodToMcpSchema: () => ({}),
}));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const { forgeUxScanTool } = await import('./forge-ux-scan.js');

const tool = forgeUxScanTool({
  principal: { kind: 'pat', userId: USER_ID },
} as never);
const scan = (over: Record<string, unknown> = {}) =>
  tool.handler({
    projectId: PROJECT_ID,
    packageDir: 'packages/web-v2',
    dependencies: { react: '^19.0.0' },
    filePaths: ['src/app/page.tsx'],
    ...over,
  });

describe('forge_ux_scan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertPrincipalIsAdmin.mockResolvedValue(undefined);
    applyUxScan.mockResolvedValue({
      mode: 'created',
      detected: { ownLibrary: false },
      proposed: 0,
    });
  });

  it('submits a valid snapshot after the admin gate passes', async () => {
    await expect(scan()).resolves.toEqual({
      ok: true,
      mode: 'created',
      detected: { ownLibrary: false },
      proposed: 0,
    });
    expect(assertPrincipalIsAdmin).toHaveBeenCalledWith(
      { kind: 'pat', userId: USER_ID },
      PROJECT_ID,
    );
    expect(applyUxScan).toHaveBeenCalledWith(PROJECT_ID, {
      packageDir: 'packages/web-v2',
      dependencies: { react: '^19.0.0' },
      filePaths: ['src/app/page.tsx'],
    });
  });

  it('refuses a member who is not an admin', async () => {
    assertPrincipalIsAdmin.mockRejectedValueOnce(
      new Error('FORBIDDEN: requires project admin access'),
    );

    await expect(scan()).rejects.toThrow(/FORBIDDEN/);
    expect(applyUxScan).not.toHaveBeenCalled();
  });

  it.each([
    [
      'too many dependencies',
      {
        dependencies: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`dep-${i}`, '1'])),
      },
    ],
    [
      'too many file paths',
      { filePaths: Array.from({ length: 4001 }, (_, i) => `src/file-${i}.ts`) },
    ],
    ['an absolute package directory', { packageDir: '/packages/web-v2' }],
    ['an option-like package directory', { packageDir: '--work-tree=/tmp' }],
    ['a parent traversal package directory', { packageDir: 'packages/../web-v2' }],
  ])('rejects %s before authorization or persistence', async (_label, input) => {
    await expect(scan(input)).rejects.toThrow();
    expect(assertPrincipalIsAdmin).not.toHaveBeenCalled();
    expect(applyUxScan).not.toHaveBeenCalled();
  });
});
