// @gate-input whole-tree — storing a key runs the real ssh-keygen, which the root-walk guard cannot see into.
/**
 * ISS-1421 r13 — criteria 145 and 146 could not be judged on beta, because Forge refuses at upload a
 * key ssh cannot load. What still reaches a stored key afterwards is a ciphertext the vault cannot
 * open (its master key changed, or the row was damaged), and Test connection answered that with a
 * bare 500 DECRYPT_FAILED. Here, against real Postgres and the real routes: a stored key the vault
 * cannot open answers key_unreadable in the same words as one ssh cannot load, on the project's Test
 * connection and on the workspace pool's; and storing a malformed key is refused in a plain sentence,
 * its code in the code field rather than at the front of the sentence.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

vi.mock('node:dns', async (importOriginal) =>
  (await import('../helpers/git-host-fixture.js')).publicDns(await importOriginal()),
);

const UNREADABLE =
  'Forge could not read the stored deploy key, so it was never offered to the git host. Detach it and generate a new one.';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let token: string;
let orgId: string;
let projectId: string;
let keyId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  const [projectRoutes, orgRoutes, err] = await Promise.all([
    import('../../src/projects/git-credential-routes.js'),
    import('../../src/orgs/ssh-keys-routes.js'),
    import('../../src/middleware/error.js'),
  ]);
  app = new Hono();
  app.route('/api/projects', projectRoutes.gitCredentialRoutes);
  app.route('/api/orgs', orgRoutes.sshKeyRoutes);
  app.onError(err.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const user = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  orgId = (await seedOrg(harness.db, user.id)).id;
  projectId = (await createTestProject(harness.db, user.id, { orgId })).id;
  const { signUserToken } = await import('../../src/auth/jwt.js');
  token = await signUserToken(user.id);
  const { encryptSecret } = await import('../../src/integrations/vault.js');
  const sealed = Buffer.from(encryptSecret('-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n'));
  // One flipped byte in the auth tag's reach: the vault refuses it, as after a master key change.
  sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 0xff;
  keyId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO workspace_ssh_keys (id, org_id, name, source, public_key, private_key_enc)
    VALUES (${keyId}, ${orgId}, 'Forge x GitLab', 'user_provided', 'ssh-ed25519 AAAA test', ${sealed})
  `);
  await harness.db.execute(
    sql`UPDATE projects SET repo_url = 'git@gitlab.com:sid/desk.git' WHERE id = ${projectId}`,
  );
  await harness.db.execute(
    sql`INSERT INTO project_git_credentials (project_id, ssh_key_id) VALUES (${projectId}, ${keyId})`,
  );
});

const post = (path: string, body: unknown = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('a stored deploy key Forge cannot decrypt (criterion 145)', () => {
  it("answers the project's Test connection as key_unreadable, never a 500", async () => {
    const res = await post(`/api/projects/${projectId}/git-credential/test`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, code: 'key_unreadable', message: UNREADABLE });
  });

  it("answers the workspace pool's Test connection the same way", async () => {
    const res = await post(`/api/orgs/${orgId}/ssh-keys/${keyId}/test`, {
      repoUrl: 'git@gitlab.com:sid/desk.git',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, code: 'key_unreadable', message: UNREADABLE });
  });
});

describe("the workspace pool's Test connection on a URL it will not probe", () => {
  it('refuses it in a capitalised sentence, as the project Test connection does', async () => {
    const res = await post(`/api/orgs/${orgId}/ssh-keys/${keyId}/test`, {
      repoUrl: 'file:///srv/x',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('INVALID_TRANSPORT');
    expect(body.message).toMatch(/^Set an SSH clone URL/);
    expect(body.message).toMatch(/[.)]$/);
  });
});

describe('storing a private key ssh cannot load', () => {
  it('is refused in a plain sentence, the code in its own field', async () => {
    const res = await post(`/api/orgs/${orgId}/ssh-keys`, {
      mode: 'provide',
      name: 'Pasted',
      privateKey: 'not a key',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('INVALID_PRIVATE_KEY');
    expect(body.message).toBe(
      'Forge could not read this SSH private key. Paste the whole key in OpenSSH format, from its BEGIN line to its END line.',
    );
    expect(body.message).not.toMatch(/invalid_private_key/i);
  });

  // ISS-1421 r14 — judge-61: a passphrase-protected key got no answer at all; ssh-keygen read its
  // open stdin for the passphrase until the proxy closed the request with a 524.
  it('is refused at once for a passphrase-protected key, in a sentence of its own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-prot-key-'));
    try {
      execFileSync('ssh-keygen', [
        '-q',
        '-t',
        'ed25519',
        '-N',
        'a passphrase',
        '-f',
        join(dir, 'k'),
      ]);
      const started = Date.now();
      const res = await post(`/api/orgs/${orgId}/ssh-keys`, {
        mode: 'provide',
        name: 'Protected',
        privateKey: readFileSync(join(dir, 'k'), 'utf8'),
      });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        code: string;
        message: string;
        details?: { reason?: string };
      };
      expect(body.code).toBe('INVALID_PRIVATE_KEY');
      expect(body.message).toBe(
        'Forge could not read this SSH private key, because a passphrase protects it. Forge uses keys unattended, so paste one without a passphrase or generate one here.',
      );
      expect(body.details?.reason).toBe('passphrase');
      const stored = await harness.db.execute(
        sql`SELECT id FROM workspace_ssh_keys WHERE name = 'Protected'`,
      );
      expect(stored).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
