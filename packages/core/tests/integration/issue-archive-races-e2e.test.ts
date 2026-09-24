/**
 * ISS-1237 — the races an archive can lose, planted rather than hoped for.
 *
 * The edge race: an edge write passes its archived-issue check, and an archive of that issue
 * commits before the edge does. The write is held between the check and the insert by gating the
 * cycle check, which runs in exactly that gap, so the archive is given every chance to slip in.
 *
 * The retry: an archive attempt runs to its end and is then aborted as a deadlock, and a row it
 * refused changes before the retry. The retry must answer what the second attempt read, once.
 *
 * Beside them, the one recall path an archive reaches indirectly: a fact extracted from an issue is
 * a `knowledge` memory tagged with that issue's id, and it leaves recall with the issue.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { connectClientAsPat, parseToolResult } from '../helpers/mcp-harness.js';

const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null, entered: () => {} }));

vi.mock('../../src/issues/cycle-detect.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/issues/cycle-detect.js')>();
  return {
    ...real,
    detectCycle: async (...args: Parameters<typeof real.detectCycle>) => {
      if (gate.hold) {
        gate.entered();
        await gate.hold;
      }
      return real.detectCycle(...args);
    },
  };
});

// `db` is a lazy proxy that answers bound methods, so a spy on it never takes; this wrapper is the
// one seam through which a test can stand in for `transaction`.
const txSeam = vi.hoisted(() => ({ override: null as ((...a: unknown[]) => unknown) | null }));

vi.mock('../../src/db/client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/db/client.js')>();
  const db = new Proxy(real.db, {
    get: (target, prop) =>
      prop === 'transaction' && txSeam.override ? txSeam.override : Reflect.get(target, prop),
  });
  return { ...real, db };
});

let harness: TestDatabase;
let projectId: string;
let userId: string;
let pat: string;
let archiveMod: typeof import('../../src/issues/archive.js');
let dbMod: typeof import('../../src/db/client.js');

async function seed(seq: number, status: string): Promise<string> {
  const id = randomUUID();
  const merged = status === 'closed' ? sql`now()` : sql`NULL`;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${userId}, ${merged})`);
  return id;
}

async function state(archivedId: string, otherId: string) {
  const [row] = (await harness.db.execute(sql`
    SELECT (SELECT archived_at IS NOT NULL FROM issues WHERE id = ${archivedId}) AS archived,
           (SELECT count(*)::int FROM issue_dependencies
             WHERE (from_issue_id = ${archivedId} AND to_issue_id = ${otherId})
                OR (from_issue_id = ${otherId} AND to_issue_id = ${archivedId})) AS edges`)) as unknown as {
    archived: boolean;
    edges: number;
  }[];
  return row;
}

const actor = () => ({ type: 'user' as const, id: userId, agency: 'human' as const });

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.EMBEDDINGS_BASE_URL ??= 'http://embeddings.invalid';
  process.env.EMBEDDINGS_API_KEY ??= 'test-key';
  archiveMod = await import('../../src/issues/archive.js');
  dbMod = await import('../../src/db/client.js');
}, 180_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const user = await createTestUser(harness.db);
  userId = user.id;
  projectId = (await createTestProject(harness.db, userId)).id;
  await createTestProjectMember(harness.db, { userId, projectId, role: 'admin' });
  const { mintPat } = await import('../../src/auth/pat.js');
  pat = (await mintPat({ userId, name: 'admin', scopes: ['read', 'write', 'admin'] })).plaintext;
});

describe('an edge written through forge_issues update beside an archive of its issue', () => {
  it('never leaves the archived issue on a live edge to open work', async () => {
    const closed = await seed(1, 'closed');
    const open = await seed(2, 'open');
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      gate.entered = resolve;
    });
    gate.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const ctx = await connectClientAsPat(pat);
    try {
      const edgeWrite = ctx.client.callTool({
        name: 'forge_issues',
        arguments: {
          action: 'update',
          projectId,
          documentId: open,
          data: { relations: [{ kind: 'blocks', dependsOnId: closed }] },
        },
      });
      await entered;
      const archiving = archiveMod
        .runIssueArchive({
          projectId,
          direction: 'archive',
          filter: { keys: ['ISS-1'] },
          dryRun: false,
          actor: actor(),
        })
        .then(
          () => 'archived',
          (err: Error) => err.message,
        );
      const settled = await Promise.race([
        archiving,
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 1_500)),
      ]);
      release();
      gate.hold = null;
      const edge = (await edgeWrite) as { isError?: boolean; content: { text: string }[] };
      const archiveOutcome = await archiving;

      expect(settled, 'the archive must wait on the edge write holding the row').toBe('waiting');
      expect(edge.isError ?? false).toBe(false);
      expect(parseToolResult(edge as never)).toBeTruthy();
      expect(archiveOutcome).toMatch(/ISS-1 is still load-bearing/);
      expect(await state(closed, open)).toEqual({ archived: false, edges: 1 });
    } finally {
      gate.hold = null;
      await ctx.close();
    }
  });

  it('refuses the edge by name once the issue is archived', async () => {
    const closed = await seed(1, 'closed');
    const open = await seed(2, 'open');
    await archiveMod.runIssueArchive({
      projectId,
      direction: 'archive',
      filter: { keys: ['ISS-1'] },
      dryRun: false,
      actor: actor(),
    });
    const ctx = await connectClientAsPat(pat);
    try {
      const res = (await ctx.client.callTool({
        name: 'forge_issues',
        arguments: {
          action: 'update',
          projectId,
          documentId: open,
          data: { relations: [{ kind: 'relates', dependsOnId: closed }] },
        },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain('ISS-1 is archived');
      expect(await state(closed, open)).toEqual({ archived: true, edges: 0 });
    } finally {
      await ctx.close();
    }
  });
});

describe('an expired edge naming an archived issue', () => {
  const edgeWrite = async (from: string, to: string, validUntil?: string) => {
    const { setIssueDependency } = await import('../../src/issues/dependency-service.js');
    const writer = { actor: actor(), createdById: userId };
    return setIssueDependency(
      { projectId, fromIssueId: from, toIssueId: to, kind: 'relates', validUntil },
      writer,
    ).then(
      () => 'written',
      (err: Error) => err.message,
    );
  };
  const past = () => new Date(Date.now() - 60_000).toISOString();

  it('is refused when it would be written new, and retires one that already existed', async () => {
    const [a, b, c] = [await seed(1, 'closed'), await seed(2, 'closed'), await seed(3, 'closed')];
    expect(await edgeWrite(a, b)).toBe('written');
    await archiveMod.runIssueArchive({
      projectId,
      direction: 'archive',
      filter: { keys: ['ISS-1', 'ISS-2', 'ISS-3'] },
      dryRun: false,
      actor: actor(),
    });
    expect(await edgeWrite(a, c, past())).toMatch(/is archived/);
    expect(await state(a, c)).toEqual({ archived: true, edges: 0 });
    expect(await edgeWrite(a, b, past())).toBe('written');
    const [row] = (await harness.db.execute(sql`
      SELECT valid_until < now() AS retired FROM issue_dependencies
       WHERE from_issue_id = ${a} AND to_issue_id = ${b}`)) as unknown as { retired: boolean }[];
    expect(row).toEqual({ retired: true });
  });
});

describe('an archive retried after a deadlock', () => {
  it('reports each refusal once, and drops one whose row settled between attempts', async () => {
    await seed(1, 'closed');
    const moving = await seed(2, 'in_progress');
    await seed(3, 'open');
    const real = dbMod.db.transaction.bind(dbMod.db);
    let attempt = 0;
    txSeam.override = async (cb: unknown) => {
      attempt += 1;
      const answer = await real(cb as Parameters<typeof real>[0]);
      if (attempt > 1) return answer;
      await harness.db.execute(
        sql`UPDATE issues SET status = 'closed', merged_at = now() WHERE id = ${moving}`,
      );
      throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
    };
    try {
      const report = await archiveMod.runIssueArchive({
        projectId,
        direction: 'archive',
        filter: { keys: ['ISS-1', 'ISS-2', 'ISS-3'] },
        dryRun: true,
        actor: actor(),
      });
      expect(attempt).toBe(2);
      expect(report.refusals.map((r) => r.message)).toEqual([
        expect.stringContaining('ISS-3 is `open`'),
      ]);
      expect(report.matched).toEqual(['ISS-1', 'ISS-2', 'ISS-3']);
    } finally {
      txSeam.override = null;
    }
  });
});

describe('a fact extracted from an issue', () => {
  it('leaves memory recall when its issue is archived, and a fact from no issue stays', async () => {
    const closed = await seed(1, 'closed');
    for (const [ref, meta] of [
      ['extracted:a', { origin: 'extraction', issueId: closed }],
      ['extracted:b', { origin: 'extraction' }],
    ] as const) {
      await harness.db.execute(sql`
        INSERT INTO memories (project_id, source, source_ref, text_content, metadata)
        VALUES (${projectId}, 'knowledge', ${ref}, 'the clarify handoff writes the plan',
                ${JSON.stringify(meta)}::jsonb)`);
    }
    const search = await import('../../src/memory/search.js');
    const recall = async () =>
      (await search.keywordSearchMemories({ projectId, topK: 10, query: 'clarify handoff' }))
        .map((h) => h.sourceRef)
        .sort();
    expect(await recall()).toEqual(['extracted:a', 'extracted:b']);
    await archiveMod.runIssueArchive({
      projectId,
      direction: 'archive',
      filter: { keys: ['ISS-1'] },
      dryRun: false,
      actor: actor(),
    });
    expect(await recall()).toEqual(['extracted:b']);
  });
});
