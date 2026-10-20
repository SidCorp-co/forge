// @gate-input whole-tree — the host-answer cases run a fake ssh from PATH, which the root-walk guard cannot see into.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GITHUB_NOT_FOUND,
  GITLAB_NO_ACCESS,
  type HostAnswer,
  keyUnknown,
  keyUnloadable,
  NO_REPOSITORY,
  unreachable,
} from './host-answers.fixture.js';

const lookup = vi.fn();
vi.mock('node:dns', () => ({ promises: { lookup: (...a: unknown[]) => lookup(...a) } }));

process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
const {
  derivePublicFromPrivate,
  STORED_KEY_UNREADABLE,
  testSshConnection,
  testStoredSshKey,
  UnreadablePrivateKeyError,
  withDeployKey,
} = await import('./ssh-keys.js');
const { encryptSecret } = await import('../integrations/vault.js');

beforeEach(() => {
  lookup.mockReset();
});

describe('withDeployKey', () => {
  it('pins ssh to the address the guard checked, so a second resolution cannot move it', async () => {
    lookup
      .mockResolvedValueOnce([{ address: '172.65.251.78', family: 4 }])
      .mockResolvedValue([{ address: '10.0.0.7', family: 4 }]);
    const [cmd, pin] = await withDeployKey(
      'key',
      'git@gitlab.com:sid/desk.git',
      async (env, _dir, handed) => [env.GIT_SSH_COMMAND ?? '', handed] as const,
    );
    expect(pin).toEqual({ host: 'gitlab.com', address: '172.65.251.78' });
    expect(cmd).toContain('-o HostName=172.65.251.78');
    expect(cmd).toContain('-o HostKeyAlias=gitlab.com');
    expect(cmd).not.toContain('10.0.0.7');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('writes no key and runs nothing for a remote the guard refuses', async () => {
    const fn = vi.fn();
    await expect(withDeployKey('key', 'git@10.0.0.7:sid/desk.git', fn)).rejects.toThrow(
      /private\/internal address/,
    );
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('testSshConnection', () => {
  it('answers a refused remote as a failed test rather than connecting to it', async () => {
    await expect(testSshConnection('git@127.0.0.1:sid/desk.git', 'key')).resolves.toEqual({
      ok: false,
      code: 'error',
      message: 'That host resolves to a private/internal address and cannot be probed.',
    });
  });

  it('answers an unresolvable host as unreachable', async () => {
    lookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(testSshConnection('git@nowhere.example:sid/desk.git', 'key')).resolves.toEqual({
      ok: false,
      code: 'host_unreachable',
      message: 'The repository host nowhere.example could not be resolved.',
    });
  });
});

describe('testSshConnection, in the words each host refuses with', () => {
  const bin = mkdtempSync(join(tmpdir(), 'forge-ssh-answer-'));
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path ?? ''}`;
  afterAll(() => {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  });

  /** A fake `ssh` that answers every connection as `answer`'s host does. */
  function answering(answer: HostAnswer) {
    writeFileSync(join(bin, 'said'), answer.stderr);
    writeFileSync(
      join(bin, 'ssh'),
      `#!/bin/sh\ncat "${join(bin, 'said')}" >&2\nexit ${answer.exit}\n`,
    );
    chmodSync(join(bin, 'ssh'), 0o755);
  }

  it.each([
    [GITLAB_NO_ACCESS.name, 'not_found', GITLAB_NO_ACCESS],
    [GITHUB_NOT_FOUND.name, 'not_found', GITHUB_NOT_FOUND],
    [NO_REPOSITORY.name, 'not_found', NO_REPOSITORY],
    ['a key the host does not know', 'auth_denied', keyUnknown('gitlab.com')],
    ['an unreachable host', 'host_unreachable', unreachable('172.65.251.78')],
  ] as const)('reads %s as %s, quoting what it said', async (_name, code, answer) => {
    lookup.mockResolvedValue([{ address: '172.65.251.78', family: 4 }]);
    answering(answer);

    const test = await testSshConnection('git@gitlab.com:sid/desk.git', 'key');

    expect(test).toMatchObject({ ok: false, code });
    expect(test.message).toContain(answer.said.replace('172.65.251.78', 'gitlab.com'));
    expect(test.message).not.toMatch(/^remote:|remote:\s*(\.|\))/);
  });

  // ISS-1421 r12 repair: a key ssh could not load read as the host refusing it, over Forge's temp path.
  it.each([keyUnloadable('error in libcrypto'), keyUnloadable('invalid format')])(
    'reads $name as a stored key Forge cannot read',
    async (answer) => {
      lookup.mockResolvedValue([{ address: '172.65.251.78', family: 4 }]);
      answering(answer);

      const test = await testSshConnection('git@gitlab.com:sid/desk.git', 'key');

      expect(test).toMatchObject({ ok: false, code: 'key_unreadable' });
      expect(test.message).toBe(
        'Forge could not read the stored deploy key, so it was never offered to the git host. Detach it and generate a new one.',
      );
    },
  );

  it('hides a path in the reply it quotes', async () => {
    lookup.mockResolvedValue([{ address: '172.65.251.78', family: 4 }]);
    answering(NO_REPOSITORY);

    const test = await testSshConnection('git@gitlab.com:sid/desk.git', 'key');

    expect(test.message).toContain("'[path hidden]' does not appear to be a git repository");
    expect(test.message).not.toContain('/srv/git');
  });

  // ISS-1398 judge j2 finding 1: Test connection asked for write access, the mark and hold for read.
  // r11: all three ask for read access, which is all Forge needs, and name the devices' write apart.
  it.each([
    [GITLAB_NO_ACCESS.name, GITLAB_NO_ACCESS],
    ['a key the host does not know', keyUnknown('gitlab.com')],
  ] as const)(
    'asks for %s the access the mark and the hold ask for, and why',
    async (_n, answer) => {
      lookup.mockResolvedValue([{ address: '172.65.251.78', family: 4 }]);
      answering(answer);

      const test = await testSshConnection('git@gitlab.com:sid/desk.git', 'key');

      expect(test.message).toContain(
        'Give it read access to the repository, which is all Forge needs; devices that push with it need write access.',
      );
      expect(test.message).not.toMatch(/Give it write access/);
    },
  );
});

// ISS-1421 r13 — criteria 145 and 146 could not be reached on beta: Forge refuses at upload a key ssh
// cannot load. What does reach a stored key after that check is a ciphertext the vault cannot open,
// which Test connection answered as a bare 500 DECRYPT_FAILED rather than as a key Forge cannot read.
describe('testStoredSshKey', () => {
  it('answers a stored key the vault cannot open as key_unreadable, without running ssh', async () => {
    const sealed = encryptSecret('-----BEGIN OPENSSH PRIVATE KEY-----\nx\n');
    const damaged = Buffer.from(sealed);
    damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 0xff;

    const test = await testStoredSshKey('git@gitlab.com:sid/desk.git', damaged, { projectId: 'p' });

    expect(test).toEqual(STORED_KEY_UNREADABLE);
    expect(test.message).toBe(
      'Forge could not read the stored deploy key, so it was never offered to the git host. Detach it and generate a new one.',
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it('answers a ciphertext too short to be one the same way', async () => {
    const test = await testStoredSshKey('git@gitlab.com:sid/desk.git', Buffer.from('x'), {});
    expect(test).toMatchObject({ ok: false, code: 'key_unreadable' });
  });

  it('tests a key the vault opens against the host, as before', async () => {
    lookup.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
    const test = await testStoredSshKey(
      'git@gitlab.invalid:sid/desk.git',
      encryptSecret('key'),
      {},
    );
    expect(test.code).toBe('host_unreachable');
    expect(lookup).toHaveBeenCalled();
  });
});

// ISS-1421 r13 — storing a malformed key answered "invalid_private_key: could not read …", its code
// leading the sentence a person reads. The code is the caller's, in the refusal's details.
describe('derivePublicFromPrivate', () => {
  it('refuses a key ssh cannot load in a plain sentence, with no code in front', async () => {
    const refused = await derivePublicFromPrivate('not a key', 'forge-x').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(UnreadablePrivateKeyError);
    const message = (refused as Error).message;
    expect(message).toBe(
      'Forge could not read this SSH private key. It may be malformed or protected by a passphrase, and Forge needs one it can use unattended.',
    );
    expect(message).not.toMatch(/^[a-z_]+:/);
  });
});
