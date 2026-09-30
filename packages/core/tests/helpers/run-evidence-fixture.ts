/**
 * The run, issues and comment bodies the run-evidence suites share: a real run
 * session over real issues, so what a writer posts is read back from Postgres.
 */

import { sql } from 'drizzle-orm';
import type { openRunSession as OpenRunSession } from '../../src/devices/run-session.js';
import type { TestDb } from './db.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
} from './factories.js';

async function anIssue(
  db: TestDb,
  args: { projectId: string; createdById: string; issSeq: number; next?: string | null },
): Promise<string> {
  const lease =
    args.next === undefined ? null : JSON.stringify({ lease: { next: args.next, clock: 1 } });
  const rows = (await db.execute(sql`
    INSERT INTO issues (project_id, created_by_id, iss_seq, title, status, session_context)
    VALUES (${args.projectId}, ${args.createdById}, ${args.issSeq}, ${`issue ${args.issSeq}`},
            'in_progress', ${lease}::jsonb)
    RETURNING id
  `)) as unknown as { id: string }[];
  const id = rows[0]?.id;
  if (!id) throw new Error('anIssue: insert returned no row');
  return id;
}

/** Every comment body on an issue, oldest first. */
export async function bodiesOn(db: TestDb, issueId: string): Promise<string[]> {
  const rows = (await db.execute(
    sql`SELECT body FROM comments WHERE issue_id = ${issueId} ORDER BY created_at`,
  )) as unknown as { body: string }[];
  return rows.map((r) => r.body);
}

/** One box's run session over issues `ISS-<seq>` of a fresh project. */
export async function aRunOver(
  db: TestDb,
  open: typeof OpenRunSession,
  issSeqs: number[],
  next?: string | null,
) {
  const user = await createTestUser(db);
  const project = await createTestProject(db, user.id);
  const device = await createTestDevice(db, user.id);
  await bindTestRunner(db, { projectId: project.id, deviceId: device.id });
  const issueIds: string[] = [];
  for (const seq of issSeqs) {
    issueIds.push(
      await anIssue(db, {
        projectId: project.id,
        createdById: user.id,
        issSeq: seq,
        ...(next === undefined ? {} : { next }),
      }),
    );
  }
  const session = await open({
    deviceId: device.id,
    projectId: project.id,
    issueKeys: issSeqs.map((s) => `ISS-${s}`),
    name: 'run-a',
  });
  return { user, project, device, issueIds, session };
}
