import { describe, expect, it, vi } from 'vitest';
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
const violation = () => Object.assign(new Error('duplicate key value'), { code: '23505' });

describe('integrityViolation', () => {
  it('reads a SQLSTATE class 23 off the error itself', () => {
    expect(integrityViolation(violation())).toBe('23505');
  });

  it('reads one off a cause drizzle wrapped, which is the shape the endpoint actually meets', () => {
    const wrapped = new Error('Failed query: insert into "personal_access_tokens" …', {
      cause: violation(),
    });
    expect(integrityViolation(wrapped)).toBe('23505');
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
        Object.assign(new Error('violates foreign key constraint'), { code: '23503' }),
      );
    const built = await buildProvisionRow(row(), ctx, { issueCredential });
    expect(issueCredential).toHaveBeenCalledTimes(2);
    expect(built.provision).toBeNull();
    expect(built.reports[0]).toMatchObject({ kind: 'omitted', terminal: false });
    expect(built.reports[0]?.reason).toContain('foreign key');
  });

  it('does not build a second time for an error that says nothing about the next attempt', async () => {
    const issueCredential = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('down'));
    const built = await buildProvisionRow(row(), ctx, { issueCredential });
    expect(issueCredential).toHaveBeenCalledTimes(1);
    expect(built.reports[0]?.terminal).toBe(false);
  });

  it('serves the provision without the ssh key it could not decrypt, and says the key was dropped', async () => {
    const built = await buildProvisionRow(row({ sshPrivateKeyEnc: Buffer.from('rubbish') }), ctx, {
      issueCredential: async () => 'forge_pat_dev_ok',
      decrypt: () => {
        throw new Error('decryptSecret: ciphertext too short');
      },
    });
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
