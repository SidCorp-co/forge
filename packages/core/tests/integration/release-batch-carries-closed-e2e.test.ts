/**
 * A release cut through a run carries an issue its holder closed met in scope (ISS-1062): `closed`
 * says its criteria were met in scope, never that a release shipped it, so the roster a gated
 * project's batch claims lists it beside the issues at `awaiting_release`. The finish records the
 * release without moving its status, and once that release has shipped the issue reads released in
 * it and waits for no other. Against real Postgres.
 *
 * @direct-test-of packages/core/src/issues/waiting-for-release.ts
 * @direct-test-of packages/core/src/issues/release-claim.ts
 * @direct-test-of packages/core/src/release-batch/create.ts
 * @direct-test-of packages/core/src/release-batch/claim-conflicts.ts
 * @direct-test-of packages/core/src/release-batch/close-roster.ts
 * @direct-test-of packages/core/src/release-batch/releasing-recovery.ts
 * @direct-test-of packages/core/src/release-batch/queries.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TransitionActor } from '../../src/issues/index.js';
import { userToken } from '../helpers/api.js';
import { closeWorld, ok, requester, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser, rows } from '../helpers/factories.js';
import { releaseWorld } from '../helpers/release-world.js';

let projectId = '';
let ownerId = '';
let call: ReturnType<typeof requester>;
const fx = releaseWorld(() => ({ projectId, ownerId }));
const actor = (): TransitionActor => ({ type: 'user', id: ownerId, agency: 'agent' });

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [] }, 'none');
  await fx.seedReleaseRunner();
  call = requester(app, { owner: await userToken(ownerId) });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** An issue landed and at the gate, its merge naming a commit. */
async function atGate(): Promise<string> {
  const id = await fx.insertIssue('awaiting_release');
  await rows(sql`UPDATE issues SET merged_commit_sha = ${'cd34'.repeat(10)} WHERE id = ${id}`);
  return id;
}

/** Closed met in scope by a project admin, no release carrying it. */
async function closedInScope(): Promise<string> {
  const id = await atGate();
  ok(await call('owner', 'POST', `/api/issues/${id}/transition`, { toStatus: 'closed' }));
  expect((await fx.stored(id)).status).toBe('closed');
  return id;
}

async function roster(): Promise<string[]> {
  const { draftReleaseIssueIds } = await import('../../src/release-batch/index.js');
  return draftReleaseIssueIds(projectId);
}

async function shippedIn(id: string) {
  const { shippedReleasesOf } = await import('../../src/pipeline/release-runs.js');
  return (await shippedReleasesOf(projectId, [id])).get(id) ?? null;
}

describe('a release cut through a run carries an issue its holder closed (ISS-1062)', () => {
  it('claims it on the roster with the gate issues, finishes it as closed, and reads it released', async () => {
    const closed = await closedInScope();
    const waiting = await atGate();
    expect(await roster()).toEqual(expect.arrayContaining([closed, waiting]));

    const { runId, version } = await fx.claim([closed, waiting]);
    expect(await fx.stored(closed)).toMatchObject({ status: 'closed', claim: runId, step: null });
    expect(await fx.stored(waiting)).toMatchObject({ claim: runId, step: 'release' });

    const result = await finishReleaseBatchOf(runId);
    expect(new Set(result.closed)).toEqual(new Set([closed, waiting]));
    expect(result.failed).toEqual([]);
    expect((await fx.stored(closed)).status).toBe('closed');
    expect((await fx.stored(waiting)).status).toBe('closed');
    const [run] = await rows<{ status: string; metadata: Record<string, unknown> }>(
      sql`SELECT status, metadata FROM pipeline_runs WHERE id = ${runId}`,
    );
    expect(run?.status).toBe('completed');
    expect(run?.metadata.carriedClosed).toEqual([closed]);
    expect((await shippedIn(closed))?.version).toBe(version);
    expect((await shippedIn(waiting))?.version).toBe(version);
  });

  it('leaves it off the next roster once a shipped release holds it, and refuses it there by name', async () => {
    const closed = await closedInScope();
    const { runId } = await fx.claim([closed]);
    await finishReleaseBatchOf(runId);
    expect(await roster()).not.toContain(closed);
    const { createReleaseBatch } = await import('../../src/release-batch/create.js');
    const { refusalCodeOf } = await import('../../src/lib/refusal.js');
    const again = await createReleaseBatch({ projectId, issueIds: [closed], userId: ownerId }).then(
      (cut) => `cut ${cut.version}`,
      (err: unknown) => refusalCodeOf(err) ?? String(err),
    );
    expect(again).toBe('CLAIM_CONFLICT');
  });
});

async function finishReleaseBatchOf(runId: string) {
  const { finishReleaseBatch } = await import('../../src/release-batch/finish.js');
  return finishReleaseBatch(runId, actor());
}
