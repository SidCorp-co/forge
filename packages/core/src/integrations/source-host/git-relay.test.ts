import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../lib/env.js';

let base: string | null = 'https://forge.example';
vi.mock('../index.js', () => ({ resolveApiBaseUrl: () => base }));

const { gitRelayRequestOf, gitRelayUrlFor, readGitRelayTicket, relayedAskOf, signGitRelayTicket } =
  await import('./git-relay.js');

beforeEach(() => {
  base = 'https://forge.example';
});

describe('REQ-73 BC-5: the relay passes git smart HTTP and nothing else', () => {
  it('ref discovery and fetch or push, by method and service', () => {
    expect(gitRelayRequestOf('GET', 'acme/api.git/info/refs', 'git-upload-pack')).toEqual({
      repository: 'acme/api',
      suffix: 'info/refs',
      service: 'git-upload-pack',
    });
    expect(gitRelayRequestOf('POST', 'group/sub/api.git/git-receive-pack', undefined)).toEqual({
      repository: 'group/sub/api',
      suffix: 'git-receive-pack',
      service: 'git-receive-pack',
    });
  });

  it('the dumb protocol, a browse, the wrong method or service, and a path with no owner are none', () => {
    for (const [method, rest, service] of [
      ['GET', 'acme/api.git/HEAD', undefined],
      ['GET', 'acme/api/-/raw/main/README.md', undefined],
      ['POST', 'acme/api.git/info/refs', 'git-upload-pack'],
      ['GET', 'acme/api.git/info/refs', 'git-annex'],
      ['GET', 'acme/api.git/git-upload-pack', undefined],
      ['GET', 'api.git/info/refs', 'git-upload-pack'],
    ] as const) {
      expect(gitRelayRequestOf(method, rest, service), `${method} ${rest}`).toBeNull();
    }
  });
});

describe("REQ-73 BC-5: a credential ask is the relay's only when it names core's own host under the prefix", () => {
  it('reads the upstream host and repository out of the relay path, a base path included', () => {
    expect(relayedAskOf('forge.example', 'api/git/gitlab.com/acme/api.git')).toEqual({
      host: 'gitlab.com',
      path: 'acme/api',
    });
    base = 'https://forge.example/core';
    expect(relayedAskOf('FORGE.example', '/core/api/git/gitlab.com/acme/api.git')).toEqual({
      host: 'gitlab.com',
      path: 'acme/api',
    });
  });

  it('another host, another prefix, no repository, or no public origin is a direct ask', () => {
    expect(relayedAskOf('gitlab.com', 'api/git/gitlab.com/acme/api.git')).toBeNull();
    expect(relayedAskOf('forge.example', 'acme/api.git')).toBeNull();
    expect(relayedAskOf('forge.example', 'api/git/gitlab.com/api.git')).toBeNull();
    base = null;
    expect(relayedAskOf('forge.example', 'api/git/gitlab.com/acme/api.git')).toBeNull();
    expect(gitRelayUrlFor('gitlab.com', 'acme/api')).toBeNull();
  });

  it('the relay URL is one spelling whatever the repository path carries', () => {
    for (const path of ['acme/api', '/acme/api.git', 'acme/api/']) {
      expect(gitRelayUrlFor('GitLab.com', path)).toBe(
        'https://forge.example/api/git/gitlab.com/acme/api.git',
      );
    }
  });
});

describe('REQ-73 BC-5: a relay ticket lasts an hour and verifies as nothing else', () => {
  it('reads back the device and binding it was signed for, and nothing once it has run out', async () => {
    const now = Date.now();
    const t = await signGitRelayTicket({ deviceId: 'd1', bindingId: 'b1' }, now);
    expect(await readGitRelayTicket(t, now + 59 * 60_000)).toEqual({
      deviceId: 'd1',
      bindingId: 'b1',
    });
    expect(await readGitRelayTicket(t, now + 61 * 60_000)).toBeNull();
    expect(await readGitRelayTicket(`${t}x`, now)).toBeNull();
  });

  it('a token signed with the same secret under another issuer is no ticket', async () => {
    const other = await new SignJWT({ bid: 'b1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('forge')
      .setSubject('d1')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(env.JWT_SECRET));
    expect(await readGitRelayTicket(other)).toBeNull();
  });
});
