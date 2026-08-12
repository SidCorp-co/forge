import { beforeEach, describe, expect, it, vi } from 'vitest';

const applyUxScan = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const reserveUxScanGeneration = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const assertPrincipalIsAdmin = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const verifyUxScanAuthorization = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const sessionReturning = vi.fn();
const sessionWhere = vi.fn(() => ({ returning: sessionReturning }));
const sessionSet = vi.fn(() => ({ where: sessionWhere }));

vi.mock('../../db/client.js', () => ({
  db: { update: vi.fn(() => ({ set: sessionSet })) },
}));

vi.mock('../../projects/ux-stack-apply.js', () => ({
  applyUxScan: (...args: unknown[]) => applyUxScan(...args),
  reserveUxScanGeneration: (...args: unknown[]) => reserveUxScanGeneration(...args),
}));

vi.mock('../../projects/ux-scan-authorization.js', () => ({
  verifyUxScanAuthorization: (...args: unknown[]) => verifyUxScanAuthorization(...args),
}));

vi.mock('./lib.js', () => ({
  assertPrincipalIsAdmin: (...args: unknown[]) => assertPrincipalIsAdmin(...args),
  resolveEffectiveProjectId: async (_ctx: unknown, id?: string) => id ?? PROJECT_ID,
  zodToMcpSchema: () => ({}),
}));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';

const { forgeUxScanTool } = await import('./forge-ux-scan.js');

function scanFor(principal: unknown, over: Record<string, unknown> = {}) {
  return forgeUxScanTool({ principal } as never).handler({
    projectId: PROJECT_ID,
    packageDir: 'packages/web-v2',
    dependencies: { react: '^19.0.0' },
    filePaths: ['src/app/page.tsx'],
    ...over,
  });
}

const adminPrincipal = { kind: 'pat', userId: USER_ID };
const scan = (over: Record<string, unknown> = {}) => scanFor(adminPrincipal, over);

describe('forge_ux_scan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertPrincipalIsAdmin.mockResolvedValue(undefined);
    verifyUxScanAuthorization.mockResolvedValue({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      authorizationId: 'authorization-1',
      userId: USER_ID,
      generation: 2,
    });
    reserveUxScanGeneration.mockResolvedValue(1);
    sessionReturning.mockResolvedValue([{ id: SESSION_ID }]);
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
    expect(applyUxScan).toHaveBeenCalledWith(
      PROJECT_ID,
      {
        packageDir: 'packages/web-v2',
        dependencies: { react: '^19.0.0' },
        filePaths: ['src/app/page.tsx'],
      },
      1,
    );
  });

  it('refuses a member who is not an admin', async () => {
    assertPrincipalIsAdmin.mockRejectedValueOnce(
      new Error('FORBIDDEN: requires project admin access'),
    );

    await expect(scan()).rejects.toThrow(/FORBIDDEN/);
    expect(applyUxScan).not.toHaveBeenCalled();
  });

  it('accepts an admin-dispatched scan on its selected member-owned runner', async () => {
    await expect(
      scanFor(
        { kind: 'device', device: { id: DEVICE_ID, ownerId: 'member-id' } },
        { authorization: 'signed-authorization' },
      ),
    ).resolves.toMatchObject({ ok: true });

    expect(assertPrincipalIsAdmin).not.toHaveBeenCalled();
    expect(verifyUxScanAuthorization).toHaveBeenCalledWith('signed-authorization');
    expect(sessionWhere).toHaveBeenCalledOnce();
  });

  it('refuses a delegated scan authorization from a PAT', async () => {
    await expect(scan({ authorization: 'signed-authorization' })).rejects.toThrow(/FORBIDDEN/);
    expect(applyUxScan).not.toHaveBeenCalled();
  });

  it('refuses a delegated scan authorization from another runner', async () => {
    sessionReturning.mockResolvedValueOnce([]);

    await expect(
      scanFor(
        { kind: 'device', device: { id: OTHER_PROJECT_ID, ownerId: 'member-id' } },
        { authorization: 'signed-authorization' },
      ),
    ).rejects.toThrow(/FORBIDDEN/);
    expect(applyUxScan).not.toHaveBeenCalled();
  });

  it('refuses a delegated scan authorization for another project', async () => {
    verifyUxScanAuthorization.mockResolvedValueOnce({
      projectId: OTHER_PROJECT_ID,
      sessionId: SESSION_ID,
      authorizationId: 'authorization-1',
      userId: USER_ID,
    });

    await expect(
      scanFor(
        { kind: 'device', device: { id: DEVICE_ID, ownerId: 'member-id' } },
        { authorization: 'signed-authorization' },
      ),
    ).rejects.toThrow(/FORBIDDEN/);
    expect(applyUxScan).not.toHaveBeenCalled();
  });

  it('refuses an expired or unknown delegated scan authorization', async () => {
    verifyUxScanAuthorization.mockRejectedValueOnce(new Error('invalid authorization'));

    await expect(
      scanFor(
        { kind: 'device', device: { id: DEVICE_ID, ownerId: 'member-id' } },
        { authorization: 'expired-authorization' },
      ),
    ).rejects.toThrow(/invalid authorization/);
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
