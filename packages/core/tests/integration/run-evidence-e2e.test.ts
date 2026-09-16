/**
 * ISS-1050 criteria 22, 23, 26 — what a dead run left, on the issues it held.
 *
 * Real Postgres, because the two things in question are both database-shaped:
 * the testimony is read with a jsonb path operator over
 * `session_context.lease.next`, and "exactly once" is a containment match over
 * a comment body. A mocked db would assert the shape of those queries rather
 * than what they select, which is the only thing being claimed here.
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
  writeRunEvidence: typeof import('../../src/devices/run-evidence.js').writeRunEvidence;
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
    writeRunEvidence: evidence.writeRunEvidence,
    openRunSession: runSession.openRunSession,
  };
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

const A_CHECKPOINT = {
  source: 'reconstructed_from_box',
  branch: 'ISS-9-feature',
  head: 'aaaaaaaaaaaa',
  base: 'bbbbbbbbbbbb',
  filesTouched: ['src/one.ts', 'src/two.ts'],
  commitsAhead: 2,
  commitsUnpushed: 1,
  workingTreeDirty: true,
  endedBy: 'reconciler',
  endedReason: 'the run process is gone from this box',
  unread: [],
};

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

describe('what a dead run left, written onto its issues', () => {
  it('prints the box half and the run own words as two blocks, neither derived from the other', async () => {
    const said = 'next: rebase onto main, keep both CHANGELOG bullets';
    const { device, issueIds, session } = await aRunOver([9], said);

    const result = await mods.writeRunEvidence({
      deviceId: device.id,
      sessionId: session.sessionId,
      checkpoint: A_CHECKPOINT,
    });

    expect(result).toEqual({ issues: 1, written: 1 });
    const [body] = await bodiesOn(issueIds[0] as string);
    expect(body).toBeDefined();
    const text = body as string;
    expect(text).toContain('### Reconstructed from the box');
    expect(text).toContain('### What the run said about itself');
    // cm:guard the two headings must appear in this order and both must be present. A body with one
    // heading is the two records merged, and a master reading it cannot tell which half it has.
    expect(text.indexOf('### Reconstructed from the box')).toBeLessThan(
      text.indexOf('### What the run said about itself'),
    );
    // cm:guard each block is sliced and checked for what must NOT be in it, not only for what must.
    // An earlier version of this test asserted only that both strings appeared somewhere in the
    // body, and a planted counterexample that copied the box's branch INTO the run's own words
    // passed it — the one failure this whole design exists to prevent, invisible to its own test.
    const at = text.indexOf('### What the run said about itself');
    const boxBlock = text.slice(text.indexOf('### Reconstructed from the box'), at);
    const runBlock = text.slice(at);
    expect(boxBlock, 'the box half carries what the box read').toContain('ISS-9-feature');
    expect(runBlock, 'the run own words appear verbatim').toContain(said);
    expect(
      runBlock,
      'nothing the box read may appear under the heading that says the run said it',
    ).not.toContain('ISS-9-feature');
    expect(
      boxBlock,
      'nothing the run said may appear under the heading that says the box reconstructed it',
    ).not.toContain(said);
    expect(
      text.includes('recommendation') || text.includes('resumable'),
      'no verdict, no recommendation: whether work continues or restarts is the master call',
    ).toBe(false);
  });

  // cm:guard an empty testimony block is the HONEST answer and must stay visibly empty. Filling it
  // from the box would be core inventing a statement nobody made, under a heading that says the run
  // made it (ISS-1050 criterion 25).
  it('says the run wrote nothing rather than filling the block from the box', async () => {
    const { device, issueIds, session } = await aRunOver([9], null);

    await mods.writeRunEvidence({
      deviceId: device.id,
      sessionId: session.sessionId,
      checkpoint: A_CHECKPOINT,
    });

    const [body] = await bodiesOn(issueIds[0] as string);
    const text = body as string;
    const testimony = text.slice(text.indexOf('### What the run said about itself'));
    expect(testimony).toContain('wrote nothing onto its lease');
    expect(
      testimony,
      'nothing the box read may appear under the heading that says the run said it',
    ).not.toContain('ISS-9-feature');
  });

  // cm:guard the run own words are arbitrary text it wrote, so a fixed three-backtick fence is
  // breakable by the content: a `next` that itself contains a fenced block would close this one
  // early and the rest would render beside the box findings, which is the two blocks merging by
  // accident rather than by design.
  it('cannot be broken out of by a run that wrote a fenced block into its lease', async () => {
    const said = 'I tried:\n```sh\ngit push --force\n```\nand it was refused';
    const { device, issueIds, session } = await aRunOver([9], said);

    await mods.writeRunEvidence({
      deviceId: device.id,
      sessionId: session.sessionId,
      checkpoint: A_CHECKPOINT,
    });

    const [body] = await bodiesOn(issueIds[0] as string);
    const text = body as string;
    const testimony = text.slice(text.indexOf('### What the run said about itself'));
    expect(testimony, 'every byte the run wrote is inside the block').toContain(said);
    const opener = testimony.slice(testimony.indexOf('`'.repeat(3)));
    const fence = (opener.match(/^`+/) ?? [''])[0];
    expect(
      fence.length,
      'the fence must be longer than the longest backtick run in the content',
    ).toBeGreaterThan(3);
  });

  it('writes once however many times the close is retried', async () => {
    const { device, issueIds, session } = await aRunOver([9], 'once');

    const first = await mods.writeRunEvidence({
      deviceId: device.id,
      sessionId: session.sessionId,
      checkpoint: A_CHECKPOINT,
    });
    const second = await mods.writeRunEvidence({
      deviceId: device.id,
      sessionId: session.sessionId,
      checkpoint: A_CHECKPOINT,
    });

    expect(first?.written).toBe(1);
    expect(second?.written, 'the close loop retries every mark it owes; this must be a no-op').toBe(
      0,
    );
    expect(
      await bodiesOn(issueIds[0] as string),
      'a second identical post on an issue a human is asked to read turns a signal into noise',
    ).toHaveLength(1);
  });

  // cm:guard this is the case the evidence exists for. A run whose box died is reaped by
  // `reapDeadRunSessions` after ten minutes; the box comes back and reports what it left. Refusing
  // because the session is terminal drops the evidence in exactly that situation.
  it('accepts the evidence for a session core has already reaped', async () => {
    const { device, issueIds, session } = await aRunOver([9], 'died mid-rebase');
    await harness.db.execute(
      sql`UPDATE agent_sessions SET status = 'failed' WHERE id = ${session.sessionId}`,
    );

    const result = await mods.writeRunEvidence({
      deviceId: device.id,
      sessionId: session.sessionId,
      checkpoint: A_CHECKPOINT,
    });

    expect(result?.written).toBe(1);
    expect(await bodiesOn(issueIds[0] as string)).toHaveLength(1);
  });

  it('writes onto every issue the run was holding, not only the first', async () => {
    const { device, issueIds, session } = await aRunOver([9, 10, 11], 'shared');

    const result = await mods.writeRunEvidence({
      deviceId: device.id,
      sessionId: session.sessionId,
      checkpoint: A_CHECKPOINT,
    });

    expect(result).toEqual({ issues: 3, written: 3 });
    for (const id of issueIds) {
      expect(await bodiesOn(id)).toHaveLength(1);
    }
  });

  // cm:guard an undeclared payload is refused by NAME rather than labelled by this end. Printing it
  // under "reconstructed from the box" would be core vouching for something it did not read.
  it('refuses a checkpoint that does not declare what it is', async () => {
    const { device, session } = await aRunOver([9], 'x');

    await expect(
      mods.writeRunEvidence({
        deviceId: device.id,
        sessionId: session.sessionId,
        checkpoint: { ...A_CHECKPOINT, source: 'something-else' },
      }),
    ).rejects.toThrow(/reconstructed_from_box/);
  });

  it('answers nothing for a session belonging to another box', async () => {
    const { session } = await aRunOver([9], 'x');
    const other = await createTestUser(harness.db);
    const otherDevice = await createTestDevice(harness.db, other.id);

    expect(
      await mods.writeRunEvidence({
        deviceId: otherDevice.id,
        sessionId: session.sessionId,
        checkpoint: A_CHECKPOINT,
      }),
    ).toBeNull();
  });
});
