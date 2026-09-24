import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.fn();
vi.mock('node:dns', () => ({ promises: { lookup: (...a: unknown[]) => lookup(...a) } }));

const { assertSafeSshRepoUrl, isHostUnresolved, pinSafeSshHost } = await import(
  './ssh-host-guard.js'
);

const answers = (...addresses: string[]) => addresses.map((address) => ({ address, family: 4 }));

async function refusal(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HTTPException);
  return (err as HTTPException).message;
}

beforeEach(() => {
  lookup.mockReset();
});

describe('pinSafeSshHost', () => {
  it('returns the one public address it resolved, for the connection to use', async () => {
    lookup.mockResolvedValueOnce(answers('172.65.251.78'));
    await expect(pinSafeSshHost('git@gitlab.com:sid/desk.git')).resolves.toEqual({
      host: 'gitlab.com',
      address: '172.65.251.78',
    });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('refuses a host any of whose addresses is private', async () => {
    lookup.mockResolvedValueOnce(answers('172.65.251.78', '10.0.0.7'));
    expect(await refusal(pinSafeSshHost('ssh://git@gitlab.com/sid/desk.git'))).toMatch(
      /private\/internal address/,
    );
  });

  it('refuses a host that does not resolve, naming it', async () => {
    lookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    const p = pinSafeSshHost('git@nowhere.example:sid/desk.git');
    const err = await p.catch((e: unknown) => e);
    expect(isHostUnresolved(err)).toBe(true);
    expect((err as HTTPException).message).toBe(
      'the repository host nowhere.example could not be resolved',
    );
  });

  it('pins an address literal to itself and refuses a private one without resolving', async () => {
    await expect(pinSafeSshHost('git@172.65.251.78:sid/desk.git')).resolves.toEqual({
      host: '172.65.251.78',
      address: '172.65.251.78',
    });
    expect(await refusal(pinSafeSshHost('git@127.0.0.1:sid/desk.git'))).toMatch(/private/);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses a host a shell would read as more than a name, before resolving it', async () => {
    expect(await refusal(pinSafeSshHost('git@evil;id:sid/desk.git'))).toMatch(/SSH clone URL/);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('assertSafeSshRepoUrl', () => {
  it('lets an unresolvable host through, so the connection test answers host_unreachable', async () => {
    lookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(assertSafeSshRepoUrl('git@nowhere.example:sid/desk.git')).resolves.toBeUndefined();
  });

  it('still refuses a private host', async () => {
    lookup.mockResolvedValueOnce(answers('192.168.1.4'));
    expect(await refusal(assertSafeSshRepoUrl('git@lan.example:sid/desk.git'))).toMatch(/private/);
  });
});
