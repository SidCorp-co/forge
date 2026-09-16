/**
 * ISS-1050 criterion 29 — what a resumed master chose about a run it inherited,
 * written on the issues that run held.
 *
 * Real Postgres, because "said once per run" is a containment match over a comment
 * body and "moved nothing" is a read of the issue row the write did not touch.
 * A mocked db would assert the shape of those queries rather than what they select.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let mods: {
  writeResumeChoice: typeof import('../../src/devices/run-evidence.js').writeResumeChoice;
  openRunSession: typeof import('../../src/devices/run-session.js').openRunSession;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  const evidence = await import('../../src/devices/run-evidence.js');
  const runSession = await import('../../src/devices/run-session.js');
  mods = {
    writeResumeChoice: evidence.writeResumeChoice,
    openRunSession: runSession.openRunSession,
  };
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function anIssue(args: {
  projectId: string;
  createdById: string;
  issSeq: number;
  next?: string | null;
}): Promise<string> {
  const lease =
    args.next === undefined ? null : JSON.stringify({ lease: { next: args.next, clock: 1 } });
  const rows = (await harness.db.execute(sql`
    INSERT INTO issues (project_id, created_by_id, iss_seq, title, status, session_context)
    VALUES (${args.projectId}, ${args.createdById}, ${args.issSeq}, ${`issue ${args.issSeq}`},
            'in_progress', ${lease}::jsonb)
    RETURNING id
  `)) as unknown as { id: string }[];
  const id = rows[0]?.id;
  if (!id) throw new Error('anIssue: insert returned no row');
  return id;
}

async function bodiesOn(issueId: string): Promise<string[]> {
  const rows = (await harness.db.execute(
    sql`SELECT body FROM comments WHERE issue_id = ${issueId} ORDER BY created_at`,
  )) as unknown as { body: string }[];
  return rows.map((r) => r.body);
}

async function aRunOver(issSeqs: number[], next?: string | null) {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  const device = await createTestDevice(harness.db, user.id);
  const issueIds: string[] = [];
  for (const seq of issSeqs) {
    issueIds.push(
      await anIssue({
        projectId: project.id,
        createdById: user.id,
        issSeq: seq,
        ...(next === undefined ? {} : { next }),
      }),
    );
  }
  const session = await mods.openRunSession({
    deviceId: device.id,
    projectId: project.id,
    issueKeys: issSeqs.map((s) => `ISS-${s}`),
    name: 'run-a',
  });
  return { user, project, device, issueIds, session };
}

describe('what a resumed master chose, on the issues its inherited run holds', () => {
  const A_CHOICE = {
    runId: 'run-abc',
    choice: 'restart' as const,
    why: 'the branch has nothing on it and the checkout is clean',
  };

  it('says the choice and the reason on every issue that run held', async () => {
    const { device, issueIds, session } = await aRunOver([9, 10], 'x');

    const result = await mods.writeResumeChoice({
      deviceId: device.id,
      sessionId: session.sessionId,
      choice: A_CHOICE,
    });

    expect(result).toEqual({ issues: 2, written: 2 });
    for (const id of issueIds) {
      const body = (await bodiesOn(id)).join('\n');
      expect(body).toContain('**restart**');
      expect(body).toContain(A_CHOICE.why);
    }
  });

  // cm:guard says WHOSE judgement it was. The box handed the master raw fields and no
  // recommendation; printing the choice without saying it was the master's would read as the
  // system having decided, which is the thing this design refuses to do.
  it('attributes the judgement to the resumed master, not to the machine', async () => {
    const { device, issueIds, session } = await aRunOver([9], 'x');

    await mods.writeResumeChoice({
      deviceId: device.id,
      sessionId: session.sessionId,
      choice: A_CHOICE,
    });

    const first = issueIds[0];
    if (!first) throw new Error('no issue');
    const body = (await bodiesOn(first)).join('\n');
    expect(body).toContain('no recommendation attached');
    expect(body).toMatch(/judgement is the resumed machine/i);
  });

  // cm:guard keyed on the RUN, so one resumed pane answering for several runs writes one comment
  // per run, while a pane asked twice about one run says it once.
  it('says one run once however many sweeps carry it', async () => {
    const { device, issueIds, session } = await aRunOver([9], 'x');

    for (let i = 0; i < 3; i += 1) {
      await mods.writeResumeChoice({
        deviceId: device.id,
        sessionId: session.sessionId,
        choice: A_CHOICE,
      });
    }

    const first = issueIds[0];
    if (!first) throw new Error('no issue');
    expect(await bodiesOn(first)).toHaveLength(1);
  });

  it('says a second run on the same issue separately', async () => {
    const { device, issueIds, session } = await aRunOver([9], 'x');

    await mods.writeResumeChoice({
      deviceId: device.id,
      sessionId: session.sessionId,
      choice: A_CHOICE,
    });
    await mods.writeResumeChoice({
      deviceId: device.id,
      sessionId: session.sessionId,
      choice: { ...A_CHOICE, runId: 'run-def', choice: 'leave', why: 'not ours to settle' },
    });

    const first = issueIds[0];
    if (!first) throw new Error('no issue');
    const bodies = await bodiesOn(first);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain('**leave**');
  });

  it('moves the issue nowhere', async () => {
    const { device, issueIds, session } = await aRunOver([9], 'x');

    await mods.writeResumeChoice({
      deviceId: device.id,
      sessionId: session.sessionId,
      choice: A_CHOICE,
    });

    const first = issueIds[0];
    if (!first) throw new Error('no issue');
    const rows = (await harness.db.execute(
      sql`SELECT status FROM issues WHERE id = ${first}`,
    )) as unknown as { status: string }[];
    expect(rows[0]?.status).toBe('in_progress');
  });

  it('answers nothing for a session belonging to another box', async () => {
    const { session } = await aRunOver([9], 'x');
    const other = await createTestUser(harness.db);
    const otherDevice = await createTestDevice(harness.db, other.id);

    expect(
      await mods.writeResumeChoice({
        deviceId: otherDevice.id,
        sessionId: session.sessionId,
        choice: A_CHOICE,
      }),
    ).toBeNull();
  });
});
