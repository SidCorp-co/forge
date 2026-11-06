/**
 * ISS-1050 (REQ-79 BC-20, revision 10): a cleanup window that is on starts a run whenever anything
 * landed on the base since its last report, with no debt open, and the run is briefed with that range
 * and the audit guide that says how to review it. A window with neither still starts nothing. The
 * trigger never reaches past the window: a project with no window, or one disabled, starts no run and
 * gains no window, whatever landed.
 *
 * @direct-test-of packages/core/src/cleanup/fire.ts
 * @direct-test-of packages/core/src/cleanup/landed.ts
 * @direct-test-of packages/core/src/cleanup/rules.ts
 * @direct-test-of packages/core/src/schedules/cleanup-dispatch.ts
 * @direct-test-of packages/core/src/schedules/ports.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupFirePlan } from '../../src/cleanup/index.js';
import { api, userToken } from '../helpers/api.js';
import { plantSource } from '../helpers/cleanup-source.js';
import { turnCleanupWindowOn } from '../helpers/cleanup-window.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows, truncateAll } from '../helpers/factories.js';
import { releaseWorld, seedProductionDeployTrigger, stubProbe } from '../helpers/release-world.js';

// a report's base and the branch head are read on the project's source host: planted, never a real one
vi.mock('../../src/integrations/source-host/index.js', async (original) =>
  (await import('../helpers/cleanup-source.js')).mockedSourceHost(
    await original<typeof import('../../src/integrations/source-host/index.js')>(),
  ),
);

const REPORTED = 'a'.repeat(40);
const LANDED = 'b'.repeat(40);

let projectId: string;
let ownerId: string;
let token: string;
const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [] });
  await seedProductionDeployTrigger(projectId, ownerId, 'on-land');
  stubProbe({});
});

/** The base as the last cleanup report left it at REPORTED, and whatever landed after it. */
async function reportedThenLanded(landed: readonly string[]) {
  const planted = plantSource(projectId, { main: [REPORTED], dev: [REPORTED] });
  const res = await api(token, 'POST', `/api/projects/${projectId}/cleanup-reports`, {
    base: { branch: 'main', sha: REPORTED },
    result: 'green',
    cleared: [],
    remains: [],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  for (const sha of landed) planted.branches.get('main')?.add(sha);
  return planted;
}

const plan = () => cleanupFirePlan({ projectId, fireId: 'fire-1' });
const windows = () =>
  rows<{ enabled: boolean }>(
    sql`SELECT enabled FROM schedules WHERE project_id = ${projectId} AND kind = 'cleanup'`,
  );
const open = async () =>
  ((await api(token, 'GET', `/api/projects/${projectId}/debts`)).body as Doc).open as Doc[];

describe('ISS-1050: a window that is on reviews what landed since its last report (BC-20)', () => {
  it('starts a run with no debt open when commits landed since the last report, briefed with the range and the audit guide', async () => {
    await turnCleanupWindowOn(projectId, ownerId);
    await reportedThenLanded([LANDED]);
    expect(await open()).toEqual([]);
    const fire = await plan();
    expect(fire.kind, JSON.stringify(fire)).toBe('run');
    const prompt = fire.kind === 'run' ? fire.prompt : '';
    expect(prompt).toContain(`${REPORTED}..${LANDED}`);
    expect(prompt).toContain('GET /api/guides/cleanup-audit.md');
    expect(prompt).not.toContain('simplify the code you touch');
  });

  it('still starts nothing where no debt is open and nothing landed since the last report', async () => {
    await turnCleanupWindowOn(projectId, ownerId);
    await reportedThenLanded([]);
    const fire = await plan();
    expect(fire.kind, JSON.stringify(fire)).toBe('nothing');
    expect(fire.kind === 'nothing' ? fire.why : '').toContain('nothing landed on main');
  });

  it('refuses by name where the base cannot be read, rather than calling it nothing to do', async () => {
    await turnCleanupWindowOn(projectId, ownerId);
    const planted = await reportedThenLanded([LANDED]);
    planted.fail = new Error('the host is down');
    const fire = await plan();
    expect(fire.kind, JSON.stringify(fire)).toBe('unread');
    expect(fire.kind === 'unread' ? fire.why : '').toContain('the host is down');
  });
});

describe('ISS-1050: the trigger never reaches past the window', () => {
  it('starts no run and makes no window on a project with none, whatever landed', async () => {
    await reportedThenLanded([LANDED]);
    expect((await plan()).kind).toBe('nothing');
    expect(await windows()).toEqual([]);
  });

  it('starts no run and leaves a disabled window off, whatever landed', async () => {
    await turnCleanupWindowOn(projectId, ownerId, { enabled: false });
    await reportedThenLanded([LANDED]);
    expect((await plan()).kind).toBe('nothing');
    expect(await windows()).toEqual([{ enabled: false }]);
  });
});
