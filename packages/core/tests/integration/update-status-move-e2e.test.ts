/**
 * ISS-1229 r10 — a `forge_issues` update that moves a status writes its fields, labels and
 * relations inside the move's own transaction, so a refused move, an unchanged status included,
 * leaves none of them written. Each case reads the row back from the database.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { connectClientAsPat } from '../helpers/mcp-harness.js';

let harness: TestDatabase;
let mintPat: typeof import('../../src/auth/pat.js')['mintPat'];

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.NODE_ENV ??= 'test';
  mintPat = (await import('../../src/auth/pat.js')).mintPat;
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

type World = { userId: string; projectId: string; token: string };

async function insertIssue(w: World, status: string): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id, status)
    VALUES (${w.projectId}::uuid, 'the subject', ${w.userId}::uuid, ${status})
    RETURNING id
  `);
  return (rows[0] as { id: string }).id;
}

async function mcp(token: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ctx = await connectClientAsPat(token, null);
  try {
    const res = (await ctx.client.callTool({ name: 'forge_issues', arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    const text = res.content[0]?.text ?? '';
    if (res.isError) throw new Error(`forge_issues refused: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    await ctx.close();
  }
}

/** An agent's credential on a project with no release step, so a close is judged as itself. */
async function plainWorld(): Promise<World> {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  await harness.db.execute(
    sql`UPDATE users SET email_verified_at = now(), kind = 'agent' WHERE id = ${user.id}::uuid`,
  );
  const { plaintext } = await mintPat({
    userId: user.id,
    name: 'an agent on a project with no release step',
    boundProjectId: project.id,
  });
  return { userId: user.id, projectId: project.id, token: plaintext };
}

async function refusal(token: string, args: Record<string, unknown>): Promise<string> {
  const err = await mcp(token, args).then(
    () => null,
    (e: Error) => e.message,
  );
  if (err === null) throw new Error('forge_issues answered where a refusal was owed');
  return err;
}

async function whole(id: string) {
  const rows = await harness.db.execute(sql`
    SELECT title, plan, release_notes, status, updated_at::text AS updated_at,
           (SELECT count(*)::int FROM issue_dependencies d
             WHERE d.from_issue_id = ${id}::uuid OR d.to_issue_id = ${id}::uuid) AS edges
      FROM issues WHERE id = ${id}::uuid
  `);
  return rows[0];
}

describe('forge_issues update — a status move and the writes beside it are one', () => {
  async function row(id: string) {
    const rows = await harness.db.execute<{ title: string; status: string; updated_at: string }>(
      sql`SELECT title, status, updated_at::text FROM issues WHERE id = ${id}::uuid`,
    );
    return rows[0] as { title: string; status: string; updated_at: string };
  }

  it('refuses the status alone NO_OP, naming it as the transition door does', async () => {
    const w = await plainWorld();
    const id = await insertIssue(w, 'confirmed');

    const said = await refusal(w.token, {
      action: 'update',
      documentId: id,
      data: { status: 'confirmed' },
    });

    expect(said).toContain('NO_OP: The issue is already at Confirmed.');
    expect(said).not.toContain('Nothing else');
    expect((await row(id)).status).toBe('confirmed');
  });

  it('writes none of the fields beside it, and says to send them without the status', async () => {
    const w = await plainWorld();
    const id = await insertIssue(w, 'confirmed');
    const before = await row(id);

    const said = await refusal(w.token, {
      action: 'update',
      documentId: id,
      data: { status: 'confirmed', title: 'a new title', plan: 'a plan' },
    });

    expect(said).toMatch(
      /^forge_issues refused: Error: NO_OP: The status move was refused, so nothing else this update carried was written: send it again without `data\.status` to write the rest\. /,
    );
    expect(said).toContain('The issue is already at Confirmed.');
    expect(await row(id)).toEqual(before);
  });

  it('writes no relation it carried', async () => {
    const w = await plainWorld();
    const id = await insertIssue(w, 'confirmed');
    const blocker = await insertIssue(w, 'open');

    await refusal(w.token, {
      action: 'update',
      documentId: id,
      data: { status: 'confirmed', relations: [{ kind: 'blocks', dependsOnId: blocker }] },
    });

    const edges = await harness.db.execute(
      sql`SELECT 1 FROM issue_dependencies WHERE from_issue_id = ${id}::uuid OR to_issue_id = ${id}::uuid`,
    );
    expect(edges.length).toBe(0);
  });

  const NOTES = { section: 'Fixed', userFacing: 'A thing works.' };

  it.each([
    ['an illegal move out of Draft', 'draft', 'confirmed', 'ILLEGAL_TRANSITION'],
    ['a move to Developed with no work behind it', 'in_progress', 'developed', 'NO_WORK_EVIDENCE'],
    ['a close with nothing shipped', 'testing', 'closed', 'CLOSE_REQUIRES_SHIPPED'],
  ])(
    'a refused status move (%s) writes none of the fields, notes or relations beside it',
    async (_what, from, to, code) => {
      const w = await plainWorld();
      const id = await insertIssue(w, from);
      const other = await insertIssue(w, 'open');
      const before = await whole(id);

      const said = await refusal(w.token, {
        action: 'update',
        documentId: id,
        data: {
          status: to,
          title: 'a new title',
          plan: 'a plan',
          releaseNotes: NOTES,
          relations: [{ kind: 'blocks', dependsOnId: other }],
        },
      });

      expect(said).toMatch(
        new RegExp(
          `^forge_issues refused: Error: ${code}: The status move was refused, so nothing else this update carried was written: send it again without \`data\\.status\` to write the rest\\. `,
        ),
      );
      expect(await whole(id)).toEqual(before);
    },
  );

  it('closes on release notes written by the same update', async () => {
    const w = await plainWorld();
    const id = await insertIssue(w, 'testing');
    await harness.db.execute(
      sql`UPDATE issues SET merged_at = now(), merged_commit_sha = ${'a'.repeat(40)} WHERE id = ${id}::uuid`,
    );

    const body = await mcp(w.token, {
      action: 'update',
      documentId: id,
      data: { status: 'closed', releaseNotes: NOTES },
    });

    expect(body.status).toBe('closed');
    expect((await whole(id))?.release_notes).toEqual(NOTES);
  });

  it('writes the fields of an update whose move is made', async () => {
    const w = await plainWorld();
    const id = await insertIssue(w, 'open');

    const body = await mcp(w.token, {
      action: 'update',
      documentId: id,
      data: { status: 'confirmed', title: 'a new title' },
    });

    expect(body.status).toBe('confirmed');
    expect((await whole(id))?.title).toBe('a new title');
  });

  it('still writes the fields of an update that sends no status', async () => {
    const w = await plainWorld();
    const id = await insertIssue(w, 'confirmed');

    const body = await mcp(w.token, {
      action: 'update',
      documentId: id,
      data: { title: 'a new title' },
    });

    expect(body.action).toBe('updated');
    expect((await row(id)).title).toBe('a new title');
  });
});

describe('forge_issues update — a refusal writes nothing and says so first', () => {
  it.each([
    [
      'a relation naming the issue itself',
      'SELF_DEP',
      (_id: string, self: string) => ({ relations: [{ kind: 'blocks', dependsOnId: self }] }),
    ],
    [
      'a relation naming no issue',
      'RELATION_TARGET_NOT_FOUND',
      () => ({
        relations: [{ kind: 'blocks', dependsOnId: '00000000-0000-4000-8000-000000000000' }],
      }),
    ],
    [
      'a label the project does not have',
      'or more labels do not exist in this project',
      () => ({ labels: ['no-such-label'] }),
    ],
  ] as const)(
    'an update with no status refused for %s writes none of the fields beside it, and says so first',
    async (_what, names, extra) => {
      const w = await plainWorld();
      const id = await insertIssue(w, 'confirmed');
      const before = await whole(id);

      const said = await refusal(w.token, {
        action: 'update',
        documentId: id,
        data: { title: 'a new title', plan: 'a plan', ...extra(id, id) },
      });

      expect(await whole(id)).toEqual(before);
      expect(said).toMatch(
        /^forge_issues refused: Error: (?:[A-Z_]+: )*Nothing this update carried was written\. /,
      );
      expect(said).toContain(names);
    },
  );

  it('a status move refused for a relation naming the issue itself moves nothing and says so first', async () => {
    const w = await plainWorld();
    const id = await insertIssue(w, 'open');
    const before = await whole(id);

    const said = await refusal(w.token, {
      action: 'update',
      documentId: id,
      data: {
        status: 'confirmed',
        title: 'a new title',
        relations: [{ kind: 'blocks', dependsOnId: id }],
      },
    });

    expect(said).toMatch(
      /^forge_issues refused: Error: SELF_DEP: Nothing this update carried was written, the status move included\. /,
    );
    expect(await whole(id)).toEqual(before);
  });

  it('a blocks relation that would close a loop writes none of the fields beside it', async () => {
    const w = await plainWorld();
    const id = await insertIssue(w, 'confirmed');
    const other = await insertIssue(w, 'open');
    await mcp(w.token, {
      action: 'update',
      documentId: other,
      data: { relations: [{ kind: 'blocks', dependsOnId: id }] },
    });
    const before = await whole(id);

    const said = await refusal(w.token, {
      action: 'update',
      documentId: id,
      data: { title: 'a new title', relations: [{ kind: 'blocks', dependsOnId: other }] },
    });

    expect(await whole(id)).toEqual(before);
    expect(said).toMatch(
      /^forge_issues refused: Error: CYCLE_DETECTED: Nothing this update carried was written\. /,
    );
  });
});

describe('forge_issues update — every refusal before the write says first that nothing was written (ISS-1229 r12)', () => {
  const NO_ISSUE = '00000000-0000-4000-8000-000000000000';

  it.each([
    ['with no status', {}, ''],
    ['beside a status', { status: 'in_progress' }, ', the status move included'],
  ] as const)(
    'a value the input check refuses, sent %s, writes nothing and says so first',
    async (_how, status, moved) => {
      const w = await plainWorld();
      const id = await insertIssue(w, 'confirmed');
      const before = await whole(id);

      const said = await refusal(w.token, {
        action: 'update',
        documentId: id,
        data: { title: 'must not land', priority: 'urgent-ish', ...status },
      });

      expect(said).toMatch(
        new RegExp(
          `^forge_issues refused: Error: Nothing this update carried was written${moved}\\. The field \`data\\.priority\` takes one of the values listed below\\.\n\`data\\.priority\` takes: "critical"`,
        ),
      );
      expect(await whole(id)).toEqual(before);
    },
  );

  it('an update naming no issue says nothing it carried was written', async () => {
    const w = await plainWorld();

    const said = await refusal(w.token, {
      action: 'update',
      documentId: NO_ISSUE,
      data: { title: 'must not land' },
    });

    expect(said).toMatch(
      /^forge_issues refused: Error: Nothing this update carried was written\. /,
    );
  });

  it('a relation naming no issue is refused RELATION_TARGET_NOT_FOUND, naming its field', async () => {
    const w = await plainWorld();
    const id = await insertIssue(w, 'confirmed');
    const other = await insertIssue(w, 'open');
    const before = await whole(id);

    const said = await refusal(w.token, {
      action: 'update',
      documentId: id,
      data: {
        title: 'must not land',
        relations: [
          { kind: 'blocks', dependsOnId: other },
          { kind: 'blocks', blocksId: NO_ISSUE },
        ],
      },
    });

    expect(said).toMatch(
      /^forge_issues refused: Error: RELATION_TARGET_NOT_FOUND: Nothing this update carried was written\. /,
    );
    expect(said).toContain(`\`relations[1].blocksId\` names ${NO_ISSUE}`);
    expect(await whole(id)).toEqual(before);
  });

  // ISS-1229 r13, judge-30 on criterion 41: `data: {}` answered `updated` and wrote nothing, where
  // the REST door refuses the same empty update by name.
  it.each([
    ['an empty data object', {}],
    ['a reason with no status to carry it', { reason: 'nothing to move' }],
    ['an empty relation list', { relations: [] }],
  ] as const)(
    'an update carrying %s is refused as having no fields to update',
    async (_how, data) => {
      const w = await plainWorld();
      const id = await insertIssue(w, 'confirmed');
      const before = await whole(id);

      const said = await refusal(w.token, { action: 'update', documentId: id, data });

      expect(said).toMatch(
        /^forge_issues refused: Error: (?:BAD_REQUEST: )?Nothing this update carried was written\. No fields to update: /,
      );
      expect(said).not.toContain('expect');
      expect(await whole(id)).toEqual(before);
    },
  );

  it('a create the input check refuses keeps its own words: it is no update', async () => {
    const w = await plainWorld();

    const said = await refusal(w.token, {
      action: 'create',
      projectId: w.projectId,
      data: { title: 'never made', priority: 'urgent-ish' },
    });

    expect(said).toMatch(
      /^forge_issues refused: Error: The field `data\.priority` takes one of the values listed below\./,
    );
    expect(said).not.toContain('Nothing this update carried was written');
  });
});
