/**
 * ISS-1250 — the held report a person reads, posted by `writeHeldWorktreeReport` and read back
 * from Postgres: which reading is said, once per change of reading, and on which box.
 *
 * Split from `run-evidence-e2e.test.ts`, which covers the ended-run evidence, when the two
 * outgrew one file's size budget; both share `tests/helpers/run-evidence-fixture.ts`.
 */

import { readFileSync } from 'node:fs';
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
  writeHeldWorktreeReport: typeof import('../../src/devices/run-evidence.js').writeHeldWorktreeReport;
  heldWorktreeSchema: typeof import('../../src/devices/run-evidence.js').heldWorktreeSchema;
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
    writeHeldWorktreeReport: evidence.writeHeldWorktreeReport,
    heldWorktreeSchema: evidence.heldWorktreeSchema,
    openRunSession: runSession.openRunSession,
  };
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

const aRunOver = (issSeqs: number[], next?: string | null) =>
  runOver(harness.db, mods.openRunSession, issSeqs, next);
const bodiesOn = (issueId: string) => commentBodies(harness.db, issueId);

const A_HELD = {
  worktree: '/home/forge/projects/forge-dev/.worktrees/ISS-9',
  branch: 'ISS-9-feature',
  head: 'cccccccccccc',
  commitsUnpushed: 3,
  reason:
    "3 commit(s) here are on no remote — this reading refuses this checkout's removal: it cannot tell (x)",
  kept: true,
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

  it('says it again when the reading changes, and again when it changes back', async () => {
    const { device, issueIds, session } = await aRunOver([9], 'x');
    const report = (kept: boolean) =>
      mods.writeHeldWorktreeReport({
        deviceId: device.id,
        sessionId: session.sessionId,
        held: { ...A_HELD, kept },
      });

    expect(await report(true)).toEqual({ issues: 1, written: 1 });
    expect(await report(false)).toEqual({ issues: 1, written: 1 });
    expect(await report(false)).toEqual({ issues: 1, written: 0 });
    expect(await report(true)).toEqual({ issues: 1, written: 1 });

    const bodies = await bodiesOn(issueIds[0] as string);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toContain("The reading this box took refuses the checkout's removal");
    expect(bodies[1]).toContain("The reading this box took does not refuse the checkout's removal");
    expect(bodies[2]).toContain("The reading this box took refuses the checkout's removal");
  });

  it('says the reading once more over a report written before the reading was marked', async () => {
    const { device, issueIds, session } = await aRunOver([9], 'x');
    const first = issueIds[0] as string;
    await harness.db.execute(sql`
      INSERT INTO comments (issue_id, author_id, body)
      VALUES (${first}, ${device.ownerId},
              ${`## Work on this issue is on one machine only\n\n\`held-worktree: ${session.sessionId}:${A_HELD.head}\``})
    `);

    const result = await mods.writeHeldWorktreeReport({
      deviceId: device.id,
      sessionId: session.sessionId,
      held: A_HELD,
    });

    expect(result).toEqual({ issues: 1, written: 1 });
    expect(await bodiesOn(first)).toHaveLength(2);
  });

  it('names the box that took the reading and where its journal is read', async () => {
    const { device, issueIds, session } = await aRunOver([9], 'x');

    for (const kept of [true, false]) {
      await mods.writeHeldWorktreeReport({
        deviceId: device.id,
        sessionId: session.sessionId,
        held: { ...A_HELD, kept },
      });
    }

    const bodies = await bodiesOn(issueIds[0] as string);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toContain(`- box: \`${device.name}\``);
      expect(body).toContain('`forge-runner logs`');
    }
  });

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

  it('moves the issue nowhere and promises no release it cannot see', async () => {
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
    expect(body).not.toContain('releases the checkout');
  });

  it('prints not-counted rather than a zero the box never measured', async () => {
    const { device, issueIds, session } = await aRunOver([9], 'x');

    await mods.writeHeldWorktreeReport({
      deviceId: device.id,
      sessionId: session.sessionId,
      held: {
        worktree: A_HELD.worktree,
        head: A_HELD.head,
        reason: 'this box cannot tell whether the work here is on a remote (no route to host)',
        kept: false,
      },
    });

    const first = issueIds[0];
    if (!first) throw new Error('no issue');
    const body = (await bodiesOn(first)).join('\n');
    expect(body).toContain('commits on no remote: _not counted_');
    expect(body).not.toContain('commits on no remote: 0');
    expect(body).toContain('branch: _not read_');
    expect(body).not.toContain('work no remote holds');
    expect(body).not.toContain('## Work on this issue is on one machine only');
  });

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

/**
 * ISS-1250 criteria 6, 7, 8, 15 — the comment a person reads, from the payload the box sends.
 * The runner's suite pins what `Held::to_json` sends for three real repositories, one per state
 * of the release's predicate; this suite posts those lines. Reading only the runner's reason
 * string is how the posted sentence said "not released" about checkouts the box then removed.
 */
const HELD_WIRE = readFileSync(
  new URL(
    '../../../runner/crates/forge-runner-core/assets/held-worktree-wire.jsonl',
    import.meta.url,
  ),
  'utf8',
)
  .split('\n')
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('the held report a person reads says what the box read, from what the box sends', () => {
  async function postedFor(payload: Record<string, unknown>): Promise<string> {
    const { device, issueIds, session } = await aRunOver([9], 'x');
    const held = mods.heldWorktreeSchema.parse(payload);
    await mods.writeHeldWorktreeReport({
      deviceId: device.id,
      sessionId: session.sessionId,
      held,
    });
    return (await bodiesOn(issueIds[0] as string)).join('\n');
  }

  it('says of a checkout the release may take that the reading did not refuse it, and nothing more', async () => {
    const released = HELD_WIRE[0] as Record<string, unknown>;
    expect(released.kept).toBe(false);

    const body = await postedFor(released);

    expect(body).toContain("The reading this box took does not refuse the checkout's removal");
    expect(body).not.toContain('has **not** been released');
    expect(body).not.toContain('refuses to remove');
    expect(body).not.toContain('releases the checkout');
    expect(body).toContain('this repository has no remote to publish them to');
    expect(body).not.toContain('push');
    expect(body).toContain('commits on no remote: 2');
  });

  it('says of a checkout the release refuses that the reading refused it, and nothing past that reading', async () => {
    const kept = HELD_WIRE[1] as Record<string, unknown>;
    expect(kept.kept).toBe(true);

    const body = await postedFor(kept);

    expect(body).toContain("The reading this box took refuses the checkout's removal");
    expect(body).not.toContain('does not refuse');
    for (const future of [
      'stays',
      'remains',
      ' will ',
      'every sweep',
      'is kept',
      'keeps this checkout',
    ]) {
      expect(
        body,
        `a kept report says one reading, not the directory's future: ${future}`,
      ).not.toContain(future);
    }
  });

  it('claims no ref already holds commits that only the checkout names', async () => {
    const needsARef = HELD_WIRE[2] as Record<string, unknown>;
    expect(needsARef.kept).toBe(false);

    const body = await postedFor(needsARef);

    expect(body).toContain("The reading this box took does not refuse the checkout's removal");
    expect(body).toContain('a release must give them a ref of their own');
    expect(body).not.toContain('do not depend on');
    expect(body).toContain('branch: _not read_');
  });

  it('refuses a report that does not say whether the box keeps the checkout, naming the field', () => {
    const { kept: _dropped, ...unsaid } = HELD_WIRE[0] as Record<string, unknown>;

    const parsed = mods.heldWorktreeSchema.safeParse(unsaid);

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.path.join('.'))).toContain('kept');
  });
});
