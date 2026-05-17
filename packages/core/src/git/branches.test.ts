/**
 * ISS-138 (PR-D) — unit tests for the git-shell wrapper. The helpers are
 * thin enough that we test the argv shape and error wrapping; integration
 * against a real remote is covered by the manual smoke in the issue plan.
 */
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ExecCall = { cmd: string; args: readonly string[]; opts: { cwd?: string } };

const execCalls: ExecCall[] = [];
type ExecReturn = { stdout: string; stderr: string };
let execImpl: (
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string },
) => Promise<ExecReturn>;

// promisify(execFile) returns `{stdout, stderr}` via util.promisify.custom.
// Mirror that here so the production code's `await pExecFile(...)` sees the
// expected object shape.
const mockExecFile = (
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string },
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => {
  execCalls.push({ cmd, args, opts });
  execImpl(cmd, args, opts).then(
    (r) => cb(null, r.stdout, r.stderr),
    (err) => cb(err instanceof Error ? err : new Error(String(err)), '', ''),
  );
};
// biome-ignore lint/suspicious/noExplicitAny: util.promisify.custom is a Symbol
(mockExecFile as any)[promisify.custom] = (
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string },
) => {
  execCalls.push({ cmd, args, opts });
  return execImpl(cmd, args, opts);
};

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

const REPO = '/tmp/repo';

beforeEach(() => {
  execCalls.length = 0;
  execImpl = async () => ({ stdout: '', stderr: '' });
});

const branchesModule = await import('./branches.js');
const { gitRemoteHasBranch, createIntegrationBranch, IntegrationBranchError } = branchesModule;

describe('gitRemoteHasBranch', () => {
  it('returns true when ls-remote emits a matching line', async () => {
    execImpl = async (_cmd, args) => {
      if (args[0] === 'remote') return { stdout: 'github\n', stderr: '' };
      if (args[0] === 'ls-remote') return { stdout: 'sha\trefs/heads/iss-5-foo\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    expect(await gitRemoteHasBranch(REPO, 'iss-5-foo')).toBe(true);
    expect(execCalls[0]).toMatchObject({ cmd: 'git', args: ['remote'] });
    expect(execCalls[1]).toMatchObject({
      cmd: 'git',
      args: ['ls-remote', '--heads', 'github', 'iss-5-foo'],
    });
  });

  it('returns false when ls-remote stdout is empty', async () => {
    execImpl = async (_cmd, args) => {
      if (args[0] === 'remote') return { stdout: 'github\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    expect(await gitRemoteHasBranch(REPO, 'iss-5-foo')).toBe(false);
  });

  it('throws BAD_BRANCH_NAME for invalid input', async () => {
    await expect(gitRemoteHasBranch(REPO, 'feat space')).rejects.toMatchObject({
      code: 'BAD_BRANCH_NAME',
    });
    expect(execCalls).toHaveLength(0);
  });

  it('wraps git failures as GIT_FETCH_FAILED', async () => {
    execImpl = async (_cmd, args) => {
      if (args[0] === 'remote') return { stdout: 'github\n', stderr: '' };
      throw new Error('boom');
    };
    await expect(gitRemoteHasBranch(REPO, 'iss-5-foo')).rejects.toMatchObject({
      code: 'GIT_FETCH_FAILED',
    });
  });
});

describe('createIntegrationBranch', () => {
  it('runs fetch then push with the expected argv', async () => {
    execImpl = async (_cmd, args) => {
      if (args[0] === 'remote') return { stdout: 'github\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const out = await createIntegrationBranch({
      repoPath: REPO,
      remoteRef: 'main',
      newBranch: 'iss-7-decompose',
    });
    expect(out).toEqual({ remote: 'github', branch: 'iss-7-decompose' });
    expect(execCalls[1]).toMatchObject({ args: ['fetch', 'github', 'main'] });
    expect(execCalls[2]).toMatchObject({
      args: ['push', 'github', 'github/main:refs/heads/iss-7-decompose'],
    });
  });

  it('throws BAD_BRANCH_NAME on invalid newBranch', async () => {
    await expect(
      createIntegrationBranch({ repoPath: REPO, remoteRef: 'main', newBranch: 'has space' }),
    ).rejects.toBeInstanceOf(IntegrationBranchError);
  });

  it('wraps push failures as GIT_PUSH_FAILED', async () => {
    execImpl = async (_cmd, args) => {
      if (args[0] === 'remote') return { stdout: 'github\n', stderr: '' };
      if (args[0] === 'fetch') return { stdout: '', stderr: '' };
      throw new Error('refused');
    };
    await expect(
      createIntegrationBranch({ repoPath: REPO, remoteRef: 'main', newBranch: 'iss-7-foo' }),
    ).rejects.toMatchObject({ code: 'GIT_PUSH_FAILED' });
  });

  it('throws NO_REMOTE when the repo has no remote configured', async () => {
    execImpl = async (_cmd, args) => {
      if (args[0] === 'remote') return { stdout: '\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    await expect(
      createIntegrationBranch({ repoPath: REPO, remoteRef: 'main', newBranch: 'iss-7-foo' }),
    ).rejects.toMatchObject({ code: 'NO_REMOTE' });
  });
});
