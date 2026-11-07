/**
 * A release note's script is read against the project's content language on every door that writes
 * it, the issue PATCH and the issue create, in both directions (ISS-1099): an English note for a vi
 * project and a Vietnamese one for an en project are stored and answered with a warning naming the
 * field and the language it should be in; a note in the project's language, and one with no letter
 * that decides it (a version), carry none.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { createIssue } from '../../src/issues/create-service.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const english = 'Fixes the login page so a returning user is signed in again';
const vietnamese = 'Sửa trang đăng nhập để người dùng cũ được đăng nhập lại';

describe('release note language warning', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  async function seed(contentLanguage: string) {
    const user = await createTestUser({ verified: true });
    const project = await createTestProject(user.id);
    await addProjectMember(project.id, user.id, 'admin');
    await seedProjectDocument(project.id, user.id, {
      environments: {},
      extra: { contentLanguage },
    });
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${project.id}, 900, 'note', 'open', ${user.id})
    `);
    return { id, token: await userToken(user.id) };
  }

  const write = (
    id: string,
    token: string,
    userFacing: string,
    section = 'Fixed',
    title: string | undefined = section === 'Skip' ? undefined : 'Sửa đăng nhập',
  ) =>
    api(token, 'PATCH', `/api/issues/${id}`, {
      releaseNotes: { section, ...(title ? { title } : {}), userFacing },
    });

  // REQ-40 BC-17: a note users read is written with its short title, or refused by name at the write
  it('refuses a note users read that has no short title, naming the field, and stores nothing', async () => {
    const { id, token } = await seed('vi');
    const res = await write(id, token, vietnamese, 'Fixed', '');
    expect(res.status).toBe(400);
    const said = JSON.stringify(res.body);
    expect(said).toContain('title is required for a Fixed note');
    // a master that meets it reads the field and the body to send, from the refusal alone
    expect(said).toContain('"path":"/releaseNotes/title"');
    expect(said).toContain('\\"title\\":\\"<at most 10 words>\\"');
    const [row] = [
      ...(await db.execute(sql`SELECT release_notes FROM issues WHERE id = ${id}`)),
    ] as { release_notes: unknown }[];
    expect(row?.release_notes).toBeNull();
  });

  it('warns on a title in the wrong language as it does on the sentence', async () => {
    const { id, token } = await seed('vi');
    const res = await write(
      id,
      token,
      vietnamese,
      'Fixed',
      'Returning users are signed in again now',
    );
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([expect.stringContaining('releaseNotes.title')]);
  });

  it('warns on an English note for a vi project, and still stores it', async () => {
    const { id, token } = await seed('vi');
    const res = await write(id, token, english);
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([
      expect.stringContaining('releaseNotes.userFacing: it is 12 words with no Vietnamese letter'),
    ]);
    expect((res.body.releaseNotes as { userFacing: string }).userFacing).toBe(english);
  });

  it('is silent on a Vietnamese note, on a Skip, and on the same English note for an en project', async () => {
    const vi = await seed('vi');
    expect((await write(vi.id, vi.token, vietnamese)).body.warnings).toBeUndefined();
    expect((await write(vi.id, vi.token, '-', 'Skip')).body.warnings).toBeUndefined();
    await truncateAll();
    const en = await seed('en');
    expect(
      (await write(en.id, en.token, english, 'Fixed', 'Login fixed')).body.warnings,
    ).toBeUndefined();
  });

  // ISS-1099, FB-562: a Vietnamese note on an English project was answered warnings: null
  it('warns on a Vietnamese note for an en project, naming the field and English, and still stores it', async () => {
    const { id, token } = await seed('en');
    const res = await write(id, token, vietnamese, 'Fixed', 'Login fixed');
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([
      expect.stringMatching(/^releaseNotes\.userFacing: .*Rewrite it in English\.$/),
    ]);
    expect((res.body.releaseNotes as { userFacing: string }).userFacing).toBe(vietnamese);
  });

  it('warns on a short Vietnamese title for an en project, and on an English admin step for a vi project', async () => {
    const en = await seed('en');
    const titled = await write(en.id, en.token, english, 'Fixed', 'Sửa trang đăng nhập');
    expect(titled.body.warnings).toEqual([expect.stringContaining('releaseNotes.title: ')]);
    await truncateAll();
    const vi = await seed('vi');
    const res = await api(vi.token, 'PATCH', `/api/issues/${vi.id}`, {
      releaseNotes: {
        section: 'Changed',
        title: 'Sửa đăng nhập',
        userFacing: vietnamese,
        adminSteps: ['Run the export once on staging before the release goes out'],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([
      expect.stringMatching(/^releaseNotes\.adminSteps\[0\]: .*Rewrite it in Vietnamese\.$/),
    ]);
  });

  it('is silent on a title that is only a version, which no letter decides', async () => {
    const vi = await seed('vi');
    expect((await write(vi.id, vi.token, vietnamese, 'Fixed', 'v1.31.1')).body.warnings).toBeUndefined();
    await truncateAll();
    const en = await seed('en');
    expect((await write(en.id, en.token, english, 'Fixed', 'v1.31.1')).body.warnings).toBeUndefined();
  });

  // the REST create body has no `releaseNotes` key (strict); the door that takes a note at birth is
  // `createIssue`, which every create route calls
  it('answers the same warning on the create that files a note, in both directions', async () => {
    const born = async (contentLanguage: string, note: unknown) => {
      await truncateAll();
      const { id } = await seed(contentLanguage);
      const [row] = [
        ...(await db.execute(sql`SELECT project_id, created_by_id FROM issues WHERE id = ${id}`)),
      ] as { project_id: string; created_by_id: string }[];
      const by = row?.created_by_id ?? '';
      const made = await createIssue(
        { projectId: row?.project_id ?? '', title: 'noted at birth', releaseNotes: note },
        {
          createdById: by,
          createdByDeviceId: null,
          createdVia: 'web',
          actor: { type: 'user', id: by, agency: 'agent' },
        },
      );
      if (made.deduped) throw new Error('a birth with no detector key is never deduped');
      return made.noteWarnings;
    };
    expect(
      await born('en', { section: 'Fixed', title: 'Login fixed', userFacing: vietnamese }),
    ).toEqual([expect.stringMatching(/^releaseNotes\.userFacing: .*Rewrite it in English\.$/)]);
    expect(
      await born('vi', { section: 'Fixed', title: 'Sửa đăng nhập', userFacing: english }),
    ).toEqual([expect.stringMatching(/^releaseNotes\.userFacing: .*Rewrite it in Vietnamese\.$/)]);
    expect(
      await born('vi', { section: 'Fixed', title: 'Sửa đăng nhập', userFacing: vietnamese }),
    ).toEqual([]);
    expect(await born('en', null)).toEqual([]);
  });

  it("warns on each engineer's reference in a note, for any language, and still stores it", async () => {
    const { id, token } = await seed('en');
    const note =
      'Fixed in 9db12a21a (ISS-12), enforcing SOD-RULE-MAKER-CHECKER, with Technical note: index added.';
    const res = await write(id, token, note, 'Fixed', 'Login fixed');
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([
      expect.stringContaining(
        'carries commit sha 9db12a21a, issue key ISS-12, code SOD-RULE-MAKER-CHECKER, label "Technical note"',
      ),
    ]);
    expect((res.body.releaseNotes as { userFacing: string }).userFacing).toBe(note);
  });
});
