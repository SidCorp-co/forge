/**
 * An environment deployed outside Forge (`deployment.mode: external`) is read through the source
 * probe it declares. adminhub-api, 2026-10-30: its `stg` declared
 * `verification.runtime: [{ url: …/api/v1/build-info, path: "commit", identifies: "source" }]`, the
 * URL answered its commit, and `GET /api/projects/:id/environments/stg/state` still answered
 * `unknown`, cause `external`, so no serving reading existed for the weighing to carry a runtime
 * verdict through. Driven against real Postgres with the probe's network answer stubbed.
 *
 * @direct-test-of packages/core/src/project-config/environment-state.ts
 * @direct-test-of packages/core/src/release-batch/serving-reading.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { owedRuntimes, weighVerdict } from '../../src/issues/runtime-standing.js';
import { carriageKey, type Weighing } from '../../src/issues/weighing.js';
import { readServingNow } from '../../src/release-batch/serving-reading.js';
import { type ApiResponse, api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const PROBE = 'https://app.example.test/api/v1/build-info';
const SERVED = '0076d673515fdb24a01de5af5d8ab1e448c156aa';
const ANCESTOR = '6bcfb9cb54a6ac89724a10f9f304671869c7bed7';
const UNRELATED = '9a258402c0ffee00c0ffee00c0ffee00c0ffee00';

let projectId: string;
let token: string;
let answer: { status: number; body: unknown };

const external = (withProbe: boolean) => ({
  production: {
    tier: 'production' as const,
    deploysFrom: 'main',
    deployment: { mode: 'external' as const },
    url: 'https://app.example.test',
    ...(withProbe
      ? {
          verification: {
            runtime: [
              { type: 'http' as const, url: PROBE, path: 'commit', identifies: 'source' as const },
            ],
          },
        }
      : {}),
  },
});

const state = async (): Promise<Record<string, unknown>> => {
  const res: ApiResponse = await api(
    token,
    'GET',
    `/api/projects/${projectId}/environments/production/state`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};

beforeEach(async () => {
  await truncateAll();
  const owner = await createTestUser({ verified: true });
  projectId = (await createTestProject(owner.id)).id;
  await addProjectMember(projectId, owner.id, 'admin');
  token = await userToken(owner.id);
  answer = { status: 200, body: { commit: SERVED } };
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(PROBE)) return real(input, init);
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  });
});

afterEach(() => vi.restoreAllMocks());

describe('an environment deployed outside Forge, read through its source probe', () => {
  it('reads serving the commit its probe answers', async () => {
    await seedProjectDocument(projectId, (await createTestUser()).id, {
      environments: external(true),
    });
    expect(await state()).toMatchObject({
      environment: 'production',
      state: 'serving',
      evidence: 'runtime-probe',
      source: { kind: 'revision', revision: SERVED },
      probes: [{ url: PROBE, identifies: 'source', status: 'uncompared', observed: SERVED }],
    });
    const serving = await readServingNow(projectId);
    expect(serving).toMatchObject({ kind: 'serving', served: [{ commit: SERVED, where: PROBE }] });
  });

  it('keeps unknown, external, where it declares no probe', async () => {
    await seedProjectDocument(projectId, (await createTestUser()).id, {
      environments: external(false),
    });
    expect(await state()).toMatchObject({
      state: 'unknown',
      reason: { cause: 'external' },
    });
  });

  it('reads unknown, naming what the probe answered, where it names no commit', async () => {
    await seedProjectDocument(projectId, (await createTestUser()).id, {
      environments: external(true),
    });
    answer = { status: 503, body: { error: 'down' } };
    const read = await state();
    expect(read).toMatchObject({ state: 'unknown', reason: { cause: 'probe-unread' } });
    expect(JSON.stringify(read)).toContain('answered HTTP 503');
    expect(await readServingNow(projectId)).toMatchObject({ kind: 'unreadable' });
  });

  it('carries a runtime verdict at an ancestor of what it serves, and supersedes one at an unrelated commit', async () => {
    await seedProjectDocument(projectId, (await createTestUser()).id, {
      environments: external(true),
    });
    const serving = await readServingNow(projectId);
    // the weighing as readWeighingNow leaves it once the source host has answered each pair
    const weighing: Weighing = {
      read: true,
      runtimes: [],
      changed: new Map(),
      carriage: new Map([
        [carriageKey(ANCESTOR, SERVED), { kind: 'descends' }],
        [carriageKey(UNRELATED, SERVED), { kind: 'differs', paths: ['app/Http/Kernel.php'] }],
      ]),
    };
    const identities = { source: SERVED };
    const owed = owedRuntimes('issue-90', weighing);
    const at = (value: string) => ({ kind: 'runtime' as const, value });

    expect(weighVerdict(at(ANCESTOR), serving, identities, owed, weighing)).toMatchObject({
      standing: 'stands',
      runtime: null,
    });
    const unrelated = weighVerdict(at(UNRELATED), serving, identities, owed, weighing);
    expect(unrelated.standing).toBe('superseded');
    expect(unrelated.beside.join(' ')).toContain('does not descend from it');
  });
});
