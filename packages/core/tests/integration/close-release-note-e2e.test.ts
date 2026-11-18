/**
 * A holder's close reads the issue's release note (ISS-1293, FB-716). Planted from gwork's board: its
 * master closed issues while the note's write had been refused (two sentences, an 11-word title, a
 * missing section) and wrote the note only after the close; every close went through.
 *
 * - a close with no note recorded is refused by name, naming the note door and its shape (`Skip`
 *   included), and nothing is written: the status, the criteria's verdicts and the comments stand;
 * - a note the door refused stores nothing, so the close after it is still refused;
 * - a close after a `Skip` note or a full note goes through;
 * - a release is never wedged by an issue with no note: a release record drafts it and closes the
 *   issue, and an issue a release claimed closes with no note asked.
 *
 * @direct-test-of packages/core/src/issues/close-note-guard.ts
 * @direct-test-of packages/core/src/issues/close-in-scope.ts
 * @direct-test-of packages/core/src/issues/transition-guards.ts
 * @direct-test-of packages/core/src/issues/release-note-door.ts
 * @direct-test-of packages/core/src/release-batch/close-roster.ts
 * @direct-test-of packages/core/src/release-batch/recorded.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userToken } from '../helpers/api.js';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const SHA = 'cd34'.repeat(10);

let projectId = '';
let ownerId = '';
let call: (who: string, method: string, path: string, body?: unknown) => Promise<Reply>;

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await seedProjectDocument(projectId, ownerId, {
    environments: {
      live: { tier: 'production', deployment: { mode: 'external', target: 'gwork-deploy' } },
    },
    defaultBranch: 'main',
  });
  // a member agent's box, as a pool runner's is: it holds no project.admin to move past a holder
  const holder = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, holder, 'member');
  const { mintPat } = await import('../../src/credentials/pat.js');
  const deviceId = await createTestDevice(holder);
  const pat = await mintPat({
    permissions: ['*'],
    userId: holder,
    name: 'box-holder',
    deviceId,
    projectIds: [projectId],
  });
  call = requester(app, { holder: pat.plaintext, owner: await userToken(ownerId) });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

let seq = 700;
/** An issue its run landed and holds, at `awaiting_release` with its merge recorded and no note. */
async function landedHeld(): Promise<string> {
  seq += 1;
  const id = randomUUID();
  await rows(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at, merged_commit_sha)
    VALUES (${id}, ${projectId}, ${seq}, ${`gwork work ${seq}`}, 'awaiting_release', ${ownerId}, now(), ${SHA})`);
  await rows(sql`
    INSERT INTO issue_criteria (issue_id, n, statement, position)
    VALUES (${id}, 1, 'the timesheet totals the week', 0)`);
  ok(
    await call('holder', 'PATCH', `/api/issues/${id}`, {
      sessionContext: {
        lease: { holder: 'gwork-master', renewedAt: new Date().toISOString(), minutes: 60 },
      },
    }),
  );
  return id;
}

const close = (id: string, who = 'holder') =>
  call(who, 'POST', `/api/issues/${id}/transition`, { toStatus: 'closed' });
const writeNote = (id: string, releaseNotes: unknown) =>
  call('holder', 'PATCH', `/api/issues/${id}`, { releaseNotes });

const statusOf = async (id: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`))[0]?.status;

const refusalsOf = (r: Reply): Array<{ code: string; detail: string }> => {
  const e = (r.json as { error?: { code?: string; detail?: string; refusals?: unknown[] } }).error;
  return (
    (e?.refusals as Array<{ code: string; detail: string }> | undefined) ?? [
      { code: e?.code ?? '', detail: e?.detail ?? '' },
    ]
  );
};

/** What a close writes beside the status: the comments and the verdicts its self-judging records. */
async function writtenBeside(id: string): Promise<{ comments: number; verdicts: number }> {
  const [c] = await rows<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM comments WHERE issue_id = ${id}`,
  );
  const [v] = await rows<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM criterion_verdicts WHERE issue_id = ${id}`,
  );
  return { comments: c?.n ?? 0, verdicts: v?.n ?? 0 };
}

describe("a holder's close reads the release note (ISS-1293)", () => {
  it('refuses a close with no note by name, naming the door and the shape, Skip included, writing nothing', async () => {
    const id = await landedHeld();
    const before = await writtenBeside(id);
    const r = await close(id);
    expect(r.status, JSON.stringify(r.json)).toBe(422);
    const [first] = refusalsOf(r);
    expect(first?.code).toBe('CLOSE_RELEASE_NOTE_MISSING');
    expect(first?.detail).toContain(`PATCH /api/issues/${id}`);
    expect(first?.detail).toContain('"releaseNotes":{"section":"Skip","userFacing":"-"}');
    expect(first?.detail).toContain('"title":"<at most 10 words>"');
    expect(first?.detail).toContain(`GET /api/issues/${id}`);
    expect(await statusOf(id)).toBe('awaiting_release');
    expect(await writtenBeside(id)).toEqual(before);
  });

  it('reads a stored JSON null as no note', async () => {
    const id = await landedHeld();
    await rows(sql`UPDATE issues SET release_notes = 'null'::jsonb WHERE id = ${id}`);
    expect(refusalsOf(await close(id))[0]?.code).toBe('CLOSE_RELEASE_NOTE_MISSING');
    expect(await statusOf(id)).toBe('awaiting_release');
  });

  it('still refuses the close after the door refused the note, which stored nothing', async () => {
    const id = await landedHeld();
    const bad = await writeNote(id, {
      section: 'Fixed',
      userFacing: 'The timesheet totals the week. It also rounds.',
    });
    expect(bad.status).toBe(400);
    const refused = (bad.json as { error?: { refusals?: Array<{ path: string }> } }).error;
    expect(refused?.refusals?.[0]?.path).toBe('/releaseNotes/title');
    expect(refusalsOf(await close(id))[0]?.code).toBe('CLOSE_RELEASE_NOTE_MISSING');
    expect(await statusOf(id)).toBe('awaiting_release');
  });

  it('closes after a Skip note', async () => {
    const id = await landedHeld();
    ok(await writeNote(id, { section: 'Skip', userFacing: '-' }));
    const r = await close(id);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await statusOf(id)).toBe('closed');
  });

  it('closes after a full note', async () => {
    const id = await landedHeld();
    ok(
      await writeNote(id, {
        section: 'Fixed',
        title: 'Timesheet totals the week',
        userFacing: 'The timesheet now totals the whole week.',
      }),
    );
    const r = await close(id);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await statusOf(id)).toBe('closed');
  });
});

describe('a release is never wedged by an issue with no note (ISS-1293)', () => {
  it('closes an issue a release claimed with no note asked', async () => {
    const id = await landedHeld();
    const runId = randomUUID();
    await rows(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, metadata)
      VALUES (${runId}, ${projectId}, 'system', 'running', now(), '4.0.1',
              ${JSON.stringify({ source: 'release-batch', issueIds: [id] })}::jsonb)`);
    await rows(sql`UPDATE issues SET release_batch_run_id = ${runId} WHERE id = ${id}`);
    const { closeRoster } = await import('../../src/release-batch/close-roster.js');
    const { accountActor } = await import('../../src/issues/account-actor.js');
    const closed = await closeRoster(
      [{ id, status: 'awaiting_release', reopenCount: 0, projectId }],
      runId,
      await accountActor(ownerId),
      undefined,
    );
    expect(closed).toEqual({ closed: [id], failed: [] });
    expect(await statusOf(id)).toBe('closed');
  });

  it('closes an issue with no note on a recorded release, its note drafted for the master', async () => {
    const id = await landedHeld();
    ok(
      await call('owner', 'POST', `/api/projects/${projectId}/release-records`, {
        issueIds: [id],
        version: '4.1.0',
        account: 'gwork 4.1.0 deployed by its own pipeline; read live at /health.',
      }),
      201,
    );
    expect(await statusOf(id)).toBe('closed');
    const [row] = await rows<{ section: string | null }>(
      sql`SELECT release_notes ->> 'section' AS section FROM issues WHERE id = ${id}`,
    );
    expect(row?.section).toBe('Changed');
  });
});
