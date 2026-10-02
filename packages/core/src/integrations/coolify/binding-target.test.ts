import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoolifyApiError } from './client.js';

const h = vi.hoisted(() => ({
  apps: vi.fn(async (_auth: unknown) => [{ uuid: 'aaaaaaaaaaaaaaaaaaaa' }] as { uuid: string }[]),
  secrets: { apiToken: 'tok-12345678' } as Record<string, unknown>,
}));

vi.mock('./controls.js', () => ({
  fetchCoolifyApplications: h.apps,
  credentialFromSecrets: (config: { baseUrl: string }, secrets: { apiToken: string }) => ({
    baseUrl: config.baseUrl,
    apiToken: secrets.apiToken,
  }),
}));
vi.mock('../store.js', () => ({ decryptConnectionSecrets: () => h.secrets }));

const { verifyCoolifyBindingTarget } = await import('./binding-target.js');

const KNOWN = 'aaaaaaaaaaaaaaaaaaaa';
const TYPO = 'bbbbbbbbbbbbbbbbbbbb';
const connection = { secretsEnc: null, config: { baseUrl: 'https://coolify.example' } };
const targets = (...uuids: string[]) => ({
  targets: uuids.map((resourceUuid, i) => ({ id: `t${i}`, label: `t${i}`, resourceUuid })),
});

beforeEach(() => {
  h.apps.mockClear();
  h.apps.mockResolvedValue([{ uuid: KNOWN }]);
  h.secrets = { apiToken: 'tok-12345678' };
});

describe('verifying the Coolify applications a binding names', () => {
  it('passes an application Coolify lists, asking with the connection credential', async () => {
    expect(
      await verifyCoolifyBindingTarget({
        projectId: 'p',
        connection,
        config: targets(KNOWN),
        held: null,
      }),
    ).toEqual([]);
    expect(h.apps).toHaveBeenCalledWith({
      baseUrl: 'https://coolify.example',
      apiToken: 'tok-12345678',
    });
  });

  it('refuses an application Coolify does not list, at its own index', async () => {
    expect(
      await verifyCoolifyBindingTarget({
        projectId: 'p',
        connection,
        config: targets(KNOWN, TYPO),
        held: null,
      }),
    ).toEqual([
      expect.objectContaining({
        code: 'COOLIFY_APPLICATION_UNKNOWN',
        path: '/applications/1/resourceUuid',
        detail: expect.stringContaining(TYPO),
      }),
    ]);
  });

  it('asks nothing about applications the row already holds', async () => {
    expect(
      await verifyCoolifyBindingTarget({
        projectId: 'p',
        connection,
        config: targets(TYPO),
        held: targets(TYPO),
      }),
    ).toEqual([]);
    expect(h.apps).not.toHaveBeenCalled();
  });

  it('refuses as unreachable when Coolify cannot be asked, rather than storing an unverified id', async () => {
    h.apps.mockRejectedValueOnce(new Error('fetch failed'));
    expect(
      await verifyCoolifyBindingTarget({
        projectId: 'p',
        connection,
        config: targets(KNOWN),
        held: null,
      }),
    ).toEqual([
      expect.objectContaining({
        code: 'COOLIFY_UNREACHABLE',
        path: '/applications',
        detail: expect.stringContaining('fetch failed'),
      }),
    ]);
  });

  it("names the token's missing ability when Coolify refuses the listing", async () => {
    h.apps.mockRejectedValueOnce(
      new CoolifyApiError(403, '', 'forbidden', 'GET /api/v1/applications'),
    );
    const [refusal] = await verifyCoolifyBindingTarget({
      projectId: 'p',
      connection,
      config: targets(KNOWN),
      held: null,
    });
    expect(refusal).toMatchObject({
      code: 'COOLIFY_UNREACHABLE',
      detail: expect.stringContaining('HTTP 403'),
    });
  });

  it('refuses as unreachable when the connection holds no token to ask with', async () => {
    h.secrets = {};
    expect(
      await verifyCoolifyBindingTarget({
        projectId: 'p',
        connection,
        config: targets(KNOWN),
        held: null,
      }),
    ).toEqual([expect.objectContaining({ code: 'COOLIFY_UNREACHABLE' })]);
    expect(h.apps).not.toHaveBeenCalled();
  });
});
