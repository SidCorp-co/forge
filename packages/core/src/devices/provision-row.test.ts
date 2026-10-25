import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildProvisionRow,
  integrityViolation,
  PROVISION_FAILURES_BUDGET,
  type ProvisionReport,
  type ProvisionRow,
  provisionFailuresHeader,
} from './provision-row.js';

const row = (over: Partial<ProvisionRow> = {}): ProvisionRow => ({
  runnerId: 'runner-1',
  projectId: 'proj-1',
  slug: 'epod-cli',
  repoPath: '/srv/epod-cli',
  branch: null,
  repoUrl: 'git@github.com:acme/epod-cli.git',
  baseBranch: 'main',
  sshSource: 'generated',
  sshPublicKey: 'ssh-ed25519 AAAA',
  sshPrivateKeyEnc: null,
  ...over,
});

const ctx = { deviceId: 'dev-1', holderUserId: 'agent-7', githubAppCredential: false };
const violation = (constraint = 'pat_user_name_uniq') =>
  Object.assign(new Error('duplicate key value'), { code: '23505', constraint_name: constraint });

describe('integrityViolation', () => {
  it('reads a SQLSTATE class 23 off the error itself', () => {
    expect(integrityViolation(violation())).toBe('23505:pat_user_name_uniq');
  });

  it('reads one off a cause drizzle wrapped, which is the shape the endpoint actually meets', () => {
    const wrapped = new Error('Failed query: insert into "personal_access_tokens" …', {
      cause: violation(),
    });
    expect(integrityViolation(wrapped)).toBe('23505:pat_user_name_uniq');
  });

  it('is null for a connection error, which says nothing about the next attempt', () => {
    expect(integrityViolation(Object.assign(new Error('timeout'), { code: '57014' }))).toBeNull();
    expect(integrityViolation(new Error('socket hang up'))).toBeNull();
    expect(integrityViolation(null)).toBeNull();
  });
});

describe('buildProvisionRow', () => {
  it('serves the provision and reports nothing when the mint succeeds', async () => {
    const built = await buildProvisionRow(row(), ctx, {
      issueCredential: async () => 'forge_pat_dev_ok',
    });
    expect(built.reports).toEqual([]);
    expect(built.provision).toMatchObject({
      runnerId: 'runner-1',
      slug: 'epod-cli',
      branch: 'main',
      mcpCredential: 'forge_pat_dev_ok',
    });
  });

  it('returns a report rather than throwing, so one row cannot take the response down', async () => {
    const built = await buildProvisionRow(row(), ctx, {
      issueCredential: async () => {
        throw new Error('the credential vault is not reachable');
      },
    });
    expect(built.provision).toBeNull();
    expect(built.reports).toHaveLength(1);
    expect(built.reports[0]).toMatchObject({
      runnerId: 'runner-1',
      slug: 'epod-cli',
      kind: 'omitted',
      terminal: false,
    });
    expect(built.reports[0]?.reason).toContain('the credential vault is not reachable');
  });

  it('builds a second time after an integrity violation and serves the row when that clears', async () => {
    const issueCredential = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(violation())
      .mockResolvedValueOnce('forge_pat_dev_second');
    const built = await buildProvisionRow(row(), ctx, { issueCredential });
    expect(issueCredential).toHaveBeenCalledTimes(2);
    expect(built.reports).toEqual([]);
    expect(built.provision?.mcpCredential).toBe('forge_pat_dev_second');
  });

  it('calls the row terminal only once the same violation has happened twice', async () => {
    const issueCredential = vi.fn<() => Promise<string>>().mockRejectedValue(violation());
    const built = await buildProvisionRow(row(), ctx, { issueCredential });
    expect(issueCredential).toHaveBeenCalledTimes(2);
    expect(built.provision).toBeNull();
    expect(built.reports[0]).toMatchObject({ kind: 'omitted', terminal: true });
  });

  it('leaves the row queued when the second build fails a DIFFERENT integrity check', async () => {
    // Two different faults, not one reproduced: a 23505 that clears into a
    // 23503 is a race, and calling it permanent would burn a healthy row.
    const issueCredential = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(violation())
      .mockRejectedValueOnce(
        Object.assign(new Error('violates foreign key constraint'), {
          code: '23503',
          constraint_name: 'pat_user_id_fk',
        }),
      );
    const built = await buildProvisionRow(row(), ctx, { issueCredential });
    expect(issueCredential).toHaveBeenCalledTimes(2);
    expect(built.provision).toBeNull();
    expect(built.reports[0]).toMatchObject({ kind: 'omitted', terminal: false });
    expect(built.reports[0]?.reason).toContain('foreign key');
  });

  it('leaves the row queued when the same SQLSTATE names a DIFFERENT constraint', async () => {
    const issueCredential = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(violation('pat_user_name_uniq'))
      .mockRejectedValueOnce(violation('personal_access_tokens_pkey'));
    const built = await buildProvisionRow(row(), ctx, { issueCredential });
    expect(issueCredential).toHaveBeenCalledTimes(2);
    expect(built.reports[0]).toMatchObject({ kind: 'omitted', terminal: false });
  });

  it('does not build a second time for an error that says nothing about the next attempt', async () => {
    const issueCredential = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('down'));
    const built = await buildProvisionRow(row(), ctx, { issueCredential });
    expect(issueCredential).toHaveBeenCalledTimes(1);
    expect(built.reports[0]?.terminal).toBe(false);
  });

  it('mints nothing when the device has no live credential to act as', async () => {
    const issueCredential = vi.fn<() => Promise<string>>();
    const built = await buildProvisionRow(
      row(),
      { ...ctx, holderUserId: null },
      {
        issueCredential,
      },
    );
    expect(issueCredential).not.toHaveBeenCalled();
    expect(built.provision?.mcpCredential).toBeNull();
  });
});

describe('provisionFailuresHeader', () => {
  const report = (n: number): ProvisionReport => ({
    runnerId: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
    projectId: `11111111-1111-1111-1111-${String(n).padStart(12, '0')}`,
    slug: `project-${n}`,
    kind: 'omitted',
    reason: 'the workspace credential for this checkout could not be minted: duplicate key value',
    terminal: false,
  });

  it('is absent rather than empty when there is nothing to report', () => {
    expect(provisionFailuresHeader([])).toBeNull();
  });

  it('carries the slug and the cause', () => {
    const parsed = JSON.parse(provisionFailuresHeader([report(1)]) as string);
    expect(parsed).toEqual({
      failures: [
        {
          slug: 'project-1',
          projectId: '11111111-1111-1111-1111-000000000001',
          runnerId: '00000000-0000-0000-0000-000000000001',
          kind: 'omitted',
          reason:
            'the workspace credential for this checkout could not be minted: duplicate key value',
        },
      ],
      dropped: 0,
    });
  });

  it('stays inside the budget and counts what it could not carry', () => {
    const many = Array.from({ length: 200 }, (_, i) => report(i));
    const header = provisionFailuresHeader(many) as string;
    expect(header.length).toBeLessThanOrEqual(PROVISION_FAILURES_BUDGET);
    const parsed = JSON.parse(header) as { failures: unknown[]; dropped: number };
    expect(parsed.failures.length).toBeGreaterThan(0);
    expect(parsed.failures.length + parsed.dropped).toBe(200);
    expect(parsed.dropped).toBeGreaterThan(0);
  });

  it('is printable ASCII, because a header value that is not is refused by the runtime', () => {
    const header = provisionFailuresHeader([
      { ...report(1), reason: 'the key could not be decrypted — “ciphertext too short”' },
    ]) as string;
    expect(header).toMatch(/^[\x20-\x7e]*$/);
    expect(JSON.parse(header).failures[0].reason).toContain('—');
  });
});

// The vault this row reads through is the real one, under the key this process holds: a decrypt
// handed in by the test would prove the row against a stand-in and never against what it calls.
describe('the stored ssh key, read through the vault', () => {
  const HELD = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
  const before = process.env.INTEGRATION_MASTER_KEY;
  afterEach(() => {
    if (before === undefined) delete process.env.INTEGRATION_MASTER_KEY;
    else process.env.INTEGRATION_MASTER_KEY = before;
    vi.resetModules();
  });

  /** A fresh vault, so the key it caches is the one this case sets. */
  async function underKey(masterKey: string) {
    vi.resetModules();
    process.env.INTEGRATION_MASTER_KEY = masterKey;
    const vault = await import('../integrations/vault.js');
    const { buildProvisionRow: build } = await import('./provision-row.js');
    return { vault, build };
  }

  function sealedUnderAnotherKey(plain: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', randomBytes(32), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]);
  }

  const mint = { issueCredential: async () => 'forge_pat_dev_ok' };

  it('serves the key the vault opens', async () => {
    const { vault, build } = await underKey(HELD);
    const sealed = vault.encryptSecret('made-up-private-key');
    const built = await build(row({ sshPrivateKeyEnc: sealed }), ctx, mint);
    expect(built.provision?.sshPrivateKey).toBe('made-up-private-key');
    expect(built.reports).toEqual([]);
  });

  it('serves the provision without a key sealed under another, and says the key was dropped', async () => {
    const { build } = await underKey(HELD);
    const built = await build(
      row({ sshPrivateKeyEnc: sealedUnderAnotherKey('made-up-private-key') }),
      ctx,
      mint,
    );
    expect(built.provision).toMatchObject({
      sshPrivateKey: null,
      sshPublicKey: null,
      sshKeySource: null,
      mcpCredential: 'forge_pat_dev_ok',
    });
    expect(built.reports).toHaveLength(1);
    expect(built.reports[0]).toMatchObject({ kind: 'degraded', terminal: false });
    expect(built.reports[0]?.reason).toContain('could not be decrypted');
  });

  it('lets a malformed INTEGRATION_MASTER_KEY surface as itself rather than as a dropped key', async () => {
    const { build } = await underKey('AAAAAAAA');
    await expect(
      build(row({ sshPrivateKeyEnc: sealedUnderAnotherKey('made-up-private-key') }), ctx, mint),
    ).rejects.toThrow('INTEGRATION_MASTER_KEY: base64 must decode to 32 bytes (got 6)');
  });
});
