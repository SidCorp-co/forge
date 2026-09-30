import { describe, expect, it, vi } from 'vitest';
import { CoolifyApiError, CoolifyClient } from './client.js';
import {
  coolifyDeployAdapter,
  coolifyDeploymentRecords,
  mapCoolifyDeploymentStatus,
  toDeploymentRecord,
} from './deployment-records.js';

const SHA = '47f061d78ca5ae2de8005f703fae0b8e8a454da3';
const APP = 'y8w4c4kss8ogo8gc44ow44kc';

function clientAnswering(handler: (url: string) => Response) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    calls.push(url);
    return handler(url);
  }) as unknown as typeof fetch;
  const client = new CoolifyClient({
    baseUrl: 'https://coolify.example',
    apiToken: 't',
    fetchImpl,
  });
  return { client, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const raw = (over: Record<string, unknown> = {}) => ({
  deployment_uuid: 'xo484gwk8cwsocoswo08wwcc',
  status: 'finished',
  commit: SHA,
  created_at: '2026-09-30T19:14:01.000000Z',
  ...over,
});

describe('mapCoolifyDeploymentStatus', () => {
  it.each([
    ['queued', 'queued'],
    ['in_progress', 'running'],
    ['finished', 'succeeded'],
    ['failed', 'failed'],
    ['cancelled-by-user', 'cancelled'],
  ])('maps Coolify %s to %s', (coolify, forge) => {
    expect(mapCoolifyDeploymentStatus('d1', coolify)).toBe(forge);
  });

  it('refuses a status it does not know, naming the value and the deployment', () => {
    expect(() => mapCoolifyDeploymentStatus('d1', 'success')).toThrow(
      /Coolify deployment d1: status "success" is not one Forge maps/,
    );
  });

  it('refuses a key every object inherits rather than reading it as a status', () => {
    expect(() => mapCoolifyDeploymentStatus('d1', 'constructor')).toThrow(/"constructor"/);
  });

  it('refuses an absent status instead of reading it as pending', () => {
    expect(() => mapCoolifyDeploymentStatus('d1', undefined)).toThrow(/status undefined/);
  });
});

describe('toDeploymentRecord', () => {
  it('reads id, status, time and commit off the Coolify record', () => {
    expect(toDeploymentRecord(raw())).toEqual({
      id: 'xo484gwk8cwsocoswo08wwcc',
      status: 'succeeded',
      at: '2026-09-30T19:14:01.000Z',
      sourceRevision: SHA,
      artifact: null,
    });
  });

  it('leaves the artifact null when the record carries a commit, never deriving it', () => {
    expect(toDeploymentRecord(raw()).artifact).toBeNull();
  });

  it("reads Coolify's unrecorded HEAD as no revision", () => {
    expect(toDeploymentRecord(raw({ commit: 'HEAD' })).sourceRevision).toBeNull();
  });

  it('lowercases a revision Coolify reports in capitals', () => {
    expect(toDeploymentRecord(raw({ commit: SHA.toUpperCase() })).sourceRevision).toBe(SHA);
  });

  it('refuses a commit that is neither a revision nor HEAD', () => {
    expect(() => toDeploymentRecord(raw({ commit: 'main' }))).toThrow(/commit "main" is neither/);
  });

  it('refuses a record with no timestamp', () => {
    expect(() => toDeploymentRecord(raw({ created_at: 'yesterday' }))).toThrow(
      /created_at "yesterday" is not a timestamp/,
    );
  });

  it('refuses a record with no deployment id', () => {
    expect(() => toDeploymentRecord(raw({ deployment_uuid: '' }))).toThrow(/no deployment_uuid/);
  });
});

describe('coolifyDeployAdapter', () => {
  it("reads the application's deployment list through the existing client", async () => {
    const { client, calls } = clientAnswering(() => json({ count: 1, deployments: [raw()] }));
    await coolifyDeployAdapter(client).latestDeployment({ applicationUuid: APP });
    expect(calls).toEqual([
      `https://coolify.example/api/v1/deployments/applications/${APP}?skip=0&take=5`,
    ]);
  });

  it('answers the newest record whatever order Coolify lists them in', async () => {
    const { client } = clientAnswering(() =>
      json({
        deployments: [
          raw({ deployment_uuid: 'old', created_at: '2026-09-29T10:00:00Z' }),
          raw({ deployment_uuid: 'new', created_at: '2026-09-30T10:00:00Z' }),
          raw({ deployment_uuid: 'mid', created_at: '2026-09-29T20:00:00Z' }),
        ],
      }),
    );
    const latest = await coolifyDeployAdapter(client).latestDeployment({ applicationUuid: APP });
    expect(latest?.id).toBe('new');
  });

  it('answers null for an application Coolify has never deployed', async () => {
    const { client } = clientAnswering(() => json({ count: 0, deployments: [] }));
    expect(
      await coolifyDeployAdapter(client).latestDeployment({ applicationUuid: APP }),
    ).toBeNull();
  });

  it('refuses the whole list when one record carries a status it does not know', async () => {
    const { client } = clientAnswering(() =>
      json({ deployments: [raw(), raw({ deployment_uuid: 'odd', status: 'paused' })] }),
    );
    await expect(
      coolifyDeployAdapter(client).latestDeployment({ applicationUuid: APP }),
    ).rejects.toThrow(/deployment odd: status "paused"/);
  });

  it("reads a deployment only through the application's own list", async () => {
    const { client, calls } = clientAnswering(() =>
      json({ deployments: [raw({ deployment_uuid: 'mine' })] }),
    );
    const got = await coolifyDeployAdapter(client).deployment({ applicationUuid: APP }, 'mine');
    expect(got.id).toBe('mine');
    expect(calls).toEqual([
      `https://coolify.example/api/v1/deployments/applications/${APP}?skip=0&take=50`,
    ]);
  });

  it('refuses by name an id that is not among the application deployments', async () => {
    const { client, calls } = clientAnswering(() =>
      json({ deployments: [raw({ deployment_uuid: 'mine' })] }),
    );
    await expect(
      coolifyDeployAdapter(client).deployment({ applicationUuid: APP }, 'theirs'),
    ).rejects.toThrow(
      `Coolify deployment theirs: is not among the 1 deployments Coolify lists for application ${APP}`,
    );
    expect(calls.some((u) => u.includes('/api/v1/deployments/theirs'))).toBe(false);
  });

  it('pages the list until it finds the id', async () => {
    const full = (prefix: string) =>
      Array.from({ length: 50 }, (_, i) => raw({ deployment_uuid: `${prefix}-${i}` }));
    const { client, calls } = clientAnswering((url) =>
      json({
        deployments: url.includes('skip=0') ? full('p0') : [raw({ deployment_uuid: 'old' })],
      }),
    );
    const got = await coolifyDeployAdapter(client).deployment({ applicationUuid: APP }, 'old');
    expect(got.id).toBe('old');
    expect(calls).toHaveLength(2);
  });

  it('stops when Coolify answers the same page again instead of paging for ever', async () => {
    const same = Array.from({ length: 50 }, (_, i) => raw({ deployment_uuid: `d-${i}` }));
    const { client, calls } = clientAnswering(() => json({ deployments: same }));
    await expect(
      coolifyDeployAdapter(client).deployment({ applicationUuid: APP }, 'absent'),
    ).rejects.toThrow(/is not among the 50 deployments/);
    expect(calls).toHaveLength(2);
  });

  it('carries a Coolify refusal of the list through', async () => {
    const { client } = clientAnswering(() => json({}, 403));
    await expect(
      coolifyDeployAdapter(client).deployment({ applicationUuid: APP }, 'x'),
    ).rejects.toBeInstanceOf(CoolifyApiError);
  });
});

describe('coolifyDeploymentRecords', () => {
  const ctx = (targets: { id: string; label: string; resourceUuid: string }[]) =>
    ({
      bindingId: 'b-1',
      config: { baseUrl: 'https://coolify.example', targets },
      secrets: { apiToken: 't' },
    }) as unknown as Parameters<typeof coolifyDeploymentRecords>[0];

  it("targets the binding's one application", () => {
    const bound = coolifyDeploymentRecords(ctx([{ id: 't1', label: 'App', resourceUuid: APP }]), 1);
    expect(bound.target).toEqual({ applicationUuid: APP });
  });

  it('refuses a binding with several targets rather than picking one', () => {
    const two = [
      { id: 't1', label: 'BE', resourceUuid: APP },
      { id: 't2', label: 'FE', resourceUuid: 'z'.repeat(24) },
    ];
    expect(() => coolifyDeploymentRecords(ctx(two), 1)).toThrow(
      /binding b-1 names 2 deploy targets/,
    );
  });
});
