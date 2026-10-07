import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

// ISS-276, live 2026-10-07: runner 78ca8ff1 kept "You've hit your weekly limit · resets Oct 8, 12am"
// as its last error with no limit set. A limit lives on every binding of a device, and its detail is
// mirrored into one binding's last error; the stamp and the clear were each handed whichever binding
// the caller had, so a limit stamped through one binding and lifted through another left the copy.

type Stamp = typeof import('../../src/runners/index.js').stampRunnerLimit;
type Clear = typeof import('../../src/runners/index.js').clearRunnerLimit;

let stamp: Stamp;
let clear: Clear;
let lastErrors: () => Promise<Record<string, string | null>>;
let setLastError: (runnerId: string, text: string) => Promise<void>;
let reset: () => Promise<void>;
let a = '';
let b = '';
let projectA = '';
let projectB = '';

const usage = (detail: string) => ({
  reason: 'usage_limit' as const,
  refusedAt: new Date(),
  nextTryAt: new Date(Date.now() + 5 * 60_000),
  printedResetAt: new Date(Date.now() + 3 * 60 * 60_000),
  detail,
});

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ({ stampRunnerLimit: stamp, clearRunnerLimit: clear } = await import(
    '../../src/runners/index.js'
  ));
  const { db } = await import('../../src/db/client.js');
  const { runners } = await import('../../src/db/schema.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  projectA = (await createTestProject(ownerId)).id;
  projectB = (await createTestProject(ownerId)).id;
  const deviceId = await createTestDevice(ownerId);
  a = await bindTestRunner(projectA, deviceId);
  b = await bindTestRunner(projectB, deviceId);
  lastErrors = async () => {
    const rows = await db
      .select({ id: runners.id, lastError: runners.lastError })
      .from(runners)
      .where(inArray(runners.id, [a, b]));
    return Object.fromEntries(rows.map((r) => [r.id === a ? 'a' : 'b', r.lastError]));
  };
  setLastError = async (runnerId, text) => {
    await db.update(runners).set({ lastError: text }).where(eq(runners.id, runnerId));
  };
  reset = async () => {
    await db.execute(sql`
      UPDATE runners SET last_error = NULL, limit_reason = NULL, rate_limited_until = NULL,
             limit_detail = NULL, limit_refused_at = NULL, limit_printed_reset_at = NULL
       WHERE id IN (${a}, ${b})`);
  };
}, 120_000);

beforeEach(async () => reset());

afterAll(async () => {
  await closeWorld();
});

describe('the last-error copy of a limit goes where the limit goes', () => {
  it('a limit stamped through one binding and lifted through another leaves no copy behind', async () => {
    await stamp(a, projectA, usage("You've hit your weekly limit · resets Oct 8, 12am"));
    expect(await lastErrors()).toEqual({
      a: "You've hit your weekly limit · resets Oct 8, 12am",
      b: null,
    });

    await clear(b, projectB);

    expect(await lastErrors()).toEqual({ a: null, b: null });
  });

  it('a limit stamped again through the other binding moves the copy, so the clear still finds it', async () => {
    await stamp(a, projectA, usage('resets 2:30am (Asia/Ho_Chi_Minh)'));
    await stamp(b, projectB, usage('resets 3am (Asia/Ho_Chi_Minh)'));
    expect(await lastErrors()).toEqual({
      a: 'resets 3am (Asia/Ho_Chi_Minh)',
      b: 'resets 3am (Asia/Ho_Chi_Minh)',
    });

    await clear(b, projectB);

    expect(await lastErrors()).toEqual({ a: null, b: null });
  });

  it('an error a binding reported for itself is not the limit, and outlives the clear', async () => {
    await setLastError(a, 'preflight: the checkout is dirty');
    await stamp(b, projectB, usage('resets 3am (Asia/Ho_Chi_Minh)'));
    expect((await lastErrors()).a).toBe('preflight: the checkout is dirty');

    await clear(b, projectB);

    expect(await lastErrors()).toEqual({ a: 'preflight: the checkout is dirty', b: null });
  });
});
