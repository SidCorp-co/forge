/**
 * The release-record refusal against real Postgres.
 *
 * The unit suite mocks `db`, so it can prove the branch logic and nothing
 * about the transaction the branch runs before. That distinction is not
 * theoretical here: the first version of this rule also required
 * `merged_at IS NULL`, passed the mocked suite, and was falsified by this
 * layer — `markMergedIfLeavingBase` stamps inside the same transaction the
 * check reads the column before, so the condition refused the one path it
 * was written to exempt.
 *
 * So the assertions below are about what the DATABASE holds afterwards, not
 * about which branch was taken: a refused close leaves the row untouched and
 * `merged_at` unstamped, and the exempt paths reach `closed` for real.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type IssueRow = import('../../src/issues/apply-transition.js').TransitionIssueRow;

describe('release record required E2E', () => {
  let harness: TestDatabase;
  let projectId: string;
  let ownerId: string;
  let seq = 0;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.NODE_ENV ??= 'test';
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    projectId = (await createTestProject(harness.db, owner.id)).id;
  });

  // cm:guard the batch gate is now derived from the PROJECT, not from a config key: an active `prod` binding AND a production branch that differs from the base. Seed neither half and every case here fails on NO_RELEASE_GATE long before reaching what it meant to assert.
  // cm:edge contract -> packages/core/src/release-batch/gate.ts — `resolveProductionDeclaration` reads exactly these two facts
  async function declareProduction(): Promise<void> {
    const connectionId = randomUUID();
    await harness.db.execute(sql`
      UPDATE projects SET base_branch = 'main', production_branch = 'production' WHERE id = ${projectId}
    `);
    await harness.db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
      VALUES (${connectionId}, 'user', ${ownerId}, 'coolify', true)
    `);
    await harness.db.execute(sql`
      INSERT INTO integration_bindings (connection_id, project_id, provider, environment, active)
      VALUES (${connectionId}, ${projectId}, 'coolify', 'prod', true)
    `);
  }

  async function insertIssue(status: string, note: unknown = null): Promise<string> {
    const id = randomUUID();
    seq += 1;
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes)
      VALUES (
        ${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId},
        ${note === null ? null : JSON.stringify(note)}::jsonb
      )
    `);
    return id;
  }

  // cm:why raw SQL returns snake_case; the transition reads the drizzle row shape
  async function load(id: string): Promise<IssueRow> {
    const rows = await harness.db.execute(sql`
      SELECT id, project_id AS "projectId", status, reopen_count AS "reopenCount"
      FROM issues WHERE id = ${id}
    `);
    return rows[0] as unknown as IssueRow;
  }

  async function stored(id: string): Promise<{ status: string; mergedAt: unknown }> {
    const rows = await harness.db.execute(sql`
      SELECT status, merged_at FROM issues WHERE id = ${id}
    `);
    return { status: String(rows[0]?.status), mergedAt: rows[0]?.merged_at ?? null };
  }

  const device = () => ({ id: ownerId, ownerId }) as const;
  const human = () => ({ type: 'user', id: ownerId }) as const;
  const SKIP_NOTE = { section: 'Skip', userFacing: '-' };

  it('refuses an agent close with nothing written, and leaves the row exactly as it was', async () => {
    const { applyStatusTransition, TransitionError } = await import(
      '../../src/issues/apply-transition.js'
    );
    const id = await insertIssue('in_progress');

    const err = await applyStatusTransition(await load(id), 'closed', device()).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TransitionError);
    expect((err as { code: string }).code).toBe('RELEASE_RECORD_REQUIRED');
    expect(await stored(id)).toEqual({ status: 'in_progress', mergedAt: null });
  });

  // cm:guard `released -> closed` is the canonical close, and it is the case the first version of the rule got wrong: with a `merged_at IS NULL` condition the check read NULL here — the stamp lands later in the same transaction — and refused the path it meant to exempt. Both halves are asserted so that condition cannot come back green.
  it('refuses from `released` too, and lets it through once a note exists', async () => {
    const { applyStatusTransition } = await import('../../src/issues/apply-transition.js');
    const bare = await insertIssue('released');
    const noted = await insertIssue('released', SKIP_NOTE);

    await expect(applyStatusTransition(await load(bare), 'closed', device())).rejects.toThrow(
      'RELEASE_RECORD_REQUIRED',
    );
    expect((await stored(bare)).status).toBe('released');

    await applyStatusTransition(await load(noted), 'closed', device());
    const after = await stored(noted);
    expect(after.status).toBe('closed');
    expect(after.mergedAt).not.toBeNull();
  });

  it('leaves a human close alone — the claim is theirs to make', async () => {
    const { transitionIssueStatus } = await import('../../src/issues/apply-transition.js');
    const id = await insertIssue('in_progress');

    await transitionIssueStatus(await load(id), 'closed', human());

    expect((await stored(id)).status).toBe('closed');
  });

  it('leaves the decompose close cascade alone, so an abandoned epic still closes its children', async () => {
    const { applyStatusTransition } = await import('../../src/issues/apply-transition.js');
    const id = await insertIssue('in_progress');

    await applyStatusTransition(await load(id), 'closed', device(), {
      skip: true,
      viaCloseCascade: true,
    });

    expect((await stored(id)).status).toBe('closed');
  });

  // cm:guard the exemption is `viaCloseCascade`, NOT `skip`. `skip` is the wide flag every internal transition carries — the decompose cascade, the park rewrites, any future sweep — so exempting on it would let an unrecorded issue reach `closed` from any of them. Widening this to `skip` was tried and the integration suite falsified it.
  it('refuses a bare `skip`, which is what the orchestrator auto-skip chain carries', async () => {
    const { applyStatusTransition } = await import('../../src/issues/apply-transition.js');
    const id = await insertIssue('released');

    await expect(
      applyStatusTransition(await load(id), 'closed', device(), { skip: true }),
    ).rejects.toThrow('RELEASE_RECORD_REQUIRED');
    expect(await stored(id)).toEqual({ status: 'released', mergedAt: null });
  });

  it('leaves `dropped` alone, which is terminal without claiming a ship', async () => {
    const { applyStatusTransition } = await import('../../src/issues/apply-transition.js');
    const id = await insertIssue('in_progress');

    await applyStatusTransition(await load(id), 'dropped', device());

    expect(await stored(id)).toEqual({ status: 'dropped', mergedAt: null });
  });

  // cm:guard the OTHER door. `finishReleaseBatch` closes with `viaReleasePath`, which the transition rule exempts, so the batch is refused at its CLAIM instead — and this block is the whole justification for that exemption. ISS-863's evidence row is a batch that closed two issues whose releaseNotes was null; delete the preflight and that path is open again.
  // cm:guard this project declares production and the outer one deliberately does NOT — the two halves of this file need opposite answers from the same gate. With a gate, an agent's `closed` is rewritten to `released` (`issues/release-gate-hold.ts`) and every close case above would assert nothing; without one, `createReleaseBatch` throws NO_RELEASE_GATE before it reaches the note preflight these cases are about.
  describe('the release batch, refused at the claim rather than the close', () => {
    beforeEach(async () => {
      await declareProduction();
    });

    async function claim(ids: string[]) {
      const { createReleaseBatch } = await import('../../src/release-batch/service.js');
      return createReleaseBatch({ projectId, issueIds: ids, userId: ownerId });
    }

    async function claimedRunId(id: string): Promise<unknown> {
      const rows = await harness.db.execute(sql`
        SELECT release_batch_run_id FROM issues WHERE id = ${id}
      `);
      return rows[0]?.release_batch_run_id ?? null;
    }

    it('refuses the whole batch when any issue has no release note, and claims nothing', async () => {
      const { ReleaseRecordMissingError } = await import('../../src/release-batch/service.js');
      const noted = await insertIssue('released', SKIP_NOTE);
      const bare = await insertIssue('released');

      const err = await claim([noted, bare]).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ReleaseRecordMissingError);
      expect((err as { issueIds: string[] }).issueIds).toEqual([bare]);
      expect(await claimedRunId(noted)).toBeNull();
      expect(await claimedRunId(bare)).toBeNull();
      expect((await stored(bare)).status).toBe('released');
    });

    // cm:guard the refusal must come from the NOTE, not from something else failing first — a fully-noted batch has to get PAST this preflight, or the case above would pass just as well against a preflight that refused everything
    it('lets a fully-noted batch past this preflight', async () => {
      const a = await insertIssue('released', SKIP_NOTE);
      const b = await insertIssue('released', SKIP_NOTE);

      const err = await claim([a, b]).catch((e: unknown) => e);

      expect(err).not.toBeInstanceOf(
        (await import('../../src/release-batch/service.js')).ReleaseRecordMissingError,
      );
    });
  });
});
