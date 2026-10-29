/**
 * ISS-590 (REQ-71 BC-6): naming a release takes project.admin (`release-batch/naming.ts:nameReleaseAs`),
 * so the naming a release owes goes to whoever can take it. A master acting as an account that holds
 * project.admin is asked in its nudge, as before; a master that does not is not asked at all, so an
 * unnamed release never stands in its work pass after pass, and the release's page names the project
 * admins who name it, the steward's own account never among them; where nobody holds it the page says
 * nobody. Driven through the real app on a throwaway Postgres, the master a box serving the project
 * whose checkout's credential an agent member holds. The master's account is the one its pane writes
 * under, never the person who paired its box (round 2, judge K67): forge-dev's box was paired by a
 * person admin, its pane writing as the project's agent, and round 1 asked that master to name.
 *
 * @direct-test-of packages/core/src/steward-ports.ts
 * @direct-test-of packages/core/src/devices/workspace-credential.ts
 * @direct-test-of packages/core/src/steward/ask-addressee.ts
 * @direct-test-of packages/core/src/masters/owed.ts
 * @direct-test-of packages/core/src/release-page/read.ts
 * @direct-test-of packages/core/src/release-page/ports.ts
 * @direct-test-of packages/core/src/release-page/naming-refresh.ts
 * @direct-test-of packages/core/src/release-page/share-source.ts
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { readMasterWork } from '../../src/masters/owed.js';
import { unnamedReleases } from '../../src/release-batch/index.js';
import { backgroundNamingsSettled, nameReleaseIfOwed } from '../../src/release-page/index.js';
import { cutWaitingRelease } from '../../src/schedules/index.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { pairTestBox } from '../helpers/paired-box.js';
import { declareProductionDocument, releaseWorld, SKIP_NOTE } from '../helpers/release-world.js';

let projectId: string;
let orgId: string;
let ownerId: string;
let masterId: string;
let deviceId: string;
let ownerToken: string;
let masterToken: string;
const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true, email: 'ada@test.forge.local' })).id;
  ({ id: projectId, orgId } = await createTestProject(ownerId));
  ownerToken = await userToken(ownerId);
  await fx.seedReleaseRunner();
  const bindingId = await fx.declareProduction({}, 'none');
  await declareProductionDocument({ projectId, ownerId, bindingId, probes: 'none' });
  // the project's master: a box paired as an agent member, its pane writing as that agent
  masterId = (await createTestUser({ kind: 'agent', email: 'box@test.forge.local' })).id;
  await addProjectMember(projectId, masterId, 'member');
  const box = await pairTestBox(projectId, { pairedBy: masterId, actsAs: masterId });
  deviceId = box.deviceId;
  masterToken = box.paneToken as string;
  // the first request starts the queue the cut enqueues on, with no worker draining it
  expect((await as(ownerToken, 'GET', '/releases')).status).toBe(200);
});

afterEach(async () => {
  await backgroundNamingsSettled();
});

const as = (token: string, method: 'GET' | 'PUT', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

/** An unattended cut the assistant cannot name: no chat model is configured on this instance. */
async function unnamedCut(): Promise<string> {
  const issue = await fx.insertIssue('awaiting_release', SKIP_NOTE);
  const outcome = await cutWaitingRelease({ projectId, userId: ownerId, issueIds: [issue] });
  expect(outcome.status, JSON.stringify(outcome)).toBe('success');
  const [row] = [
    ...(await db.execute(
      sql`SELECT release_version FROM pipeline_runs WHERE id = ${String(outcome.runId)}`,
    )),
  ];
  const version = (row as { release_version: string }).release_version;
  expect(await nameReleaseIfOwed(projectId, version)).toBe('missed');
  expect(await unnamedReleases(projectId)).toEqual([{ version }]);
  return version;
}

interface PageHeader {
  name: string | null;
  namer?: unknown;
  naming: { state: string; refusals?: { code: string; detail: string }[] };
}

async function header(version: string, token = masterToken): Promise<PageHeader> {
  const r = await as(token, 'GET', `/releases/${version}/page`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (r.body as { header: PageHeader }).header;
}

const NAMED = {
  name: 'Quiet fixes',
  summary: 'Small fixes nobody sees directly. The release keeps things running smoothly.',
};

describe('a master without project.admin is never asked to name a release (c2)', () => {
  it('leaves the unnamed release out of the master work: not counted, not in the nudge', async () => {
    const version = await unnamedCut();
    const work = await readMasterWork(deviceId, projectId);
    expect(work.owedLine, 'the nudge names no naming the master may not write').not.toContain(
      '/naming',
    );
    expect(work.nudge).not.toContain(version);
    expect(work.owed, 'an unnamed release is not owed to this master').toBe(0);
    // a second sweep reads the same: nothing repeats
    expect((await readMasterWork(deviceId, projectId)).owed).toBe(0);
  });

  it('keeps the rule: the master is still refused naming by name, an admin names it', async () => {
    const version = await unnamedCut();
    const refused = await as(masterToken, 'PUT', `/releases/${version}/naming`, NAMED);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(JSON.stringify(refused.body)).toContain('PERMISSION_FORBIDDEN');
    const named = await as(ownerToken, 'PUT', `/releases/${version}/naming`, NAMED);
    expect(named.status, JSON.stringify(named.body)).toBe(200);
    expect(await unnamedReleases(projectId)).toEqual([]);
    const h = await header(version);
    expect(h.naming).toEqual({ state: 'named' });
    expect(h.namer, 'a named release owes nobody its name').toBeUndefined();
  });
});

describe("the release's page names who names it (c1)", () => {
  it('names the project admins where the master may not, never the master', async () => {
    const version = await unnamedCut();
    const h = await header(version);
    expect(h.naming.state).toBe('failed');
    expect(h.namer).toEqual({ to: 'admins', names: ['ada'] });
    // the refusal the page shows says who names it as the rule has it, never the master by default
    const detail = h.naming.refusals?.map((r) => r.detail).join(' ') ?? '';
    expect(detail).toContain('a project admin names it');
    expect(detail).not.toContain('master names it');
  });

  it('names the master, and asks it in the nudge, where an account it acts as holds project.admin', async () => {
    const version = await unnamedCut();
    await db.execute(
      sql`UPDATE project_members SET role = 'admin' WHERE project_id = ${projectId} AND user_id = ${masterId}`,
    );
    expect((await header(version)).namer).toEqual({ to: 'master' });
    const work = await readMasterWork(deviceId, projectId);
    expect(work.owedLine).toContain(`(${version})`);
    expect(work.owedLine).toContain('releases/<version>/naming -X PUT');
    expect(work.owed).toBe(1);
    const named = await as(masterToken, 'PUT', `/releases/${version}/naming`, NAMED);
    expect(named.status, JSON.stringify(named.body)).toBe(200);
    expect((await readMasterWork(deviceId, projectId)).owed).toBe(0);
  });

  it('freezes a share of the unnamed release with no namer: a share names no person', async () => {
    const version = await unnamedCut();
    expect((await header(version, ownerToken)).namer).toEqual({ to: 'admins', names: ['ada'] });
    const made = await api(ownerToken, 'POST', `/api/projects/${projectId}/shares`, {
      subjectKind: 'release',
      subjectId: version,
      audience: 'link',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const [kept] = [
      ...(await db.execute(sql`SELECT snapshot FROM share_links WHERE project_id = ${projectId}`)),
    ];
    const snapshot = (kept as { snapshot: { header: Record<string, unknown> } }).snapshot;
    expect(snapshot.header.naming).toMatchObject({ state: 'failed' });
    expect(snapshot.header).not.toHaveProperty('namer');
  });

  it('says nobody names it where nobody holds project.admin, and asks the master nothing', async () => {
    const version = await unnamedCut();
    await db.execute(sql`DELETE FROM organization_members WHERE org_id = ${orgId}`);
    expect((await header(version)).namer).toEqual({ to: 'nobody' });
    expect((await readMasterWork(deviceId, projectId)).owed).toBe(0);
  });
});

describe('a box paired by a person admin, its pane writing as the project agent (round 2)', () => {
  /** The project served by a box a person paired, as on forge-dev, in place of the agent's box. */
  async function personPairedBox(actsAs: string | null) {
    await db.execute(sql`DELETE FROM runners WHERE device_id = ${deviceId}`);
    return pairTestBox(projectId, { pairedBy: ownerId, actsAs });
  }

  it('asks the master nothing on any sweep and names the admins, the pane refused naming', async () => {
    const box = await personPairedBox(masterId);
    const version = await unnamedCut();
    const first = await readMasterWork(box.deviceId, projectId);
    const second = await readMasterWork(box.deviceId, projectId);
    expect(first.owedLine, 'c2: the nudge names no naming the pane may not write').not.toContain(
      '/naming',
    );
    expect([first.owed, second.owed], 'c2: not owed on either sweep').toEqual([0, 0]);
    expect((await header(version, ownerToken)).namer, 'c1').toEqual({
      to: 'admins',
      names: ['ada'],
    });
    const refused = await as(box.paneToken as string, 'PUT', `/releases/${version}/naming`, NAMED);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(JSON.stringify(refused.body)).toContain('PERMISSION_FORBIDDEN');
    const named = await as(ownerToken, 'PUT', `/releases/${version}/naming`, NAMED);
    expect(named.status, JSON.stringify(named.body)).toBe(200);
  });

  it('asks the master, and its pane names it, once the agent it writes as holds project.admin', async () => {
    const box = await personPairedBox(masterId);
    const version = await unnamedCut();
    await db.execute(
      sql`UPDATE project_members SET role = 'admin' WHERE project_id = ${projectId} AND user_id = ${masterId}`,
    );
    expect((await header(version, ownerToken)).namer).toEqual({ to: 'master' });
    expect((await readMasterWork(box.deviceId, projectId)).owed).toBe(1);
    const named = await as(box.paneToken as string, 'PUT', `/releases/${version}/naming`, NAMED);
    expect(named.status, JSON.stringify(named.body)).toBe(200);
  });

  it('never takes the person who paired the box for the master where the checkout carries no credential', async () => {
    const box = await personPairedBox(null);
    const version = await unnamedCut();
    expect((await header(version, ownerToken)).namer).toEqual({ to: 'admins', names: ['ada'] });
    expect((await readMasterWork(box.deviceId, projectId)).owed).toBe(0);
  });
});
