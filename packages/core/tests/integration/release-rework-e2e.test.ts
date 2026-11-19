/**
 * A release read where its issue was reopened between two releases (BC-6): the release that closed
 * it again lists the rework under Fixes, and the one that shipped it first reads it reworked —
 * through the app's own routes, against real Postgres. Split from `release-read-model-e2e.test.ts`.
 *
 * @direct-test-of packages/core/src/release-page/sections.ts
 * @direct-test-of packages/contracts/src/release-page.ts
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { backgroundRefreshesSettled } from '../../src/release-page/index.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

const BETA_SHA = 'e7af41887a0e90ed541bb0dbfb34d4f9cb4f8510';

let projectId: string;
let ownerId: string;
let agentId: string;
let memberToken = '';

const fx = releaseWorld(() => ({ projectId, ownerId }));
let unplant: (() => void) | null = null;

afterEach(async () => {
  unplant?.();
  // a page read that found its highlights owed starts a refresh; none outlives its test
  await backgroundRefreshesSettled();
});

beforeEach(async () => {
  // production serves BETA_SHA through a source probe the plant answers (ISS-957)
  unplant = plantLiveBuild(BETA_SHA);
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const member = await createTestUser({ verified: true });
  await addProjectMember(projectId, member.id, 'member');
  memberToken = await userToken(member.id);
  agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agentId, 'admin');
  await fx.seedReleaseRunner();
  const bindingId = await fx.declareProduction({}, 'none');
  await declareProductionDocument({
    projectId,
    ownerId,
    bindingId,
    probes: 'source',
    others: { beta: { tier: 'staging', deployment: { mode: 'external' } } },
  });
});

describe('an issue reopened between two releases reads as the rework of the one that shipped it (BC-6)', () => {
  // J10 on 0.4.0-dev.227, ISS-455's real timeline: dev.224 shipped round 1 and released at 02:01;
  // dev.225's run started at 02:17; J8 reopened the issue at 02:21; its retry fix, with migration
  // 0495, was closed into dev.225 when that release shipped at 03:12. dev.225 read it as "reworked in
  // a later release", left its note out of Fixes, and asked for 0495's backup naming no issue.
  const RETRY = 'An assistant draft the model missed is tried again, up to three tries.';
  const MIGRATION = 'packages/core/drizzle/migrations/0495_intake_retry.sql';
  const day = (hms: string) => `2026-10-10T${hms}Z`;

  async function shippedRun(
    version: string,
    started: string,
    released: string,
    roster: { issueIds: string[]; rosterClosed: string[] },
  ) {
    const meta = {
      source: 'release-batch',
      ...roster,
      finish: { requestId: version, state: 'finished', commit: BETA_SHA, version: 1 },
    };
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, release_released_at, metadata)
      VALUES (gen_random_uuid(), ${projectId}, 'system', 'completed', ${day(started)}, ${version},
              ${day(released)}, ${JSON.stringify(meta)}::jsonb)
    `);
  }

  async function moved(issueId: string, from: string, to: string, at: string) {
    await db.execute(sql`
      INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, actor_id, source, created_at)
      VALUES ('issue', ${issueId}, ${from}, ${to}, 'user', 'agent', ${agentId}, 'planted', ${day(at)})
    `);
  }

  type Page = {
    fixes: Array<{ issueKey: string; kind: string; line: string }>;
    withoutNotes: Array<{ issueKey: string; why: string }>;
    actionRequired: Array<{ kind: string; ref: string; issues: string[] }>;
  };
  const page = async (version: string) => {
    const r = await api(
      memberToken,
      'GET',
      `/api/projects/${projectId}/releases/${version}/page?view=developer`,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as unknown as Page;
  };

  /** ISS-455 shipped by dev.224, then reopened inside dev.225's window. */
  async function iss455() {
    const id = await fx.insertIssue('closed', {
      section: 'Fixed',
      title: 'Missed drafts retried',
      userFacing: RETRY,
    });
    await db.execute(sql`
      UPDATE issues SET merged_artifacts = ${JSON.stringify([
        { surface: 'data', ref: MIGRATION, change: 'added' },
      ])}::jsonb WHERE id = ${id}
    `);
    await shippedRun('0.4.0-dev.224', '01:19:11.380', '02:01:10.033', {
      issueIds: [id],
      rosterClosed: [],
    });
    await shippedRun('0.4.0-dev.225', '02:17:16.051', '03:12:04.688', {
      issueIds: [],
      rosterClosed: [id],
    });
    await moved(id, 'awaiting_release', 'closed', '02:01:10.040');
    await moved(id, 'closed', 'reopen', '02:21:48.000');
    return id;
  }

  it('lists the rework under dev.225 Fixes, asks no backup of it once shipped, and keeps dev.224 reworked', async () => {
    const id = await iss455();
    await moved(id, 'awaiting_release', 'closed', '03:12:04.690');
    const dev225 = await page('0.4.0-dev.225');
    expect(dev225.withoutNotes).toEqual([]);
    const key = dev225.fixes[0]?.issueKey;
    expect(dev225.fixes).toEqual([
      {
        issueKey: key,
        kind: 'fixed',
        section: 'Fixed',
        line: 'Missed drafts retried',
        detail: RETRY,
        requirementKey: null,
        screen: null,
        // its landing touched data alone, so it shows no screen and owes no visual (ISS-1308)
        ui: false,
        visual: null,
        proof: null,
      },
    ]);
    // shipped, its backup is past (ISS-1198); an unshipped one names the issue (sections-range.test.ts)
    expect(dev225.actionRequired).toEqual([]);

    const dev224 = await page('0.4.0-dev.224');
    expect(dev224.fixes).toEqual([]);
    expect(dev224.withoutNotes).toEqual([
      expect.objectContaining({ issueKey: key, why: 'reworked' }),
    ]);
    expect(dev224.actionRequired).toEqual([]);
  });

  it('reads it reworked on dev.225 as well where dev.225 never closed it', async () => {
    await iss455();
    const dev225 = await page('0.4.0-dev.225');
    expect(dev225.fixes).toEqual([]);
    expect(dev225.withoutNotes.map((w) => w.why)).toEqual(['reworked']);
  });
});
