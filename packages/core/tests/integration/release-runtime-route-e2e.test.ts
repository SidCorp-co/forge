/**
 * ISS-1346 — on an automatic-release project with no `verify.probes`, what Forge itself deployed
 * through the project's Coolify binding is what a verdict is weighed against; where nothing can
 * report a commit, the project is told once. Real Postgres, and a Coolify that answers deployment
 * records over HTTP, because what is asserted is what a sweep tick leaves on the rows.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { RELEASE_LABEL, releaseBatchFixture } from '../helpers/release-batch-fixture.js';

const SERVED = '33637c612ef15be6f924520c0d201a0889d8ed7e';
const OLDER = '0d98a6be6d9680b967d3f16542eadd25d02602cb';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let coolify: Server;
let coolifyUrl: string;
/** What the fake Coolify answers per deployment uuid: a commit, or an HTTP status to fail with. */
const deployments = new Map<string, string | number>();

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  await registerIntegrationsForTest();
  coolify = createServer((req, res) => {
    const uuid = decodeURIComponent(String(req.url).replace('/api/v1/deployments/', ''));
    const answer = deployments.get(uuid);
    if (answer === undefined || typeof answer === 'number') {
      res.statusCode = typeof answer === 'number' ? answer : 404;
      res.end('{"message":"no"}');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ deployment_uuid: uuid, status: 'finished', commit: answer }));
  });
  await new Promise<void>((done) => coolify.listen(0, '127.0.0.1', done));
  coolifyUrl = `http://127.0.0.1:${(coolify.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((done) => coolify?.close(() => done()));
  if (harness) await harness.cleanup();
});

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

beforeEach(async () => {
  await truncateAll(harness.db);
  deployments.clear();
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  projectId = (
    await createTestProject(harness.db, owner.id, {
      agentConfig: { pipelineConfig: { enabled: true, autoProdDeploy: true } },
    })
  ).id;
  await fx.seedReleaseRunner();
});

interface Target {
  id: string;
  label: string;
  resourceUuid: string;
}
const APP: Target = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };
const API: Target = { id: 't-api', label: 'Api', resourceUuid: 'api-uuid' };
const WEB: Target = { id: 't-web', label: 'Web', resourceUuid: 'web-uuid' };

/** A live Coolify binding declaring no probe, as anhome's and portal-lighthuman's are. */
async function bindCoolify(targets: Target[] = [APP]): Promise<string> {
  await fx.declareProduction({ verify: null, baseUrl: coolifyUrl, targets });
  const rows = (await harness.db.execute(sql`
    SELECT id FROM integration_bindings WHERE project_id = ${projectId}
  `)) as unknown as Array<{ id: string }>;
  return String(rows[0]?.id);
}

/** What `confirm.ts` writes once Coolify says a deployment Forge made has finished. */
async function deployed(
  bindingId: string,
  target: Target,
  uuid: string,
  at: string,
  sent = 'release.requested',
) {
  // A rollback's confirmation carries the label the control gives it, as `controls.ts` writes it.
  const finishedAs =
    sent === 'deploy.rollback.requested' ? `${target.label} rollback` : target.label;
  const request = {
    targetId: target.id,
    targetLabel: target.label,
    resourceUuid: target.resourceUuid,
  };
  await harness.db.execute(sql`
    INSERT INTO integration_deliveries (binding_id, direction, event_name, request_id, status,
                                        payload, response, created_at)
    VALUES (${bindingId}, 'outbound', ${sent}, ${`out:${uuid}`}, 'ok', ${JSON.stringify(request)}::jsonb,
            ${JSON.stringify({ deployment_uuid: uuid, targetId: target.id })}::jsonb, ${at}::timestamptz)
  `);
  await harness.db.execute(sql`
    INSERT INTO integration_deliveries (binding_id, direction, event_name, request_id, status,
                                        payload, created_at)
    VALUES (${bindingId}, 'inbound', 'deploy.succeeded', ${uuid}, 'ok',
            ${JSON.stringify({ source: 'poll', deployment_uuid: uuid, status: 'succeeded', targetLabel: finishedAs })}::jsonb,
            ${at}::timestamptz + interval '2 minutes')
  `);
}

/** A waiting row whose two criteria passed at `commit`, written the way the forge-plugin writes it. */
async function waitingRow(commit: string, mergedAt: string): Promise<string> {
  const id = await fx.insertIssue();
  await harness.db.execute(sql`
    UPDATE issues SET acceptance_criteria = ${'1. ok\n2. ok'}, merged_at = ${mergedAt}::timestamptz,
                      merged_commit_sha = ${commit}
     WHERE id = ${id}
  `);
  const block = (n: number) =>
    [`criterion: ${n} — ok`, 'verdict: pass', `commit: ${commit}`, 'evidence: judge.txt'].join(
      '\n',
    );
  const body = [
    '## Verdict',
    '',
    '```forge-record',
    block(1),
    block(2),
    '```',
    '',
    '`forge-record: verdict · contract 1`',
  ].join('\n');
  await harness.db.execute(sql`
    INSERT INTO comments (id, issue_id, author_id, body) VALUES (${randomUUID()}, ${id}, ${ownerId}, ${body})
  `);
  await harness.db.execute(sql`
    INSERT INTO issue_attachments (id, issue_id, uploader_id, name, path, mime, size)
    VALUES (${randomUUID()}, ${id}, ${ownerId}, 'judge.txt', ${`uploads/${id}`}, 'text/plain', 8)
  `);
  return id;
}

async function holdOf(issueId: string): Promise<Record<string, unknown> | null> {
  const rows = (await harness.db.execute(sql`
    SELECT session_context -> 'releaseHold' AS hold FROM issues WHERE id = ${issueId}
  `)) as unknown as Array<{ hold: Record<string, unknown> | null }>;
  return rows[0]?.hold ?? null;
}

async function holdComments(issueId: string): Promise<number> {
  const rows = (await harness.db.execute(sql`
    SELECT count(*)::int AS n FROM comments WHERE issue_id = ${issueId} AND body LIKE '%release-hold: %'
  `)) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

async function sweep() {
  const { sweepAutomaticReleases } = await import('../../src/pipeline/release-sweep.js');
  const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
  resetSweepCursorsForTest();
  return sweepAutomaticReleases();
}

async function servingNow() {
  const { readServingNow } = await import('../../src/release-batch/serving-reading.js');
  return readServingNow(projectId);
}

describe('what Forge deployed is the reading where no probe is declared', () => {
  it('names the commit of the latest finished Forge deployment of the target, not an older one', async () => {
    const binding = await bindCoolify();
    deployments.set('dep-old', OLDER);
    deployments.set('dep-new', SERVED);
    await deployed(binding, APP, 'dep-old', '2026-09-29T10:00:00Z');
    await deployed(binding, APP, 'dep-new', '2026-09-29T11:00:00Z');

    const reading = await servingNow();

    expect(reading.kind).toBe('serving');
    if (reading.kind !== 'serving') return;
    expect(reading.commits).toEqual([SERVED]);
    expect(reading.hosts.join(' ')).toContain('dep-new');
    expect(reading.hosts.join(' ')).toContain('Coolify target `App` (live)');
  });

  it('names a target with no Forge deployment, and one whose record fails, while the answering one decides', async () => {
    const binding = await bindCoolify([APP, API, WEB]);
    deployments.set('dep-app', SERVED);
    deployments.set('dep-api', 503);
    await deployed(binding, APP, 'dep-app', '2026-09-29T11:00:00Z');
    await deployed(binding, API, 'dep-api', '2026-09-29T11:00:00Z');

    const reading = await servingNow();

    expect(reading.kind).toBe('serving');
    if (reading.kind !== 'serving') return;
    expect(reading.commits).toEqual([SERVED]);
    const unread = reading.unread.join('\n');
    expect(unread).toContain('`Web` (live) has no deployment Forge made and saw finish on record');
    expect(unread).toMatch(/dep-api to Coolify target `Api` \(live\).*could not be read/);
  });

  it('counts a rollback Forge made to the target as what it now runs', async () => {
    const binding = await bindCoolify();
    deployments.set('dep-deploy', SERVED);
    deployments.set('dep-rollback', OLDER);
    await deployed(binding, APP, 'dep-deploy', '2026-09-29T10:00:00Z');
    await deployed(
      binding,
      APP,
      'dep-rollback',
      '2026-09-29T11:00:00Z',
      'deploy.rollback.requested',
    );

    const reading = await servingNow();

    expect(reading.kind === 'serving' ? reading.commits : reading).toEqual([OLDER]);
  });

  // Review 1881fe F2: the label is a name; the target is its id and the resource it points at.
  it('does not carry a deployment of the old resource onto a target repointed under the same label', async () => {
    const binding = await bindCoolify([{ ...APP, resourceUuid: 'new-app-uuid' }]);
    deployments.set('dep-old-resource', SERVED);
    await deployed(binding, APP, 'dep-old-resource', '2026-09-29T11:00:00Z');

    const reading = await servingNow();

    expect(reading.kind).toBe('unreadable');
  });

  it("keeps a target's deployment when only its label changed", async () => {
    const binding = await bindCoolify([{ ...APP, label: 'Frontend' }]);
    deployments.set('dep-renamed', SERVED);
    await deployed(binding, APP, 'dep-renamed', '2026-09-29T11:00:00Z');

    const reading = await servingNow();

    expect(reading.kind === 'serving' ? reading.commits : reading).toEqual([SERVED]);
  });

  it('says unreadable, naming the target, where the route exists and nothing is on record yet', async () => {
    await bindCoolify();
    const reading = await servingNow();
    expect(reading.kind).toBe('unreadable');
    if (reading.kind !== 'unreadable') return;
    expect(reading.why).toContain('`App` (live) has no deployment Forge made and saw finish');
  });
});

describe('a row held before the route existed is carried by the next sweep', () => {
  it('claims a row whose commit: verdicts name what Forge deployed, over the hold it already carried', async () => {
    const binding = await bindCoolify();
    const id = await waitingRow(SERVED, '2026-09-29T09:00:00Z');
    const oldHold = {
      at: '2026-09-28T10:00:00.000Z',
      status: 'awaiting_release',
      code: 'RELEASE_CRITERIA_UNEARNED',
      reason: 'judged against source … but no runtime witnessed it',
      owes: 'human',
      waitingFor: 'a verdict on each criterion named at the running deployment',
    };
    await harness.db.execute(sql`
      UPDATE issues SET session_context = jsonb_build_object('releaseHold', ${JSON.stringify(oldHold)}::jsonb)
       WHERE id = ${id}
    `);
    deployments.set('dep-1', SERVED);
    await deployed(binding, APP, 'dep-1', '2026-09-29T11:00:00Z');

    const result = await sweep();

    expect(result.issuesCut).toBe(1);
    expect((await fx.stored(id)).status).toBe('releasing');
    expect(await holdOf(id)).toBeNull();
  }, 30_000);

  it('holds a row judged at a commit Forge is no longer serving, naming the deployment it read', async () => {
    const binding = await bindCoolify();
    const id = await waitingRow(OLDER, '2026-09-29T09:00:00Z');
    deployments.set('dep-2', SERVED);
    await deployed(binding, APP, 'dep-2', '2026-09-29T11:00:00Z');

    const result = await sweep();

    expect(result.issuesCut).toBe(0);
    const hold = await holdOf(id);
    expect(hold?.code).toBe('RELEASE_CRITERIA_UNEARNED');
    expect(String(hold?.reason)).toContain(SERVED);
    expect(String(hold?.reason)).toContain(
      "Forge's deployment dep-2 to Coolify target `App` (live)",
    );
    expect(String(hold?.reason)).not.toContain('commitUrl');
  }, 30_000);
});

describe('a project nothing can read is told once', () => {
  /** A live binding through a provider whose deployments name no commit. */
  async function bindUnreporting(): Promise<void> {
    const connectionId = randomUUID();
    await harness.db.execute(sql`
      UPDATE projects SET base_branch = 'main',
             release_chain = '[{"branch": "main"}, {"branch": "production", "from": "merge-branch"}]'::jsonb
       WHERE id = ${projectId}
    `);
    await harness.db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
      VALUES (${connectionId}, 'user', ${ownerId}, 'epodsystem', true)
    `);
    await harness.db.execute(sql`
      INSERT INTO integration_bindings (connection_id, project_id, provider, role, stages, active, config)
      VALUES (${connectionId}, ${projectId}, 'epodsystem', 'deploy', ARRAY['live']::text[], true,
              ${JSON.stringify({ releaseRunnerLabel: RELEASE_LABEL })}::jsonb)
    `);
  }

  it('holds every owing row with the unrouted hold, commenting the oldest alone', async () => {
    await bindUnreporting();
    const oldest = await waitingRow(SERVED, '2026-09-27T09:00:00Z');
    const middle = await waitingRow(SERVED, '2026-09-28T09:00:00Z');
    const newest = await waitingRow(OLDER, '2026-09-29T09:00:00Z');

    await sweep();

    for (const id of [oldest, middle, newest]) {
      const hold = await holdOf(id);
      expect(hold?.code).toBe('RELEASE_RUNTIME_UNROUTED');
      expect(String(hold?.reason)).toContain('epodsystem');
    }
    expect(await holdComments(oldest)).toBe(1);
    expect(await holdComments(middle)).toBe(0);
    expect(await holdComments(newest)).toBe(0);

    await sweep();
    expect(await holdComments(oldest)).toBe(1);
  }, 30_000);

  it('answers one project-level blocker naming what is missing, in place of the per-row one', async () => {
    await bindUnreporting();
    await waitingRow(SERVED, '2026-09-27T09:00:00Z');
    await waitingRow(SERVED, '2026-09-28T09:00:00Z');
    const { loadReleaseReadiness } = await import('../../src/release-batch/readiness.js');

    const readiness = await loadReleaseReadiness(projectId);

    const codes = readiness?.blockers.map((b) => b.code) ?? [];
    expect(codes.filter((c) => c === 'RELEASE_RUNTIME_UNROUTED')).toHaveLength(1);
    expect(codes).not.toContain('RELEASE_CRITERIA_UNEARNED');
    const unrouted = readiness?.blockers.find((b) => b.code === 'RELEASE_RUNTIME_UNROUTED');
    expect(unrouted?.message).toContain('epodsystem');
    expect(unrouted?.message).toContain('Held: 2 issue(s)');
  }, 30_000);
});
