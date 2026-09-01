/**
 * ISS-894 wave 0 — a job token lives exactly as long as its job.
 *
 * The mint is easy to get right and the revoke is where this leaks. A token
 * scoped to a project, left live after the job that carried it ended, is a
 * permanent credential on a box nobody is watching — so every one of these
 * cases drives a job terminal by a DIFFERENT route and asserts the token is
 * dead. The happy finish alone would pass while cancel leaked.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let mintJobToken: typeof import('../../src/jobs/job-token.js').mintJobToken;
let applyKernelTransition: typeof import('../../src/lifecycle/transition.js').applyKernelTransition;
let verifyPat: typeof import('../../src/auth/pat.js').verifyPat;
let countActivePatsForUser: typeof import('../../src/auth/pat.js').countActivePatsForUser;
let mintPat: typeof import('../../src/auth/pat.js').mintPat;
let authenticatePat: typeof import('../../src/middleware/require-pat-or-device.js').authenticatePat;
let principalActor: typeof import('../../src/mcp/tools/lib.js').principalActor;
let dbMod: typeof import('../../src/db/client.js');
let schema: typeof import('../../src/db/schema.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const [tok, trans, pat, client, sch, mw, mcpLib] = await Promise.all([
    import('../../src/jobs/job-token.js'),
    import('../../src/lifecycle/transition.js'),
    import('../../src/auth/pat.js'),
    import('../../src/db/client.js'),
    import('../../src/db/schema.js'),
    import('../../src/middleware/require-pat-or-device.js'),
    import('../../src/mcp/tools/lib.js'),
  ]);
  authenticatePat = mw.authenticatePat;
  principalActor = mcpLib.principalActor;
  mintJobToken = tok.mintJobToken;
  applyKernelTransition = trans.applyKernelTransition;
  verifyPat = pat.verifyPat;
  countActivePatsForUser = pat.countActivePatsForUser;
  mintPat = pat.mintPat;
  dbMod = client;
  schema = sch;
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function seedJob() {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
    VALUES (${runId}::uuid, ${project.id}::uuid, 'system', 'running', now())
  `);
  const jobId = await seedJobRow(project.id, user.id, runId);
  return { user, project, jobId, runId };
}

async function seedJobRow(projectId: string, userId: string, runId: string): Promise<string> {
  const jobId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, created_by, type, status)
    VALUES (${jobId}::uuid, ${projectId}::uuid, ${runId}::uuid, ${userId}::uuid, 'code', 'running')
  `);
  return jobId;
}

/** Resolve the token; `null` once it is revoked. */
const alive = async (plaintext: string) => (await verifyPat(plaintext)) !== null;

// cm:guard the revoke rides the chokepoint fire-and-forget, exactly as the escalation bridge does, so it lands AFTER `applyKernelTransition` has already resolved — an assertion made straight after that await reads the token still live and would pass for the wrong reason the day the revoke was deleted. Poll to a deadline rather than sleep a fixed span, so a slow box cannot make this flaky in the one direction that hides a leak.
async function deadWithin(plaintext: string, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await alive(plaintext))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

async function driveTerminal(
  jobId: string,
  to: 'done' | 'failed' | 'cancelled',
  reason: string,
): Promise<void> {
  await applyKernelTransition(dbMod.db, {
    entity: 'job',
    to,
    where: sql`${schema.jobs.id} = ${jobId}::uuid AND ${schema.jobs.status} NOT IN ('done','failed','cancelled')`,
    reason,
    actor: { type: 'system' },
    source: 'test',
  });
}

describe('a job token is scoped to its project and its principal', () => {
  it('mints under the job creator, bound to the job project', async () => {
    const { user, project, jobId } = await seedJob();
    const plaintext = await mintJobToken({
      id: jobId,
      projectId: project.id,
      createdBy: user.id,
    });
    expect(plaintext).toBeTruthy();

    const verified = await verifyPat(plaintext as string);
    expect(verified?.row.userId).toBe(user.id);
    expect(verified?.row.boundProjectId).toBe(project.id);
    expect(verified?.row.scopes).toEqual(['read', 'write']);
    // cm:guard assert a limit ABOVE the 60/min default, not the exact number: the point is that a job token is not left on a ceiling a measured job already exceeds, because tripping it three times in an hour revokes the token for good and the job cannot mint another.
    expect(verified?.row.rateLimitMax ?? 60).toBeGreaterThan(108);
  });

  // cm:guard job tokens are minted under a real user, so without the `job:` filter ten concurrent jobs would consume that user's PAT cap and the next token they tried to create by hand would be refused with a limit they never approached.
  it('does not count against the user own PAT cap', async () => {
    const { user, project, jobId } = await seedJob();
    await mintPat({ userId: user.id, name: 'my laptop' });
    expect(await countActivePatsForUser(user.id)).toBe(1);

    await mintJobToken({ id: jobId, projectId: project.id, createdBy: user.id });
    expect(await countActivePatsForUser(user.id)).toBe(1);
  });

  // cm:guard a retry re-dispatches the SAME job id, and `pat_user_name_uniq` is on (user_id, name) — so without superseding the previous row the second mint violates the index and takes the whole dispatch down with it. The old token must also be dead: a retry means the previous attempt's agent is gone.
  it('supersedes the previous token when the same job dispatches again', async () => {
    const { user, project, jobId } = await seedJob();
    const first = (await mintJobToken({
      id: jobId,
      projectId: project.id,
      createdBy: user.id,
    })) as string;
    const second = (await mintJobToken({
      id: jobId,
      projectId: project.id,
      createdBy: user.id,
    })) as string;

    expect(second).not.toBe(first);
    expect(await alive(first)).toBe(false);
    expect(await alive(second)).toBe(true);
  });
});

describe('the token dies with the job, by every route a job can end', () => {
  // cm:guard three routes, not one, and that is the whole point of the case list: `done` is the happy finish, `cancelled` is what the run-close cascade and an operator cancel both write, and `failed` is what the loop monitor and the park reaper write. They share `applyKernelTransition` and nothing else, so a revoke wired into any single caller would leak on the other two.
  it.each([
    ['the happy finish', 'done' as const, 'completed'],
    ['a cancel or a run-close cascade', 'cancelled' as const, 'pipeline_cancelled'],
    ['a loop-monitor or park reap', 'failed' as const, 'residency_expired'],
  ])('revokes on %s', async (_label, to, reason) => {
    const { user, project, jobId } = await seedJob();
    const plaintext = (await mintJobToken({
      id: jobId,
      projectId: project.id,
      createdBy: user.id,
    })) as string;
    expect(await alive(plaintext)).toBe(true);

    await driveTerminal(jobId, to, reason);

    expect(await deadWithin(plaintext)).toBe(true);
  });

  it('leaves another job token alone', async () => {
    const { user, project, jobId, runId } = await seedJob();
    const otherJobId = await seedJobRow(project.id, user.id, runId);
    const mine = (await mintJobToken({
      id: jobId,
      projectId: project.id,
      createdBy: user.id,
    })) as string;
    const theirs = (await mintJobToken({
      id: otherJobId,
      projectId: project.id,
      createdBy: user.id,
    })) as string;

    await driveTerminal(jobId, 'done', 'completed');

    expect(await deadWithin(mine)).toBe(true);
    expect(await alive(theirs)).toBe(true);
  });
});

describe('a job token authenticates as an agent, not as the human who owns it', () => {
  // cm:guard assert through `principalActor`, not on `agency` — the field is not the gate. `mark_merged` and `checkTransitionEvidence` both branch on `principalActor(...).type === 'device'`, so that expression IS the ISS-786/812 scope decision and is the only thing worth pinning. A test that asserted `agency === 'agent'` would stay green through a `principalActor` that ignored the field entirely.
  const gateApplies = (principal: unknown) =>
    principalActor(principal as never, { id: randomUUID(), ownerId: randomUUID() } as never)
      .type === 'device';

  const ctx = () =>
    ({ header: () => undefined, req: { header: () => undefined } }) as unknown as Parameters<
      typeof authenticatePat
    >[0];

  it('puts a job token inside the evidence gate', async () => {
    const { user, project, jobId } = await seedJob();
    const plaintext = (await mintJobToken({
      id: jobId,
      projectId: project.id,
      createdBy: user.id,
    })) as string;

    const principal = await authenticatePat(ctx(), plaintext);
    expect(principal?.agency).toBe('agent');
    expect(gateApplies(principal)).toBe(true);
  });

  it('leaves a hand-made PAT outside it, so a deliberate human merge stays ungated', async () => {
    const user = await createTestUser(harness.db);
    const { plaintext } = await mintPat({ userId: user.id, name: 'my laptop' });

    const principal = await authenticatePat(ctx(), plaintext);
    expect(principal?.agency).toBe('human');
    expect(gateApplies(principal)).toBe(false);
  });

  // cm:guard this is the falsifying half and it must keep failing when the derivation is removed — the case above passes for any implementation that hardcodes `'agent'`, including one that ignores the token entirely. Stripping the marker off a row that is otherwise identical is what proves the prefix, and nothing else, is carrying the decision.
  it('carries the decision on the job: prefix and nothing else', async () => {
    const { user, project, jobId } = await seedJob();
    const plaintext = (await mintJobToken({
      id: jobId,
      projectId: project.id,
      createdBy: user.id,
    })) as string;
    expect(gateApplies(await authenticatePat(ctx(), plaintext))).toBe(true);

    await harness.db.execute(sql`
      UPDATE personal_access_tokens SET name = 'looks like a laptop'
      WHERE name = ${`job:${jobId}`}
    `);

    expect(gateApplies(await authenticatePat(ctx(), plaintext))).toBe(false);
  });
});
