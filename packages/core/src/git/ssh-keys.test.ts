import { beforeEach, describe, expect, it, vi } from 'vitest';

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
