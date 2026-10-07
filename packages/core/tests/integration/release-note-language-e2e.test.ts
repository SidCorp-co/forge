/**
 * A release note's script is read against the project's content language on the PATCH that writes it:
 * an English note for a vi project is stored and answered with a warning naming what was detected;
 * a Vietnamese one, and the same English note on an en project, carry none.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
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
      VALUES (${id}, ${project.id}, 1, 'note', 'open', ${user.id})
    `);
    return { id, token: await userToken(user.id) };
  }

  const write = (id: string, token: string, userFacing: string, section = 'Fixed') =>
    api(token, 'PATCH', `/api/issues/${id}`, { releaseNotes: { section, userFacing } });

  it('warns on an English note for a vi project, and still stores it', async () => {
    const { id, token } = await seed('vi');
    const res = await write(id, token, english);
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([
      expect.stringContaining('releaseNotes.userFacing is 12 words with no Vietnamese letter'),
    ]);
    expect((res.body.releaseNotes as { userFacing: string }).userFacing).toBe(english);
  });

  it('is silent on a Vietnamese note, on a Skip, and on the same English note for an en project', async () => {
    const vi = await seed('vi');
    expect((await write(vi.id, vi.token, vietnamese)).body.warnings).toBeUndefined();
    expect((await write(vi.id, vi.token, '-', 'Skip')).body.warnings).toBeUndefined();
    await truncateAll();
    const en = await seed('en');
    expect((await write(en.id, en.token, english)).body.warnings).toBeUndefined();
  });

  it("warns on each engineer's reference in a note, for any language, and still stores it", async () => {
    const { id, token } = await seed('en');
    const note =
      'Fixed in 9db12a21a (ISS-12), enforcing SOD-RULE-MAKER-CHECKER. Technical note: index added.';
    const res = await write(id, token, note);
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([
      expect.stringContaining(
        'carries commit sha 9db12a21a, issue key ISS-12, code SOD-RULE-MAKER-CHECKER, label "Technical note"',
      ),
    ]);
    expect((res.body.releaseNotes as { userFacing: string }).userFacing).toBe(note);
  });
});
