/**
 * ISS-1050 criteria 22, 23, 26 — what a dead run left, on the issues it held.
 *
 * Real Postgres, because the two things in question are both database-shaped:
 * the testimony is read with a jsonb path operator over
 * `issue_work_state.lease.next` (ISS-54), and "exactly once" is a containment match over
 * a comment body. A mocked db would assert the shape of those queries rather
 * than what they select, which is the only thing being claimed here.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { bodiesOn as commentBodies, aRunOver as runOver } from '../helpers/run-evidence-fixture.js';

let harness: TestDatabase;
let mods: {
  writeRunEvidence: typeof import('../../src/devices/run-evidence.js').writeRunEvidence;
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

const aRunOver = (issSeqs: number[], next?: string | null) =>
  runOver(harness.db, mods.openRunSession, issSeqs, next);
const bodiesOn = (issueId: string) => commentBodies(harness.db, issueId);

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
    expect(text.indexOf('### Reconstructed from the box')).toBeLessThan(
      text.indexOf('### What the run said about itself'),
    );
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
