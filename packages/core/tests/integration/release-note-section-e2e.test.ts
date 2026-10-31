/**
 * ISS-835 (FB-417) — a release note's section is judged at every door that writes one, and the cut
 * names a stored note it cannot place.
 *
 * An agent wrote `section: "Improvements"`, which is no section; nothing said so until the release
 * refused the issue as `RELEASE_RECORD_MISSING`, naming neither the section nor the accepted ones.
 * The doors that write `issues.release_notes` are the PATCH route and `createIssue`; the cut reads
 * what they stored.
 *
 * @direct-test-of packages/core/src/issues/release-note-door.ts
 * @direct-test-of packages/core/src/issues/release-record-required.ts
 * @direct-test-of packages/core/src/release-batch/record-blocker.ts
 */

import { randomUUID } from 'node:crypto';
import { releaseNotesSections } from '@forge/contracts/release-notes';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { createIssue } from '../../src/issues/create-service.js';
import { RefusalError } from '../../src/lib/refusal.js';
import { collectReleaseBlockers } from '../../src/release-batch/blockers.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const ACCEPTED = releaseNotesSections.join(', ');
const BAD = { section: 'Improvements', title: 'Faster login', userFacing: 'Login is faster now.' };
const GOOD = { section: 'Fixed', title: 'Login works again', userFacing: 'Login works again.' };

beforeEach(async () => {
  await truncateAll();
});

async function seed() {
  const user = await createTestUser({ verified: true });
  const project = await createTestProject(user.id);
  await addProjectMember(project.id, user.id, 'admin');
  // no production environment: a record is the landing's own, and its roster owes a note
  await seedProjectDocument(project.id, user.id, { environments: {} });
  return { user, projectId: project.id, token: await userToken(user.id) };
}

let seq = 0;
async function plantIssue(
  w: { projectId: string; user: { id: string } },
  note: unknown,
): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes, merged_at)
    VALUES (${id}, ${w.projectId}, ${seq}, ${`issue ${seq}`}, 'awaiting_release', ${w.user.id},
            ${note === null ? null : JSON.stringify(note)}::jsonb, now())
  `);
  return id;
}

async function storedNote(id: string): Promise<unknown> {
  const rows = [...(await db.execute(sql`SELECT release_notes FROM issues WHERE id = ${id}`))] as {
    release_notes: unknown;
  }[];
  return rows[0]?.release_notes ?? null;
}

const writer = (w: { user: { id: string } }) =>
  ({
    createdById: w.user.id,
    createdByDeviceId: null,
    createdVia: 'web',
    actor: { type: 'user', id: w.user.id, agency: 'human' },
  }) as const;

describe('PATCH door', () => {
  it('refuses an unknown section by name, with the accepted ones, and stores nothing', async () => {
    const w = await seed();
    const id = await plantIssue(w, null);
    const res = await api(w.token, 'PATCH', `/api/issues/${id}`, { releaseNotes: BAD });
    expect(res.status).toBe(400);
    const said = JSON.stringify(res.body);
    expect(said).toContain('"path":"/releaseNotes/section"');
    expect(said).toContain('Improvements');
    expect(said).toContain(`the accepted sections are ${ACCEPTED}`);
    expect(await storedNote(id)).toBeNull();
  });

  it('writes a known section as before', async () => {
    const w = await seed();
    const id = await plantIssue(w, null);
    const res = await api(w.token, 'PATCH', `/api/issues/${id}`, { releaseNotes: GOOD });
    expect(res.status).toBe(200);
    expect(await storedNote(id)).toMatchObject({ section: 'Fixed' });
  });
});

describe('create door', () => {
  it('refuses an unknown section by name, with the accepted ones, and files no issue', async () => {
    const w = await seed();
    const err = await createIssue(
      { projectId: w.projectId, title: 'noted at birth', releaseNotes: BAD },
      writer(w),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, 'a bad section was accepted at birth').toBeInstanceOf(RefusalError);
    const refusal = (err as RefusalError).refusals[0];
    expect(refusal?.code).toBe('RELEASE_NOTE_REFUSED');
    expect(refusal?.path).toBe('/releaseNotes/section');
    expect(refusal?.detail).toContain('Improvements');
    expect(refusal?.detail).toContain(`the accepted sections are ${ACCEPTED}`);
    const rows = [...(await db.execute(sql`SELECT id FROM issues WHERE title = 'noted at birth'`))];
    expect(rows).toHaveLength(0);
  });

  it('refuses a note that is no object, naming the path', async () => {
    const w = await seed();
    const err = await createIssue(
      { projectId: w.projectId, title: 'noted as text', releaseNotes: 'Fixed the login' },
      writer(w),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).refusals[0]?.path).toBe('/releaseNotes');
  });

  it('files a known section as before', async () => {
    const w = await seed();
    const made = await createIssue(
      { projectId: w.projectId, title: 'noted fine', releaseNotes: GOOD },
      writer(w),
    );
    expect(made.deduped).toBe(false);
    if (made.deduped) return;
    expect(await storedNote(made.issue.id)).toMatchObject({ section: 'Fixed' });
  });
});

describe('the cut', () => {
  const recordBlockers = async (w: { projectId: string }, ids: string[]) =>
    (await collectReleaseBlockers(w.projectId, { issueIds: ids, door: 'record' })).blockers.filter(
      (b) => b.code === 'RELEASE_RECORD_MISSING',
    );

  it('names the issue, the section it holds and the accepted ones for a stored bad section', async () => {
    const w = await seed();
    const bad = await plantIssue(w, BAD);
    const found = await recordBlockers(w, [bad]);
    expect(found).toHaveLength(1);
    const said = found[0]?.message ?? '';
    expect(said).toMatch(/`[A-Z]+-\d+`/);
    expect(said).toContain('"Improvements"');
    expect(said).toContain(`the accepted sections are ${ACCEPTED}`);
    expect(found[0]?.details?.unreadable).toEqual([
      { issueId: bad, displayId: expect.stringMatching(/-\d+$/), section: 'Improvements' },
    ]);
  });

  it('keeps a missing note missing, and a known section passes', async () => {
    const w = await seed();
    const none = await plantIssue(w, null);
    const good = await plantIssue(w, GOOD);
    const found = await recordBlockers(w, [none, good]);
    expect(found).toHaveLength(1);
    expect(found[0]?.details?.issueIds).toEqual([none]);
    expect(found[0]?.details?.unreadable).toBeUndefined();
    expect(found[0]?.message).not.toContain('accepted sections');
  });
});
