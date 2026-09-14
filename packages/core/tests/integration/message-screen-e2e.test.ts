/**
 * ISS-997 — the message screen against real Postgres.
 *
 * The unit tests mock the issue lookup, so they prove the rule and not the
 * wiring. What only a database can answer: that a refused comment leaves no
 * row, that a person's comment is not screened at all, that an edit is judged
 * by the STORED authorship rather than the editor's, and that a body which
 * passes reaches storage byte for byte.
 *
 * Criteria proved here: 39 (a person is not screened), 40 (a refused comment
 * leaves no row), 41 (an edit meets the same cell), 42 (the screen substitutes
 * no text), 58 (an adopted copy of the shape document wins over the built-in).
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_ISSUE_PREFIX } from '../../src/lib/issue-ref.js';
import { MessageRefusedError } from '../../src/messaging/contract.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let insertComment: typeof import('../../src/comments/service.js').insertComment;
let updateCommentBody: typeof import('../../src/comments/service.js').updateCommentBody;
let resolveManagedMetaPrompts: typeof import('../../src/skills/effective.js').resolveManagedMetaPrompts;

beforeAll(async () => {
  harness = await setupTestDatabase();
  // cm:guard the modules under test are imported AFTER this assignment, never at the top of the file: `src/db/client.js` reads `DATABASE_URL` once at module load, so a static import binds the pool to the base database and every query lands in a schema the migrations never touched.
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  const service = await import('../../src/comments/service.js');
  insertComment = service.insertComment;
  updateCommentBody = service.updateCommentBody;
  ({ resolveManagedMetaPrompts } = await import('../../src/skills/effective.js'));
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

describe('the message screen, against a real database', () => {
  // cm:guard the prefix is READ BACK rather than set: `issue_prefix_aliases_immutable_trg` refuses a prefix change outright, so a fixture that wrote one would fail on the trigger and read as a screen fault.
  async function seed() {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    await createTestProjectMember(harness.db, {
      userId: owner.id,
      projectId: project.id,
      role: 'admin',
    });
    const rows = await harness.db.execute<{ issue_prefix: string | null }>(sql`
      SELECT issue_prefix FROM projects WHERE id = ${project.id}
    `);
    // cm:guard `?? LEGACY_ISSUE_PREFIX` is the fixture agreeing with `formatIssueRef`, not a convenience: a fresh project stores NULL and still renders `ISS-n`, so a fixture reading the column literally would build a key nobody writes and watch the screen abstain — which is how this lane found the screen doing exactly that.
    const prefix = (rows[0] as { issue_prefix: string | null }).issue_prefix ?? LEGACY_ISSUE_PREFIX;
    return { owner, project, prefix };
  }

  let nextSeq = 100;

  async function issue(projectId: string, ownerId: string, status: string) {
    const seq = nextSeq++;
    const rows = await harness.db.execute<{ id: string; iss_seq: number }>(sql`
      INSERT INTO issues (project_id, title, created_by_id, status, iss_seq)
      VALUES (${projectId}, 'target', ${ownerId}, ${status}, ${seq})
      RETURNING id, iss_seq
    `);
    const row = rows[0] as { id: string; iss_seq: number };
    return { id: row.id, seq: row.iss_seq };
  }

  async function commentCount(issueId: string) {
    const rows = await harness.db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM comments WHERE issue_id = ${issueId}
    `);
    return Number((rows[0] as { n: string }).n);
  }

  it('leaves no row when it refuses an agent claiming a merge the tracker does not hold', async () => {
    const { owner, project, prefix } = await seed();
    const target = await issue(project.id, owner.id, 'in_progress');
    await expect(
      insertComment({
        issueId: target.id,
        authorId: owner.id,
        authorDeviceId: null,
        authorAgency: 'agent',
        body: `${prefix}-${target.seq} is merged.`,
        parentId: null,
      }),
    ).rejects.toBeInstanceOf(MessageRefusedError);
    expect(await commentCount(target.id)).toBe(0);
  });

  it('writes the same claim once the row actually says so', async () => {
    const { owner, project, prefix } = await seed();
    const target = await issue(project.id, owner.id, 'in_progress');
    await harness.db.execute(sql`
      UPDATE issues SET merged_at = now() WHERE id = ${target.id}
    `);
    await insertComment({
      issueId: target.id,
      authorId: owner.id,
      authorDeviceId: null,
      authorAgency: 'agent',
      body: `${prefix}-${target.seq} is merged.`,
      parentId: null,
    });
    expect(await commentCount(target.id)).toBe(1);
  });

  it('does not screen a person at all — the same body a person writes is stored', async () => {
    const { owner, project, prefix } = await seed();
    const target = await issue(project.id, owner.id, 'in_progress');
    const written = await insertComment({
      issueId: target.id,
      authorId: owner.id,
      authorDeviceId: null,
      authorAgency: 'human',
      body: `${prefix}-${target.seq} is merged, and @all should know.`,
      parentId: null,
    });
    expect(written.row.id).toBeTruthy();
    expect(await commentCount(target.id)).toBe(1);
  });

  // cm:guard the edit is judged on the STORED `author_agency`, never on who is editing: an agent's comment edited into a false claim is the same false claim, and reading the editor would let one route around the screen the create path applied.
  it('screens an edit of an agent comment, and leaves the stored body untouched when it refuses', async () => {
    const { owner, project, prefix } = await seed();
    const target = await issue(project.id, owner.id, 'in_progress');
    const written = await insertComment({
      issueId: target.id,
      authorId: owner.id,
      authorDeviceId: null,
      authorAgency: 'agent',
      body: 'still working on it',
      parentId: null,
    });
    await expect(
      updateCommentBody(written.row.id, { body: `${prefix}-${target.seq} is closed.` }),
    ).rejects.toBeInstanceOf(MessageRefusedError);
    const rows = await harness.db.execute<{ body: string }>(sql`
      SELECT body FROM comments WHERE id = ${written.row.id}
    `);
    expect((rows[0] as { body: string }).body).toBe('still working on it');
  });

  it("does not screen an edit of a person's comment", async () => {
    const { owner, project, prefix } = await seed();
    const target = await issue(project.id, owner.id, 'in_progress');
    const written = await insertComment({
      issueId: target.id,
      authorId: owner.id,
      authorDeviceId: null,
      authorAgency: 'human',
      body: 'first thought',
      parentId: null,
    });
    await expect(
      updateCommentBody(written.row.id, { body: `${prefix}-${target.seq} is closed.` }),
    ).resolves.toBeTruthy();
  });

  // cm:guard this compares against `prepareBody`'s OWN output, not against the raw string, and that is the point: markup sanitising is `prepareBody`'s job and it may legitimately change bytes. What must be true is that the screen added nothing to that — it refuses or it passes, and there is no third outcome where it hands back edited text.
  it('substitutes nothing — a markdown body that passes reaches prepareBody as the agent sent it', async () => {
    const { prepareBody } = await import('../../src/body/prepare.js');
    const { owner, project } = await seed();
    const target = await issue(project.id, owner.id, 'in_progress');
    const body = [
      '## what I did',
      '',
      'Read `packages/core/src/messaging/cells.ts` and split the table.',
      '',
      '- one',
      '- two',
      '',
      '> a quote saying ZZQ-1 is merged, which is not my claim',
    ].join('\n');
    const written = await insertComment({
      issueId: target.id,
      authorId: owner.id,
      authorDeviceId: null,
      authorAgency: 'agent',
      body,
      parentId: null,
    });
    expect(written.row.body).toBe(prepareBody({ raw: body }).body);
  });

  // cm:guard a reference belonging to ANOTHER project must not be judged here: CLAUDE.md's carve-out requires an agent that finds a defect in `forge-plugin` to name that project's key in its comment, and a screen that refused the mandated behaviour would be worse than none.
  it('abstains on a key this project does not hold', async () => {
    const { owner, project, prefix } = await seed();
    const target = await issue(project.id, owner.id, 'in_progress');
    await expect(
      insertComment({
        issueId: target.id,
        authorId: owner.id,
        authorDeviceId: null,
        authorAgency: 'agent',
        body: `Reported as ZZQ-1386 on forge-plugin, which is closed now. This project's own ${prefix}-${target.seq} is untouched.`,
        parentId: null,
      }),
    ).resolves.toBeTruthy();
  });
});

describe('the shape document over the prompt channel', () => {
  // cm:guard the built-in copy is put there by the REAL seeder reading the real `skills/` folder, not by a hand-written INSERT: the thing under test is that the shipped document reaches the prompt channel, and a fixture body would have proven only that the resolver returns rows.
  async function seedTheShippedDocument() {
    const { seedBuiltinSkills } = await import('../../src/skills/builtin-seed.js');
    await seedBuiltinSkills(harness.db as never);
  }

  it('serves the built-in copy to a project that has not adopted it', async () => {
    await seedTheShippedDocument();
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const prompts = await resolveManagedMetaPrompts(project.id);
    const shape = prompts.find((p) => p.name === 'forge-message-shape');
    expect(shape?.body).toContain('The shape of a message to a person');
    expect(shape?.body).toContain('`comment-write`');
  });

  // cm:guard the adopted copy WINS, and that is the whole reason this document is served over the prompt channel rather than synced to disk: a project that has tightened its own rules must not be handed the built-in text describing rules it does not run.
  it('serves a project its own copy once it adopts the document', async () => {
    await seedTheShippedDocument();
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    await harness.db.execute(sql`
    INSERT INTO skills (name, scope, project_id, description, skill_md, prompt, source, content_hash)
    VALUES ('forge-message-shape', 'project', ${project.id}, 'ours', 'our own shape document', 'our own shape document', 'user', 'adopted-copy-hash')
  `);
    const prompts = await resolveManagedMetaPrompts(project.id);
    const shape = prompts.filter((p) => p.name === 'forge-message-shape');
    expect(shape).toHaveLength(1);
    expect(shape[0]?.body).toContain('our own shape document');
    expect(shape[0]?.body).not.toContain('The shape of a message to a person');
  });
});
