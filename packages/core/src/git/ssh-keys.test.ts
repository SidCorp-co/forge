import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GITHUB_NOT_FOUND,
  GITLAB_NO_ACCESS,
  type HostAnswer,
  keyUnknown,
  NO_REPOSITORY,
  unreachable,
} from './host-answers.fixture.js';

const lookup = vi.fn();
vi.mock('node:dns', () => ({ promises: { lookup: (...a: unknown[]) => lookup(...a) } }));

const { testSshConnection, withDeployKey } = await import('./ssh-keys.js');

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
      message: 'that host resolves to a private/internal address and cannot be probed',
    });
  });

  it('answers an unresolvable host as unreachable', async () => {
    lookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(testSshConnection('git@nowhere.example:sid/desk.git', 'key')).resolves.toEqual({
      ok: false,
      code: 'host_unreachable',
      message: 'the repository host nowhere.example could not be resolved',
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
});
