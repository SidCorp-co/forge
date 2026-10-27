/**
 * A release performed by hand on a project with production, recorded through
 * `POST /api/projects/:id/release-records` (`release-batch/recorded.ts:recordPerformedRelease`), is a
 * release that happened now: it takes the next version through the one rule
 * (`version-store.ts:cutReleaseVersion`), writes `metadata.versionCut` beside it, and the Releases
 * list shows it as any other release. Before this it opened a run with no version, which no page
 * could list and no later cut counted (coordinator ruling, 2026-10-27).
 *
 * What production serves is read from its deployment record; that reader is planted here to agree
 * with the claimed commit, since the subject is the version the record takes, not the read.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import {
  F4,
  judgedAll,
  landedIssue,
  ok,
  record,
  seedLandedWorld,
  world,
} from '../helpers/landed-world.js';
import { seedProduction } from '../helpers/release-world.js';

vi.mock('../../src/release-batch/shipped-earlier.js', async (importOriginal) => {
  const { reader } = await import('../helpers/landed-history.js');
  return {
    ...(await importOriginal<typeof import('../../src/release-batch/shipped-earlier.js')>()),
    ancestrySourceFor: async () => ({ kind: 'box', why: 'the planted box', reader }),
  };
});

vi.mock('../../src/release-batch/deployment-verify.js', () => ({
  verifyByDeploymentRecord: async (_projectId: string, expected: string) => ({
    ok: true,
    identity: expected,
    readings: [`${expected} at the planted deployment record`],
  }),
}));

let projectId: string;
let token: string;

beforeEach(async () => {
  await seedLandedWorld();
  ({ projectId, token } = world);
  await seedProduction({ projectId, ownerId: world.ownerId, probes: 'none' });
});

async function performed(seq: number): Promise<{ runId: string; version: unknown }> {
  const issue = await landedIssue(seq, F4);
  await judgedAll(issue, F4);
  const res = await record([issue], F4);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body).toMatchObject({ verification: 'deployment', closed: [issue], failed: [] });
  return { runId: String(res.body.runId), version: res.body.version };
}

const versionCutOf = async (runId: string) => {
  const [row] = (await db.execute(sql`
    SELECT release_version, metadata -> 'versionCut' AS cut FROM pipeline_runs WHERE id = ${runId}
  `)) as unknown as Array<{ release_version: string | null; cut: unknown }>;
  return row;
};

describe('a release performed by hand takes a version as any release does', () => {
  it('appears on the list with its version and the rule that gave it', async () => {
    const { runId, version } = await performed(1);

    expect(version).toBe('0.1.0');
    expect(await versionCutOf(runId)).toMatchObject({
      release_version: '0.1.0',
      cut: { decided: 'first', attempt: 1 },
    });
    const list = await ok(api(token, 'GET', `/api/projects/${projectId}/releases`));
    expect(list.releases).toMatchObject([{ version: '0.1.0', state: 'shipped' }]);
    const page = await api(token, 'GET', `/api/projects/${projectId}/releases/0.1.0`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
  });

  it('never shares a number with a second one, and the next cut takes the number after both', async () => {
    const first = await performed(1);
    const second = await performed(2);

    expect([first.version, second.version]).toEqual(['0.1.0', '0.2.0']);

    await landedIssue(3, F4);
    const list = await ok(api(token, 'GET', `/api/projects/${projectId}/releases`));
    const shown = (list.releases as Array<{ version: string; state: string }>).map((r) => [
      r.version,
      r.state,
    ]);
    expect(shown).toEqual(
      expect.arrayContaining([
        ['0.3.0', 'draft'],
        ['0.2.0', 'shipped'],
        ['0.1.0', 'shipped'],
      ]),
    );
    expect(shown).toHaveLength(3);
  });
});
