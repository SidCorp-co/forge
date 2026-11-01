/**
 * A release performed by hand on a project with production, recorded through
 * `POST /api/projects/:id/release-records` (`release-batch/recorded.ts:recordPerformedRelease`), is
 * the agent's record under the version it shipped (owner ruling 2026-11-01,
 * `release-is-the-agents-record`): the run wears that version, `metadata.versionCut` says it was
 * `given`, and the Releases list shows it as any other release. Forge reads nothing of production to
 * accept it, so the deployment record reader is planted to fail if anything calls it.
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

vi.mock('../../src/release-batch/deployment-verify.js', () => ({
  verifyByDeploymentRecord: async () => {
    throw new Error('a release record read the deployment record');
  },
}));

let projectId: string;
let token: string;

beforeEach(async () => {
  await seedLandedWorld();
  ({ projectId, token } = world);
  await seedProduction({ projectId, ownerId: world.ownerId, probes: 'none' });
});

async function performed(
  seq: number,
  version: string,
): Promise<{ runId: string; version: unknown }> {
  const issue = await landedIssue(seq, F4);
  await judgedAll(issue, F4);
  const res = await record([issue], F4, { version });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body).toMatchObject({ verification: 'recorded', closed: [issue], failed: [] });
  return { runId: String(res.body.runId), version: res.body.version };
}

const versionCutOf = async (runId: string) => {
  const [row] = (await db.execute(sql`
    SELECT release_version, metadata -> 'versionCut' AS cut FROM pipeline_runs WHERE id = ${runId}
  `)) as unknown as Array<{ release_version: string | null; cut: unknown }>;
  return row;
};

describe('a release performed by hand wears the version its agent recorded', () => {
  it('appears on the list with its version and the rule that gave it', async () => {
    const { runId, version } = await performed(1, 'v0.1.0');

    expect(version).toBe('0.1.0');
    expect(await versionCutOf(runId)).toMatchObject({
      release_version: '0.1.0',
      cut: { decided: 'given', attempt: 1 },
    });
    const page0 = await ok(api(token, 'GET', `/api/projects/${projectId}/releases/0.1.0`));
    expect(JSON.stringify(page0)).toContain('"given"');
    const list = await ok(api(token, 'GET', `/api/projects/${projectId}/releases`));
    expect(list.releases).toMatchObject([{ version: '0.1.0', state: 'shipped' }]);
    const page = await api(token, 'GET', `/api/projects/${projectId}/releases/0.1.0`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
  });

  it('never shares a number with a second one, and the next cut takes the number after both', async () => {
    const first = await performed(1, '0.1.0');
    const second = await performed(2, '0.2.0');

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
