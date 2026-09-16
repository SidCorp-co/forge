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
  writeHeldWorktreeReport: typeof import('../../src/devices/run-evidence.js').writeHeldWorktreeReport;
  openRunSession: typeof import('../../src/devices/run-session.js').openRunSession;
  runEvidenceMarker: typeof import('../../src/devices/run-evidence.js').runEvidenceMarker;
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
    writeHeldWorktreeReport: evidence.writeHeldWorktreeReport,
    openRunSession: runSession.openRunSession,
    runEvidenceMarker: evidence.runEvidenceMarker,
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

/** Wait until Postgres itself says both reports are blocked on this issue's marker key. */
// cm:why it asks the DATABASE what is happening rather than timing how long nothing happens, for the
// reason `run-session-readback-e2e.test.ts` states at length: the assertion it feeds is an ABSENCE,
// and an absence is satisfied by a busy pool or a worker the scheduler has not run. Two UNGRANTED
// advisory locks on this exact key is a positive fact the unlocked code can never produce.
async function bothAreWaitingOn(key: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let seen = -1;
  while (Date.now() < deadline) {
    const rows = (await harness.db.execute(sql`
      SELECT count(*)::int AS n
        FROM pg_locks
       WHERE locktype = 'advisory'
         AND NOT granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND classid = ((hashtextextended(${key}, 0) >> 32) & 4294967295)::oid
         AND objid = (hashtextextended(${key}, 0) & 4294967295)::oid
    `)) as unknown as { n: number }[];
    seen = rows[0]?.n ?? 0;
    if (seen >= 2) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `both reports should be BLOCKED on this issue's marker key while the harness holds it; ` +
      `Postgres reports ${seen} waiter(s) after 10s. A writer that does not wait on this key is ` +
      `reading around the marker rather than claiming it.`,
  );
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

  // cm:guard whitespace is NOT nothing, which is ISS-1050 finding F5. Criterion 24 says the run's own
  // text appears byte for byte and nowhere else, and `next.trim() === ''` answered for a run that
  // wrote spaces with this module's sentence instead — a substitution on the one surface built to
  // keep what the box read apart from what the run said. Only a lease with no text at all earns the
  // empty block.
  it('prints whitespace the run wrote rather than calling it nothing written', async () => {
    const said = '   \n\t ';
    const { device, issueIds, session } = await aRunOver([9], said);

    await mods.writeRunEvidence({
      deviceId: device.id,
      sessionId: session.sessionId,
      checkpoint: A_CHECKPOINT,
    });

    const [body] = await bodiesOn(issueIds[0] as string);
    const text = body as string;
    const testimony = text.slice(text.indexOf('### What the run said about itself'));
    expect(
      testimony,
      'a run that wrote something, however little, did not write nothing',
    ).not.toContain('wrote nothing onto its lease');
    expect(testimony, 'and what it wrote is carried byte for byte').toContain(said);
  });

  // cm:guard two sweeps in flight TOGETHER, which is ISS-1050 finding F4 and the case the sequential
  // retry below cannot reach. The marker was a select followed by an insert with nothing serialising
  // them, so both callers read no comment and both inserted; the box reports a checkpoint on every
  // sweep until core takes it, so two in flight is the ordinary condition rather than a rare race.
  //
  // cm:why the harness takes the writer's OWN key first and asserts both callers BLOCK on it, rather
  // than firing two calls and counting the comments. Measured here: two concurrent calls against the
  // UNLOCKED code still produced one comment, because the two awaits between the select and the
  // insert let one finish before the other looked. A test that cannot fail proves nothing, and
  // counting rows would have been exactly that. Two ungranted advisory locks on this key is a
  // positive fact only the locking code can produce.
  it('makes two reports of one close wait on each other, and writes once', async () => {
    const { device, issueIds, session } = await aRunOver([9], 'twice at once');
    const issueId = issueIds[0] as string;
    const key = `run-evidence:${issueId}:${mods.runEvidenceMarker(session.sessionId)}`;

    let releaseTheLock = () => {};
    const lockHeld = new Promise<void>((resolve) => {
      releaseTheLock = resolve;
    });
    const holder = harness.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      await lockHeld;
    });

    const report = () =>
      mods.writeRunEvidence({
        deviceId: device.id,
        sessionId: session.sessionId,
        checkpoint: A_CHECKPOINT,
      });
    const settled: string[] = [];
    const first = report().then((r) => {
      settled.push('first');
      return r;
    });
    const second = report().then((r) => {
      settled.push('second');
      return r;
    });
    await bothAreWaitingOn(key);

    expect(
      settled,
      'a writer that answers while another holds this issue marker key has not claimed it — it has read around it',
    ).toEqual([]);

    releaseTheLock();
    await holder;
    const both = await Promise.all([first, second]);

    expect(
      (await bodiesOn(issueId)).length,
      'the issue carries one copy of the evidence, whatever the box did',
    ).toBe(1);
    expect(
      both.map((r) => r?.written).sort(),
      'exactly one of the two calls is the one that wrote it',
    ).toEqual([0, 1]);
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

const A_HELD = {
  worktree: '/home/forge/projects/forge-dev/.worktrees/ISS-9',
  branch: 'ISS-9-feature',
  head: 'cccccccccccc',
  commitsUnpushed: 3,
  reason: '3 commit(s) here are on no remote, and the push to publish them did not land',
};

describe('a checkout this box is still holding, said on the issues it holds', () => {
  it('says on every issue the run held that its work is on one machine only', async () => {
    const { device, issueIds, session } = await aRunOver([9, 10], 'x');

    const result = await mods.writeHeldWorktreeReport({
      deviceId: device.id,
      sessionId: session.sessionId,
      held: A_HELD,
    });

    expect(result).toEqual({ issues: 2, written: 2 });
    for (const id of issueIds) {
      const body = (await bodiesOn(id)).join('\n');
      expect(body).toContain('on one machine only');
      expect(body).toContain('ISS-9-feature');
      expect(body).toContain('commits on no remote: 3');
      expect(body).toContain(A_HELD.reason);
    }
  });

  // cm:guard the retry says nothing the second time. The box re-attempts the release every thirty
  // seconds and re-reports on each sweep; keying the no-op on the session alone would be enough for
  // THIS assertion, which is why the next test exists.
  it('says the same hold once however many sweeps report it', async () => {
    const { device, issueIds, session } = await aRunOver([9], 'x');

    for (let i = 0; i < 4; i += 1) {
      await mods.writeHeldWorktreeReport({
        deviceId: device.id,
        sessionId: session.sessionId,
        held: A_HELD,
      });
    }

    const first = issueIds[0];
    if (!first) throw new Error('no issue');
    expect(await bodiesOn(first)).toHaveLength(1);
  });

  // cm:guard a run that commits again while held has changed WHAT is at risk, and that is a second
  // thing to say. This is the assertion that a session-only idempotency key would fail.
  it('says it again when the head the box is holding has moved', async () => {
    const { device, issueIds, session } = await aRunOver([9], 'x');

    await mods.writeHeldWorktreeReport({
      deviceId: device.id,
      sessionId: session.sessionId,
      held: A_HELD,
    });
    await mods.writeHeldWorktreeReport({
      deviceId: device.id,
      sessionId: session.sessionId,
      held: { ...A_HELD, head: 'dddddddddddd', commitsUnpushed: 4 },
    });

    const first = issueIds[0];
    if (!first) throw new Error('no issue');
    const bodies = await bodiesOn(first);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain('commits on no remote: 4');
  });

  // cm:guard the report decides nothing and asks for nothing. A box refusing to release a checkout
  // is already the strongest act available to it; a status move, or prose that reads as a request
  // for one, would be the kernel deciding what happens to work whose owner it cannot ask.
  it('moves the issue nowhere and says plainly that the box keeps trying', async () => {
    const { device, issueIds, session } = await aRunOver([9], 'x');

    await mods.writeHeldWorktreeReport({
      deviceId: device.id,
      sessionId: session.sessionId,
      held: A_HELD,
    });

    const first = issueIds[0];
    if (!first) throw new Error('no issue');
    const rows = (await harness.db.execute(
      sql`SELECT status, session_context FROM issues WHERE id = ${first}`,
    )) as unknown as { status: string; session_context: unknown }[];
    expect(rows[0]?.status).toBe('in_progress');
    const body = (await bodiesOn(first)).join('\n');
    expect(body).toContain('Nothing about this issue has been moved');
    expect(body).toContain('releases the checkout with no action from anybody');
  });

  // cm:guard a box that could not count says so, rather than printing a zero it did not measure. A
  // `0` here reads as "nothing is at risk", which is the opposite of what an unreachable remote
  // established.
  it('prints not-counted rather than a zero the box never measured', async () => {
    const { device, issueIds, session } = await aRunOver([9], 'x');

    await mods.writeHeldWorktreeReport({
      deviceId: device.id,
      sessionId: session.sessionId,
      held: {
        worktree: A_HELD.worktree,
        head: A_HELD.head,
        reason: 'this box cannot tell whether the work here is on a remote (no route to host)',
      },
    });

    const first = issueIds[0];
    if (!first) throw new Error('no issue');
    const body = (await bodiesOn(first)).join('\n');
    expect(body).toContain('commits on no remote: _not counted_');
    expect(body).not.toContain('commits on no remote: 0');
    expect(body).toContain('branch: _not read_');
  });

  // cm:guard the same status-blindness `writeRunEvidence` has, for the same reason: the report
  // exists for the run whose box died, and core reaps that session after ten minutes.
  it('accepts a hold reported for a session core has already reaped', async () => {
    const { device, issueIds, session } = await aRunOver([9], 'x');
    await harness.db.execute(
      sql`UPDATE agent_sessions SET status = 'failed' WHERE id = ${session.sessionId}`,
    );

    const result = await mods.writeHeldWorktreeReport({
      deviceId: device.id,
      sessionId: session.sessionId,
      held: A_HELD,
    });

    expect(result).toEqual({ issues: 1, written: 1 });
    const first = issueIds[0];
    if (!first) throw new Error('no issue');
    expect(await bodiesOn(first)).toHaveLength(1);
  });

  it('answers nothing for a session belonging to another box', async () => {
    const { session } = await aRunOver([9], 'x');
    const other = await createTestUser(harness.db);
    const otherDevice = await createTestDevice(harness.db, other.id);

    expect(
      await mods.writeHeldWorktreeReport({
        deviceId: otherDevice.id,
        sessionId: session.sessionId,
        held: A_HELD,
      }),
    ).toBeNull();
  });
});
