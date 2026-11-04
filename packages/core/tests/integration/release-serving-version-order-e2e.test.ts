/**
 * ISS-907 (FB-481, epod, 2026-11-02) — the release production serves is the highest version shipped,
 * never the record written last. epod recorded 1.34.0 at 12:53 UTC, which production runs, and at
 * 12:57 backfilled 1.21.0 for thirteen issues. `currentReleaseVersion` ordered by
 * `release_released_at`, which on a recorded release is when the record was written, so GET releases
 * marked 1.21.0 current and the REQ-10 and REQ-8 standings asked to judge BC-1 on 1.21.0.
 *
 * Planted as epod stands: production deployed outside Forge with no source probe, so its releases are
 * its agent's record by version, recorded through `POST /projects/:id/release-records`, read back
 * through GET releases, the requirement's standing and `currentReleaseVersion` itself, against real
 * Postgres. Prerelease lines are ordered by `version.ts:compareReleaseVersions`: `0.4.0-dev.10`
 * outranks `0.4.0-dev.9` (numeric, never the strings), and a prerelease sits below the release it
 * previews.
 *
 * @direct-test-of packages/core/src/release-batch/version-store.ts
 * @direct-test-of packages/core/src/release-batch/released-line.ts
 * @direct-test-of packages/core/src/release-batch/release-read.ts
 * @direct-test-of packages/core/src/release-batch/release-read-views.ts
 * @direct-test-of packages/core/src/release-batch/queries.ts
 * @direct-test-of packages/contracts/src/released-line.ts
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { currentReleaseVersion } from '../../src/release-batch/version-store.js';
import { api } from '../helpers/api.js';
import { agreedRequirement, traced } from '../helpers/landed-requirement.js';
import {
  BRANCH,
  C1,
  F4,
  judgedAll,
  landedIssue,
  ok,
  seedLandedWorld,
  world,
} from '../helpers/landed-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const ACCOUNT = 'epod-deploy shipped the tag to production; /healthz reports the version.';

/** epod's document: production deployed outside Forge from `release/stg`, reporting no commit. */
async function epod(): Promise<void> {
  await seedProjectDocument(world.projectId, world.ownerId, {
    defaultBranch: BRANCH,
    environments: {
      production: {
        tier: 'production',
        deploysFrom: BRANCH,
        deployment: { mode: 'external', target: 'epod-deploy' },
      },
    } as never,
    extra: { delivery: { verdictsRequired: false } } as never,
  });
}

const onProject = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(world.token, method, `/api/projects/${world.projectId}${path}`, body);

let seq = 0;

/** Record `version` as shipped, carrying a fresh landed issue unless `issueIds` names some. */
async function recordRelease(version: string, issueIds?: string[]): Promise<void> {
  const ids = issueIds ?? [await landedIssue(++seq, F4)];
  const res = await onProject('POST', '/release-records', {
    issueIds: ids,
    version,
    account: ACCOUNT,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

type Listed = { version: string; state: string; current: boolean };

/** GET releases: which listed versions are marked current, and what production serves. */
async function listed(): Promise<{ current: string[]; serving: unknown }> {
  const body = await ok(onProject('GET', '/releases'));
  const releases = body.releases as Listed[];
  return {
    current: releases.filter((r) => r.current).map((r) => r.version),
    serving: (body.production as { serving: unknown }).serving,
  };
}

/** The one answer every reader gives: GET releases' mark and serving, and the store's own read. */
async function expectServing(version: string): Promise<void> {
  expect(await listed()).toEqual({ current: [version], serving: version });
  expect(await currentReleaseVersion(world.projectId)).toBe(version);
}

beforeEach(async () => {
  seq = 0;
  await seedLandedWorld();
  await epod();
});

describe('the serving release is the highest version shipped, not the record written last (ISS-907)', () => {
  it('keeps 1.34.0 current after 1.21.0 is backfilled for other issues', async () => {
    await recordRelease('1.34.0');
    await expectServing('1.34.0');

    await recordRelease('1.21.0', [await landedIssue(++seq, F4), await landedIssue(++seq, F4)]);
    await expectServing('1.34.0');
    const { current } = await listed();
    expect(current).not.toContain('1.21.0');
  });

  it("asks the requirement's judge for verdicts on 1.34.0, never on the backfilled 1.21.0", async () => {
    const req = await agreedRequirement(['A buyer pays for an order']);
    const issue = await landedIssue(++seq, F4);
    await traced(req, issue, seq, { 1: 'BC-1' });
    // the issue's own passes at a commit that is not its landing: nothing on this project places
    // them (a pass at the landing F4 counts there, ISS-957)
    await judgedAll(issue, C1);
    await recordRelease('1.34.0', [issue]);
    await recordRelease('1.21.0');

    const read = await ok(onProject('GET', `/requirements/${req}`));
    const standing = read.standing as {
      waitingOn: { says: { act: { key: string; vars?: Record<string, unknown> } } } | null;
      coverage: Array<{ issues: Array<{ notCounted: string | null }> }>;
    };
    expect(standing.waitingOn?.says.act).toMatchObject({
      key: 'standing.act.judgeOnReleaseOn',
      vars: { version: '1.34.0' },
    });
    expect(JSON.stringify(standing)).not.toContain('1.21.0');
  });

  it('ranks 0.4.0-dev.10 above 0.4.0-dev.9 by number, whichever was recorded last', async () => {
    await recordRelease('0.4.0-dev.10');
    await recordRelease('0.4.0-dev.9');
    // stamp order and string order both say dev.9; release order says dev.10
    await expectServing('0.4.0-dev.10');
  });

  it('ranks a prerelease below the release it previews, and above every earlier release', async () => {
    await recordRelease('0.3.0');
    await recordRelease('0.4.0-dev.12');
    await expectServing('0.4.0-dev.12');

    await recordRelease('0.4.0');
    await recordRelease('0.4.0-dev.13');
    await expectServing('0.4.0');
  });
});
