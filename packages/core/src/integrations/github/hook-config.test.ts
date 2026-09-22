/**
 * ISS-1140 — asking GitHub where it is calling, and refusing to guess when it will not say.
 *
 * Every case here is about the same rule: a read that did not succeed must come back as a read
 * that did not succeed. The failure mode this module exists to prevent is an unknown quietly
 * becoming a green, which is how a binding reported `ok` for three days while GitHub was calling
 * a host that serves no such route.
 */

import { describe, expect, it, vi } from 'vitest';
import { readAppHookConfig } from './hook-config.js';

// A syntactically valid RSA key is not needed: `buildAppJwt` signs with it and nothing here
// verifies the signature, but the signer does have to accept it, so this is a real generated key.
const { generateKeyPairSync } = await import('node:crypto');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const answering = (status: number, body: unknown, ok = status < 400) =>
  vi.fn(
    async () =>
      ({
        ok,
        status,
        json: async () => body,
      }) as unknown as Response,
  );

const read = (fetchImpl: ReturnType<typeof answering>) =>
  readAppHookConfig({ appId: '1234', privateKey: PEM, fetchImpl: fetchImpl as typeof fetch });

describe('reading the App s webhook configuration', () => {
  it('returns the url and the active flag GitHub answered with', async () => {
    await expect(
      read(answering(200, { url: 'https://api.example.test/api/webhooks/in/x', active: true })),
    ).resolves.toEqual({
      read: true,
      url: 'https://api.example.test/api/webhooks/in/x',
      active: true,
    });
  });

  it('asks the App-level route, as the App, and at the configured api base', async () => {
    const fetchImpl = answering(200, { url: 'u', active: true });
    await readAppHookConfig({
      appId: '1234',
      privateKey: PEM,
      apiBaseUrl: 'https://ghe.example/api/v3/',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ghe.example/api/v3/app/hook/config');
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer ey/);
  });

  // An absent flag is UNKNOWN. Reading it as `true` would turn a hook nobody can see the state of
  // into a hook reported as on.
  it('reports an absent active flag as unknown rather than as on', async () => {
    await expect(read(answering(200, { url: 'https://x.test/hook' }))).resolves.toEqual({
      read: true,
      url: 'https://x.test/hook',
      active: null,
    });
  });

  it('reports an absent url as no address rather than as an empty one that matches nothing', async () => {
    await expect(read(answering(200, { active: true }))).resolves.toEqual({
      read: true,
      url: null,
      active: true,
    });
  });

  it('names a rejected App JWT rather than reporting an address', async () => {
    const out = await read(answering(401, {}));
    expect(out.read).toBe(false);
    expect(out.read === false && out.reason).toMatch(/App id and private key/);
  });

  it('carries the status of any other refusal', async () => {
    const out = await read(answering(502, {}));
    expect(out.read).toBe(false);
    expect(out.read === false && out.reason).toMatch(/HTTP 502/);
  });

  it('turns a transport failure into a read that did not happen, not a throw', async () => {
    const out = await readAppHookConfig({
      appId: '1234',
      privateKey: PEM,
      fetchImpl: (async () => {
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch,
    });
    expect(out.read).toBe(false);
    expect(out.read === false && out.reason).toMatch(/ECONNRESET/);
  });

  it('refuses a body that is not json rather than reading it as an App with no webhook', async () => {
    const out = await read(
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError('not json');
            },
          }) as unknown as Response,
      ) as ReturnType<typeof answering>,
    );
    expect(out.read).toBe(false);
    expect(out.read === false && out.reason).toMatch(/not JSON/);
  });
});
