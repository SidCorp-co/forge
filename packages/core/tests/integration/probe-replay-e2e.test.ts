/**
 * Each verified deploy replays the kept probes (REQ-36 BC-12; issue-delivery r20 `rule-replay`;
 * ISS-470). A release run's finish, once the deploy is verified against its commit, replays every
 * kept probe of a criterion that passed, on its own roster and on issues earlier releases closed,
 * against the build production serves, and records each result as a verdict on the served identity
 * (criterion 1). A probe the served build now fails is a fail verdict naming the release; a closed
 * issue is reopened and a claimed one goes to reopen instead of closing, each with the failing probe
 * as its reason (criterion 2, a planted regression). A probe that cannot run counts as no pass and
 * keeps its claimed issue from closing; a command probe is never run in core. The replayer's
 * credential goes only to this Forge's own origin, is revoked after, and is written nowhere.
 * Against real Postgres, with production's answers stubbed.
 *
 * @direct-test-of packages/core/src/release-batch/probe-replay.ts
 * @direct-test-of packages/core/src/release-batch/finish.ts
 * @direct-test-of packages/core/src/release-batch/state.ts
 * @direct-test-of packages/core/src/issues/criteria/probe-replay.ts
 * @direct-test-of packages/core/src/issues/criteria/probes.ts
 * @direct-test-of packages/core/src/issues/criteria/probe-rules.ts
 * @direct-test-of packages/core/src/credentials/pat-format.ts
 * @direct-test-of packages/contracts/src/criterion-probes.ts
 * @direct-test-of packages/core/src/project-config/schema.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addVerdict } from '../../src/issues/criteria/service.js';
import type { TransitionActor } from '../../src/issues/index.js';
import type { ProjectDocument } from '../../src/project-config/schema.js';
import { finishReleaseBatch } from '../../src/release-batch/finish.js';
import { readReleaseRunState } from '../../src/release-batch/state.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { releaseWorld, seedProjectDocument, stubProbe } from '../helpers/release-world.js';

const APP = 'https://app.release-fixture.example.test';
const API = 'https://api.release-fixture.example.test';
const JUDGED = 'a'.repeat(40);
const SERVED = 'b'.repeat(40);

let projectId: string;
let ownerId: string;
const fx = releaseWorld(() => ({ projectId, ownerId }));

/** What production answers each path with now; a path not listed is not answered at all. */
let answers: Record<string, () => Response> = {};
/** The `authorization` each request to the API service carried, in order. */
let presented: Array<string | null> = [];

beforeAll(async () => {
  process.env.PUBLIC_API_BASE_URL = API;
  testEnv();
  await import('../../src/index.js');
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  // A finish emits a release whose highlights an outbox consumer drafts after the test returns;
  // truncating under that delivery deadlocks it against the TRUNCATE, so it is let finish first.
  await settleOutbox();
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [] });
  await fx.seedReleaseRunner();
  const [held] = await rows<{ document: ProjectDocument }>(
    sql`SELECT document FROM project_config_documents WHERE project_id = ${projectId}`,
  );
  const live = held?.document.environments.live;
  if (!held || !live) throw new Error('declareProduction wrote no `live` environment');
  await seedProjectDocument(projectId, ownerId, {
    defaultBranch: 'main',
    promotions: held.document.promotions,
    environments: {
      live: { ...live, url: `${APP}/`, services: { api: API }, routes: { api: ['/api/mine'] } },
    },
  });
  answers = {};
  presented = [];
  const route = (url: string) => () => {
    const answer = answers[url];
    if (!answer) throw new TypeError('fetch failed');
    return answer();
  };
  const paths = ['/api/thing', '/api/broken', '/api/old', '/api/mine', '/api/elsewhere'];
  stubProbe(
    Object.fromEntries([
      ...paths.map((p) => [`${APP}${p}`, route(`${APP}${p}`)]),
      ...paths.map((p) => [
        `${API}${p}`,
        () => {
          presented.push(lastAuthorization);
          return route(`${API}${p}`)();
        },
      ]),
    ]),
  );
});

let lastAuthorization: string | null = null;

const actor = (): TransitionActor => ({ type: 'user', id: ownerId, agency: 'human' });

const request = (path: string, over: Record<string, unknown> = {}) => ({
  kind: 'request' as const,
  request: { method: 'GET' as const, path, as: 'anonymous' as const, ...over },
  expect: { status: 200, bodyIncludes: ['"ok":true'] },
});

/** An issue at `status` with one criterion, passed at JUDGED resting on `probe`. */
async function passedWith(status: string, probe: unknown): Promise<string> {
  const id = await fx.insertIssue(status, undefined, true, ['the thing answers']);
  await addVerdict({
    issue: { id, projectId },
    draft: {
      criterion: 1,
      verdict: 'pass',
      reason: 'ran it',
      identity: { kind: 'commit', sha: JUDGED },
      evidence: ['judge.txt'],
      probe: probe as never,
    },
    author: { userId: ownerId, deviceId: null, agency: 'human' },
  });
  return id;
}

type VerdictRow = {
  verdict: string;
  runtime_ref: string | null;
  reason: string | null;
  probe_id: string | null;
};

async function verdictsOf(issueId: string): Promise<VerdictRow[]> {
  return rows<VerdictRow>(sql`
    SELECT verdict, runtime_ref, reason, probe_id FROM criterion_verdicts
     WHERE issue_id = ${issueId} ORDER BY created_at, id`);
}

async function release(issueIds: string[]) {
  const { runId } = await fx.claim(issueIds);
  fx.serve(SERVED);
  const result = await finishReleaseBatch(runId, actor(), { commit: SERVED });
  return { runId, result };
}

describe('a verified deploy replays each kept probe of a passed criterion (criterion 1)', () => {
  it('records each held probe as a verdict on the served identity and closes the claimed issue', async () => {
    answers[`${APP}/api/thing`] = () => Response.json({ ok: true });
    answers[`${APP}/api/old`] = () => Response.json({ ok: true });
    const claimed = await passedWith('awaiting_release', request('/api/thing'));
    const earlier = await passedWith('closed', request('/api/old'));
    const { runId, result } = await release([claimed]);

    expect(result.closed).toEqual([claimed]);
    for (const id of [claimed, earlier]) {
      const [judged, replayed] = await verdictsOf(id);
      expect(replayed).toMatchObject({ verdict: 'pass', runtime_ref: SERVED });
      expect(replayed?.probe_id).toBe(judged?.probe_id);
      expect(replayed?.reason).toContain(`on the served build ${SERVED}: the kept probe held`);
    }
    expect((await fx.stored(earlier)).status).toBe('closed');

    const state = await readReleaseRunState(runId);
    expect(state?.probeReplay).toMatchObject({
      served: SERVED,
      skipped: null,
      reopened: [],
      held: [],
    });
    expect(state?.probeReplay?.results.map((r) => [r.issueId, r.outcome])).toEqual([
      [claimed, 'held'],
      [earlier, 'held'],
    ]);
  });

  it('replays once per run and served commit: a resumed finish writes no second verdict', async () => {
    answers[`${APP}/api/old`] = () => Response.json({ ok: true });
    const earlier = await passedWith('closed', request('/api/old'));
    const other = await fx.insertIssue('awaiting_release');
    const { runId } = await release([other]);
    expect(await verdictsOf(earlier)).toHaveLength(2);
    await finishReleaseBatch(runId, actor(), { commit: SERVED, alreadyVerified: true });
    expect(await verdictsOf(earlier)).toHaveLength(2);
  });

  it('a criterion passed with no probe kept is not replayed', async () => {
    const id = await fx.insertIssue('closed', undefined, true, ['no probe']);
    await addVerdict({
      issue: { id, projectId },
      draft: {
        criterion: 1,
        verdict: 'pass',
        reason: 'looked',
        identity: { kind: 'commit', sha: JUDGED },
        evidence: ['judge.txt'],
      },
      author: { userId: ownerId, deviceId: null, agency: 'human' },
    });
    const other = await fx.insertIssue('awaiting_release');
    const { runId } = await release([other]);
    expect(await verdictsOf(id)).toHaveLength(1);
    expect((await readReleaseRunState(runId))?.probeReplay?.results).toEqual([]);
  });
});

describe('a probe the served build now fails (criterion 2, planted regression)', () => {
  it('writes a fail naming the release, reopens the closed issue and sends the claimed one to reopen', async () => {
    answers[`${APP}/api/thing`] = () => Response.json({ ok: true });
    answers[`${APP}/api/broken`] = () => new Response('boom', { status: 500 });
    answers[`${APP}/api/old`] = () => Response.json({ ok: false });
    const fine = await passedWith('awaiting_release', request('/api/thing'));
    const broken = await passedWith('awaiting_release', request('/api/broken'));
    const regressed = await passedWith('closed', request('/api/old'));
    const { runId, result } = await release([fine, broken]);
    const [run] = await rows<{ version: string }>(
      sql`SELECT release_version AS version FROM pipeline_runs WHERE id = ${runId}`,
    );
    const version = run?.version;
    expect(version).toBeTruthy();

    expect(result.closed).toEqual([fine]);
    expect(result.failed.map((f) => f.id)).toEqual([broken]);
    expect(await fx.stored(broken)).toMatchObject({ status: 'reopen', claim: null });
    expect((await fx.stored(regressed)).status).toBe('reopen');

    const [, brokenFail] = await verdictsOf(broken);
    expect(brokenFail).toMatchObject({ verdict: 'fail', runtime_ref: SERVED });
    expect(brokenFail?.reason).toContain(`release ${version} (run ${runId})`);
    expect(brokenFail?.reason).toContain('GET /api/broken answered 500, and the probe expects 200');
    const [, regressedFail] = await verdictsOf(regressed);
    expect(regressedFail?.reason).toContain('answered 200 without `"ok":true`');

    const reasons = await rows<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${regressed} ORDER BY created_at`,
    );
    expect(reasons.map((r) => r.body).join('\n')).toContain('A kept probe failed on the build');

    const replay = (await readReleaseRunState(runId))?.probeReplay;
    expect(new Set(replay?.reopened)).toEqual(new Set([broken, regressed]));
  });
});

describe('what does not run, and whose credential goes where', () => {
  it('a probe that cannot run counts as no pass and keeps its claimed issue from closing', async () => {
    const unanswered = await passedWith('awaiting_release', request('/api/elsewhere'));
    const { runId, result } = await release([unanswered]);
    expect(result.closed).toEqual([]);
    expect(result.failed[0]?.reason).toContain('could not run');
    expect(await verdictsOf(unanswered)).toHaveLength(1);
    expect((await readReleaseRunState(runId))?.probeReplay).toMatchObject({
      held: [unanswered],
      reopened: [],
    });
  });

  it('a command probe is not replayed in core and does not hold the close', async () => {
    const command = await passedWith('awaiting_release', {
      kind: 'command',
      command: { argv: ['node', 'probe.mjs'] },
      expect: { exitCode: 0 },
    });
    const { runId, result } = await release([command]);
    expect(result.closed).toEqual([command]);
    expect((await readReleaseRunState(runId))?.probeReplay?.results[0]).toMatchObject({
      outcome: 'not_replayed',
      verdictId: null,
    });
  });

  it("sends a minted read-only token only to this Forge's origin, revokes it, and writes it nowhere", async () => {
    answers[`${API}/api/mine`] = () => Response.json({ ok: true });
    answers[`${APP}/api/elsewhere`] = () => Response.json({ ok: true });
    lastAuthorization = null;
    const stubbed = globalThis.fetch;
    globalThis.fetch = wrapAuthorization(stubbed);
    try {
      const mine = await passedWith(
        'awaiting_release',
        request('/api/mine', { service: 'api', as: 'replayer' }),
      );
      const other = await passedWith(
        'awaiting_release',
        request('/api/elsewhere', { as: 'replayer' }),
      );
      const { runId, result } = await release([mine, other]);

      expect(result.closed).toEqual([mine]);
      expect(presented).toHaveLength(1);
      expect(presented[0]).toMatch(/^Bearer \S+$/);
      const token = String(presented[0]).slice('Bearer '.length);
      const minted = await rows<{
        name: string;
        scopes: string[];
        revoked: boolean;
        permissions: string[];
      }>(sql`
        SELECT name, scopes, revoked_at IS NOT NULL AS revoked, permissions FROM personal_access_tokens
         WHERE name LIKE 'probe replay %'`);
      expect(minted).toHaveLength(1);
      expect(minted[0]).toMatchObject({ scopes: ['read'], revoked: true });
      expect(minted[0]?.permissions.every((p) => p.endsWith(':read'))).toBe(true);

      const replay = (await readReleaseRunState(runId))?.probeReplay;
      expect(replay?.results.find((r) => r.issueId === other)?.detail).toContain(
        'the replayer holds one only for this Forge',
      );
      const written = JSON.stringify([replay, await verdictsOf(mine), await verdictsOf(other)]);
      expect(written).not.toContain(token);
    } finally {
      globalThis.fetch = stubbed;
    }
  });
});

describe('the verdict door holds a request to the origin that answers its path', () => {
  /** A forge-shaped production: the web on its `url`, the API as service `api`, routed or not. */
  async function forgeShaped(routes: Record<string, string[]> | null): Promise<void> {
    const [held] = await rows<{ document: ProjectDocument }>(
      sql`SELECT document FROM project_config_documents WHERE project_id = ${projectId}`,
    );
    const live = held?.document.environments.live;
    if (!held || !live) throw new Error('no `live` environment to reshape');
    const { routes: _drop, ...rest } = live;
    await seedProjectDocument(projectId, ownerId, {
      defaultBranch: 'main',
      promotions: held.document.promotions,
      environments: { live: { ...rest, ...(routes ? { routes } : {}) } },
    });
  }

  async function passWith(probe: unknown): Promise<string> {
    const id = await fx.insertIssue('in_progress', undefined, true, ['the thing answers']);
    await addVerdict({
      issue: { id, projectId },
      draft: {
        criterion: 1,
        verdict: 'pass',
        reason: 'ran it',
        identity: { kind: 'commit', sha: JUDGED },
        evidence: ['judge.txt'],
        probe: probe as never,
      },
      author: { userId: ownerId, deviceId: null, agency: 'human' },
    });
    return id;
  }

  it('refuses an API path written with no service, naming the service that answers it', async () => {
    await forgeShaped({ api: ['/api'] });
    await expect(passWith(request('/api/issues/1'))).rejects.toThrow(
      'VERDICT_PROBE_ROUTE: `/api/issues/1` is answered by service `api` (it routes `/api`), not by production environment `live`\'s `url`; send `service: "api"`',
    );
    const named = await passWith(request('/api/issues/1', { service: 'api' }));
    expect(await verdictsOf(named)).toHaveLength(1);
    await expect(passWith(request('/projects/x', { service: 'api' }))).rejects.toThrow(
      'VERDICT_PROBE_ROUTE: service `api` does not route `/projects/x`',
    );
  });

  it('refuses every request where production has services and declares no routes', async () => {
    await forgeShaped(null);
    await expect(passWith(request('/api/issues/1', { service: 'api' }))).rejects.toThrow(
      'production environment `live` declares services (api) and no `routes`',
    );
  });

  it('refuses a service the document does not declare, writing nothing', async () => {
    await forgeShaped({ api: ['/api'] });
    await expect(passWith(request('/api/thing', { service: 'admin' }))).rejects.toThrow(
      'VERDICT_PROBE_ROUTE: production environment `live` declares no service `admin` (it declares api)',
    );
    const [count] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM criterion_verdicts v JOIN issues i ON i.id = v.issue_id
           WHERE i.project_id = ${projectId}`,
    );
    expect(count?.n).toBe(0);
  });
});

/** The fetch the replay calls, noting the `authorization` each request carries before it is answered. */
function wrapAuthorization(inner: typeof fetch): typeof fetch {
  return (async (input: URL | string | Request, init?: RequestInit) => {
    lastAuthorization = new Headers(init?.headers).get('authorization');
    return inner(input, init);
  }) as typeof fetch;
}
