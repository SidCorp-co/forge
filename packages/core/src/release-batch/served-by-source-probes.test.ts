// An environment's source probes are read straight off its declaration, however it is deployed:
// adminhub-api's external `stg` declared one on its build-info route (2026-10-30), and nothing read
// it. Where none proves a commit, the reading says why and names the guide that says how to declare one.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NamedEnvironment } from '../project-config/index.js';
import { servedBySourceProbes } from './provider-live.js';

const SHA = '3641ba21fec5096e2d1a91a40f2d9e50e9239068';
const URL_ = 'https://stg-api.example.test/api/v1/build-info';

const env = (
  runtime: Array<{ identifies: 'source' | 'artifact' }> | null,
  deployment: NamedEnvironment['declaration']['deployment'] = { mode: 'external' },
): NamedEnvironment => ({
  name: 'stg',
  declaration: {
    tier: 'staging',
    deployment,
    ...(runtime
      ? {
          verification: {
            runtime: runtime.map((p) => ({
              type: 'http' as const,
              url: URL_,
              path: 'commit',
              ...p,
            })),
          },
        }
      : {}),
  },
});

function answering(status: number, body: unknown) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(JSON.stringify(body), { status }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe('servedBySourceProbes', () => {
  it('reads the commit an external environment’s source probe answers', async () => {
    answering(200, { commit: SHA });
    expect(await servedBySourceProbes(env([{ identifies: 'source' }]))).toEqual({
      ok: true,
      value: SHA,
    });
  });

  it('reads a bound environment’s source probe the same way', async () => {
    answering(200, { commit: SHA });
    const bound = env([{ identifies: 'source' }], {
      binding: '9d7c1f62-6f5e-4d55-9f4c-1f2b3c4d5e6f',
      trigger: 'on-land',
    });
    expect(await servedBySourceProbes(bound)).toEqual({ ok: true, value: SHA });
  });

  it('names the guide where the environment declares no probe, or only artifact probes', async () => {
    const none = await servedBySourceProbes(env(null), 'its production');
    expect(none).toEqual({
      ok: false,
      why: 'its production declares no source probe, so nothing reads which commit it serves; how to declare one: `GET /api/guides/release-source-probe.md`',
    });
    const artifact = await servedBySourceProbes(env([{ identifies: 'artifact' }]));
    expect(!artifact.ok && artifact.why).toContain(
      'environment `stg` declares runtime probes that each identify an artifact, never the source',
    );
    expect(!artifact.ok && artifact.why).toContain('GET /api/guides/release-source-probe.md');
  });

  it('says what the probe answered where it names no commit', async () => {
    answering(503, { error: 'down' });
    const down = await servedBySourceProbes(env([{ identifies: 'source' }]));
    expect(!down.ok && down.why).toContain(
      "environment `stg`'s source probe answered no one commit",
    );
    expect(!down.ok && down.why).toContain('answered HTTP 503');
  });
});
