/**
 * ISS-1229 r11 — judge-25 saw an archived project raise no idle notice, and could not count it,
 * because its control (an Open issue on a live project) raised none in 22 minutes either. Each
 * stuck-issue sweep is run here the way production runs it — real notifications, real admins, the
 * issue moved through the transition door — on two projects side by side: the live one is told,
 * the archived one is not. Time is travelled through the sweep's own `now` and the pending
 * window's `pending_since`, never waited.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { connectClientAsPat } from '../helpers/mcp-harness.js';

let harness: TestDatabase;
let mintPat: typeof import('../../src/auth/pat.js')['mintPat'];
type Sweep = (now: Date) => Promise<unknown>;
const sweeps = {} as Record<'idle' | 'waiting-park' | 'owed-close', Sweep>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.NODE_ENV ??= 'test';
  mintPat = (await import('../../src/auth/pat.js')).mintPat;
  const idle = await import('../../src/pipeline/idle-issues.js');
  const stranded = await import('../../src/pipeline/stranded-issues.js');
  sweeps.idle = (now) => idle.reconcileIdleIssues(now);
  sweeps['waiting-park'] = (now) => stranded.detectStrandedIssues(now);
  sweeps['owed-close'] = (now) => stranded.detectOwedCloses(now);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
  resetSweepCursorsForTest();
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type World = { ownerId: string; token: string; live: string; archived: string };

/** One org owner, who is every project's admin, and two of its projects. */
async function world(): Promise<World> {
  const owner = await createTestUser(harness.db);
  await harness.db.execute(
    sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}::uuid`,
  );
  const org = await seedOrg(harness.db, owner.id);
  const live = await createTestProject(harness.db, owner.id, { orgId: org.id });
  const archived = await createTestProject(harness.db, owner.id, { orgId: org.id });
  const { plaintext } = await mintPat({ userId: owner.id, name: 'the org owner' });
  return { ownerId: owner.id, token: plaintext, live: live.id, archived: archived.id };
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

/** A Draft issue moved to Open through the doors the judge used, as the org owner. */
async function openedIssue(w: World, projectId: string): Promise<string> {
  const made = await mcp(w.token, {
    action: 'create',
    projectId,
    data: { title: 'nothing works this', status: 'draft' },
  });
  const id = made.documentId as string;
  await mcp(w.token, { action: 'transition', documentId: id, data: { status: 'open' } });
  return id;
}

/** An issue at `status`, entered and last written `ago` before now, merged then where asked. */
async function agedIssue(
  w: World,
  projectId: string,
  status: string,
  ago: number,
  merged: boolean,
): Promise<string> {
  const at = new Date(Date.now() - ago).toISOString();
  const rows = (await harness.db.execute(sql`
    INSERT INTO issues (project_id, title, status, created_by_id, iss_seq, merged_at, created_at, updated_at)
    VALUES (${projectId}::uuid, 'stuck', ${status}, ${w.ownerId}::uuid,
            (SELECT coalesce(max(iss_seq), 0) + 1 FROM issues WHERE project_id = ${projectId}::uuid),
            ${merged ? at : null}::timestamptz, ${at}::timestamptz, ${at}::timestamptz)
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return (rows[0] as { id: string }).id;
}

const archive = (projectId: string) =>
  harness.db.execute(sql`UPDATE projects SET archived_at = now() WHERE id = ${projectId}::uuid`);

/** Two sightings with the pending window spent between them, as two ticks minutes apart are. */
async function twoTicks(sweep: Sweep, now: Date): Promise<void> {
  await sweep(now);
  await harness.db.execute(
    sql`UPDATE notifications SET pending_since = pending_since - interval '10 minutes'`,
  );
  await sweep(new Date(now.getTime() + 2 * MINUTE));
}

/** The notices delivered to `userId` about `issueId`: what the bell would show. */
async function told(userId: string, issueId: string): Promise<string[]> {
  const rows = (await harness.db.execute(sql`
    SELECT n.title
      FROM notification_deliveries d
      JOIN notification_delivery_members m ON m.delivery_id = d.id
      JOIN notifications n ON n.id = m.notification_id
     WHERE d.user_id = ${userId}::uuid AND n.issue_id = ${issueId}::uuid
       AND n.type = 'issue_stranded' AND n.state = 'firing'
  `)) as unknown as Array<{ title: string }>;
  return rows.map((r) => r.title);
}

describe('the idle sweep, on the issue judge-25 stood up', () => {
  it('tells the admin about an Open issue nothing has worked past its fifteen minutes', async () => {
    const w = await world();
    const control = await openedIssue(w, w.live);

    await twoTicks(sweeps.idle, new Date(Date.now() + 16 * MINUTE));

    expect(await told(w.ownerId, control)).toEqual([
      expect.stringContaining('reads Open and nothing is working it'),
    ]);
  });

  it('tells nobody before those fifteen minutes are spent', async () => {
    const w = await world();
    const control = await openedIssue(w, w.live);

    await twoTicks(sweeps.idle, new Date(Date.now() + 12 * MINUTE));

    expect(await told(w.ownerId, control)).toEqual([]);
  });

  it('tells nobody about the same issue on an archived project, while the control is told', async () => {
    const w = await world();
    const control = await openedIssue(w, w.live);
    const quiet = await openedIssue(w, w.archived);
    await archive(w.archived);

    await twoTicks(sweeps.idle, new Date(Date.now() + 16 * MINUTE));

    expect(await told(w.ownerId, control)).toHaveLength(1);
    expect(await told(w.ownerId, quiet)).toEqual([]);
  });
});

describe.each([
  ['waiting-park', 'waiting', false, 'is waiting for'],
  ['owed-close', 'developed', true, 'merged but never closed'],
] as const)('the %s sweep', (name, status, merged, says) => {
  it('tells the admin about the live project and nobody about the archived one', async () => {
    const w = await world();
    const control = await agedIssue(w, w.live, status, 7 * HOUR, merged);
    const quiet = await agedIssue(w, w.archived, status, 7 * HOUR, merged);
    await archive(w.archived);

    await twoTicks(sweeps[name], new Date());

    expect(await told(w.ownerId, control)).toEqual([expect.stringContaining(says)]);
    expect(await told(w.ownerId, quiet)).toEqual([]);
  });

  it('tells nobody before its six hours are spent', async () => {
    const w = await world();
    const control = await agedIssue(w, w.live, status, 5 * HOUR, merged);

    await twoTicks(sweeps[name], new Date());

    expect(await told(w.ownerId, control)).toEqual([]);
  });
});

describe('the waiting-park sweep counts from the park, not from the last write (ISS-1229 r12)', () => {
  /** An issue made two days ago, parked at Waiting `parked` ago, and last written `edited` ago. */
  async function park(w: World, parked: number, edited: number): Promise<string> {
    const id = await agedIssue(w, w.live, 'waiting', 48 * HOUR, false);
    await harness.db.execute(sql`
      INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, source, created_at)
      VALUES ('issue', ${id}::uuid, 'in_progress', 'waiting', 'user', 'test',
              ${new Date(Date.now() - parked).toISOString()}::timestamptz)
    `);
    await harness.db.execute(sql`
      UPDATE issues SET updated_at = ${new Date(Date.now() - edited).toISOString()}::timestamptz
       WHERE id = ${id}::uuid
    `);
    return id;
  }

  it('tells the admin about a park of seven hours that was edited an hour ago', async () => {
    const w = await world();
    const control = await park(w, 7 * HOUR, HOUR);

    await twoTicks(sweeps['waiting-park'], new Date());

    expect(await told(w.ownerId, control)).toEqual([expect.stringContaining('is waiting for')]);
  });

  it('tells nobody about a park of five hours whose issue was last written a day ago', async () => {
    const w = await world();
    const control = await park(w, 5 * HOUR, 24 * HOUR);

    await twoTicks(sweeps['waiting-park'], new Date());

    expect(await told(w.ownerId, control)).toEqual([]);
  });
});
