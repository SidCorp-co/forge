/**
 * REQ-63 BC-13..15 (forge-core-61, relaying orbit-forge, 2026-10-29): a shipped release tags the
 * commit it shipped `v<version>` on the project's source host, so a project deployed outside Forge
 * reads its release version at build time. Driven through the record door of a project with no
 * production environment (a recorded landing is a ship), against real Postgres, with the source host
 * planted at the resolver the way `release-promotion-e2e` plants it: it holds tags by name and counts
 * the writes it took, so a re-ship that wrote again or moved a tag goes red here.
 *
 * @direct-test-of packages/core/src/release-batch/release-tag.ts
 * @direct-test-of packages/core/src/release-batch/recorded-landing.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tagShippedRelease } from '../../src/release-batch/release-tag.js';
import { api } from '../helpers/api.js';
import {
  ASIDE,
  F4,
  judgedAll,
  landedIssue,
  ok,
  record,
  seedLandedWorld,
  statusOf,
  world,
} from '../helpers/landed-world.js';

vi.mock('../../src/release-batch/shipped-earlier.js', async (importOriginal) => {
  const { reader } = await import('../helpers/landed-history.js');
  return {
    ...(await importOriginal<typeof import('../../src/release-batch/shipped-earlier.js')>()),
    ancestrySourceFor: async () => ({ kind: 'box', why: 'the planted box', reader }),
  };
});

/**
 * The planted host: its tags by name, every write it took, whether it is bound or failing, and a
 * commit every name not yet in `tags` already stands on (a tag set by hand before Forge tagged).
 */
const planted = vi.hoisted(() => ({
  bound: true,
  failing: false,
  takenOn: null as string | null,
  tags: new Map<string, string>(),
  writes: [] as Array<{ name: string; sha: string }>,
}));

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>();
  return {
    ...original,
    resolveSourceHost: async (projectId: string, purpose?: 'kernel' | 'agent') => {
      if (!planted.bound) return original.resolveSourceHost(projectId, purpose);
      return {
        provider: 'github',
        bindingId: 'b-orbit',
        fullName: 'acme/orbit',
        host: 'github.com',
        async tagCommit({ name, sha }: { name: string; sha: string }) {
          if (planted.failing)
            throw new Error('GET /repos/acme/orbit/git/ref/tags returned HTTP 502');
          const on = planted.tags.get(name) ?? planted.takenOn ?? undefined;
          if (on !== undefined) return { kind: on === sha ? 'present' : 'conflict', name, sha: on };
          planted.tags.set(name, sha);
          planted.writes.push({ name, sha });
          return { kind: 'created', name, sha };
        },
      };
    },
  };
});

beforeEach(async () => {
  await seedLandedWorld();
  planted.bound = true;
  planted.failing = false;
  planted.takenOn = null;
  planted.tags.clear();
  planted.writes.length = 0;
});

/** One issue landed and judged at F4, recorded as shipped: the run and the version it took. */
async function ship(seq: number): Promise<{ runId: string; version: string; issue: string }> {
  const issue = await landedIssue(seq, F4);
  await judgedAll(issue, F4);
  const res = await record([issue], F4);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { runId: String(res.body.runId), version: String(res.body.version), issue };
}

async function tagOnPage(version: string): Promise<Record<string, unknown> | null> {
  const body = await ok(
    api(world.token, 'GET', `/api/projects/${world.projectId}/releases/${version}`),
  );
  return (body.release as { tag: Record<string, unknown> | null }).tag;
}

describe('a shipped release tags the commit it shipped (REQ-63 BC-13)', () => {
  it('puts v<version> on the shipped commit through the bound host, and the release page shows it (BC-15)', async () => {
    const { version } = await ship(5);

    expect(planted.writes).toEqual([{ name: `v${version}`, sha: F4 }]);
    expect(await tagOnPage(version)).toMatchObject({
      state: 'tagged',
      name: `v${version}`,
      commit: F4,
      created: true,
      code: null,
    });
  });
});

describe('tagging is idempotent, and a tag on another commit is refused by name (REQ-63 BC-14)', () => {
  it('a second tagging of the same release writes nothing and still reads tagged', async () => {
    const { runId, version } = await ship(5);

    const again = await tagShippedRelease(runId);

    expect(planted.writes).toHaveLength(1);
    expect(again).toMatchObject({
      state: 'tagged',
      name: `v${version}`,
      commit: F4,
      created: false,
    });
    expect(planted.tags.get(`v${version}`)).toBe(F4);
  });

  it('a tag of that name on another commit is refused RELEASE_TAG_CONFLICT naming it, never moved, and the release says so', async () => {
    // a tag set by hand before the release shipped, on another commit
    planted.takenOn = ASIDE;
    const { version, issue } = await ship(5);

    const tag = await tagOnPage(version);
    expect(tag).toMatchObject({
      state: 'refused',
      name: `v${version}`,
      commit: F4,
      on: ASIDE,
      code: 'RELEASE_TAG_CONFLICT',
    });
    expect(String(tag?.reason)).toContain(ASIDE);
    expect(planted.writes).toEqual([]);
    // the ship stands: the refusal is told on the release, never by failing it
    expect(await statusOf(issue)).toBe('closed');
  });
});

describe('a ship that cannot tag says why on the release, and still ships', () => {
  it('a project with no source host binding records RELEASE_TAG_NO_SOURCE_HOST', async () => {
    planted.bound = false;
    const { version, issue } = await ship(5);

    expect(await tagOnPage(version)).toMatchObject({
      state: 'untagged',
      name: `v${version}`,
      commit: F4,
      code: 'RELEASE_TAG_NO_SOURCE_HOST',
    });
    expect(await statusOf(issue)).toBe('closed');
  });

  it('a host that fails the call records RELEASE_TAG_HOST_FAILED with its words', async () => {
    planted.failing = true;
    const { version } = await ship(5);

    const tag = await tagOnPage(version);
    expect(tag).toMatchObject({ state: 'untagged', code: 'RELEASE_TAG_HOST_FAILED' });
    expect(String(tag?.reason)).toContain('HTTP 502');
  });
});

describe('the release-tags guide says how a build reads its version (REQ-63 BC-15)', () => {
  it('names the tag, the commands a build reads it with, and the refusal', async () => {
    const guide = await api(world.token, 'GET', '/api/guides/release-tags.md');
    expect(guide.status).toBe(200);
    const text = String(guide.body.text ?? '').replace(/\s+/gu, ' ');
    expect(text).toContain('Forge puts the lightweight tag `v<version>`');
    expect(text).toContain('git fetch --tags && git describe --tags --exact-match HEAD');
    expect(text).toContain('`$CI_COMMIT_TAG`');
    expect(text).toContain('`$GITHUB_REF_NAME`');
    expect(text).toContain('refused `RELEASE_TAG_CONFLICT`');
  });
});
