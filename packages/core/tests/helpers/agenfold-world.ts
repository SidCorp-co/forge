/**
 * agenfold's shape for the landing tests (`release-batch/criteria-basis.ts`, ISS-957, ISS-967): a
 * project whose production on `release/stg` declares no source probe, so its releases are its agent's
 * record by version, and whose automatic release drafts the next one as work lands. Seeded on top of
 * `landed-world.ts:seedLandedWorld`.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { db } from '../../src/db/client.js';
import { api } from './api.js';
import { BRANCH, world } from './landed-world.js';
import { seedProjectDocument } from './release-world.js';

/**
 * agenfold's document: production on `release/stg` with no source probe. `external` is how its agent
 * records a release by hand (`release-records`); `onLand` is the automatic release that drafts the
 * next one, which is what holds work.
 */
export async function agenfold(deployment: 'external' | 'onLand'): Promise<void> {
  await seedProjectDocument(world.projectId, world.ownerId, {
    defaultBranch: BRANCH,
    environments: {
      production: {
        tier: 'production',
        deploysFrom: BRANCH,
        deployment:
          deployment === 'external'
            ? { mode: 'external', target: 'agenfold-deploy' }
            : { binding: randomUUID(), trigger: 'on-land' },
      },
    } as never,
    extra: { delivery: { verdictsRequired: true } } as never,
  });
}

/** Records `version` shipped carrying `issueIds`, as agenfold's agent does, and arms the sweep. */
export async function shipped(issueIds: string[], version: string): Promise<void> {
  await agenfold('external');
  const res = await api(world.token, 'POST', `/api/projects/${world.projectId}/release-records`, {
    issueIds,
    version,
    account: `agenfold-deploy shipped ${version}; /healthz reports ${version}.`,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await agenfold('onLand');
}

/**
 * QA's verdict on criterion `n`, at a commit or on a release, written as the door stores it: an
 * observable verdict through the door also owes a kept probe, which is not what these tests are about.
 */
export async function stored(
  issueId: string,
  n: number,
  at: { commit: string } | { release: string },
  word: 'pass' | 'fail' = 'pass',
): Promise<void> {
  const [criterion] = (await db.execute(sql`
    SELECT id FROM issue_criteria WHERE issue_id = ${issueId} AND n = ${n} AND retired_at IS NULL
  `)) as unknown as Array<{ id: string }>;
  const kind = 'commit' in at ? 'commit' : 'release';
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind, commit_sha,
                                    release_version, author_user_id, author_agency, judge)
    VALUES (${criterion?.id}, ${issueId}, ${word}, 'judged as the identity names', ${kind},
            ${'commit' in at ? at.commit : null}, ${'release' in at ? at.release : null},
            ${world.ownerId}, 'agent', 'qa')
  `);
}

/** Gives criterion `n` of `issueId` its class, as a recorded design holds it. */
export async function designed(issueId: string, lines: Array<[number, string]>): Promise<void> {
  await db.execute(sql`
    INSERT INTO issue_designs (issue_id, project_id, revision, modules, contracts, recorded_by)
    VALUES (${issueId}, ${world.projectId}, 1, '{}'::uuid[], '{}'::text[], ${world.ownerId})
    ON CONFLICT (issue_id) DO NOTHING
  `);
  for (const [n, criterionClass] of lines) {
    await db.execute(sql`
      INSERT INTO issue_design_criteria (criterion_id, issue_id, criterion_class, pattern, proof)
      SELECT id, issue_id, ${criterionClass}, NULL, 'the probe that proves it'
        FROM issue_criteria WHERE issue_id = ${issueId} AND n = ${n} AND retired_at IS NULL
    `);
  }
}
