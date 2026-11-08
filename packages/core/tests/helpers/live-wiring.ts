// What a project on forge-dev holds beside its rows that the scale seed (`scale-world.ts`) does not:
// a production environment deployed through a binding, a live master with an open pass, a place in
// an ecosystem, and suggestions waiting on a feedback item and a requirement (ISS-1070 r12). Each
// sends a read of its own that the seed never reached, so a read once a project looked flat here
// while forge-dev's header (`X-Forge-Statement-Shapes`) named it ten or thirteen times. Forge's own
// project also lists feedback reported through the Forge door from other projects' issues.

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { ecosystemDoc } from './ecosystem-world.js';
import { createTestDevice } from './factories.js';
import { seedProduction } from './release-world.js';
import { TRIAGE_ANSWERS } from './triage-answers.js';

/** One ecosystem stewarded by `orgId`, which {@link wireLive} puts each project in. */
export async function seedEcosystem(ownerId: string, orgId: string): Promise<string> {
  const id = randomUUID();
  const code = `W${id.slice(0, 4).toUpperCase()}`;
  const doc = ecosystemDoc(orgId, `wired-${id.slice(0, 8)}`, code);
  doc.ecosystem.id = id;
  await db.execute(sql`
    INSERT INTO ecosystems (id, slug, channel_code, steward_org_id, revision, document, updated_by)
    VALUES (${id}, ${doc.ecosystem.slug}, ${code}, ${orgId}, 1, ${JSON.stringify(doc)}::jsonb, ${ownerId})`);
  return id;
}

/** A deployed commit the stub Coolify records and the stub probe answers. */
export const LIVE_COMMIT = 'c0ffee1'.padEnd(40, '0');

/** How long the stub takes to answer `path`: 40 to 190 ms, the same every time for one path. */
function latencyOf(path: string): number {
  let h = 0;
  for (const c of path) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 40 + (h % 7) * 25;
}

/** Where a wired project's production probe answers: an https address, as a document requires. */
const PROBE_HOST = 'https://probe.live.test';

/**
 * A Coolify and a production probe on one local server, counting every call by its path: each
 * application's deployment list (`/api/v1/deployments/applications/<uuid>`) answers one finished
 * deployment of {@link LIVE_COMMIT}, and each `/commit/<project>` answers that commit (ISS-1070 r13:
 * how often a read asks a project's platform). A probe's https address is sent on to that server by
 * the global `fetch`, so the call is still a real one, counted on `Server-Timing` as any other.
 */
export function liveCoolify() {
  const calls = new Map<string, number>();
  let server: Server | null = null;
  let base = '';
  beforeAll(async () => {
    const s = createServer((req, res) => {
      const path = String(req.url).split('?')[0] ?? '';
      calls.set(path, (calls.get(path) ?? 0) + 1);
      res.setHeader('content-type', 'application/json');
      const deployment = {
        deployment_uuid: `d-${path.split('/').pop()}`,
        status: 'finished',
        created_at: '2026-11-08T08:00:00.000Z',
        commit: LIVE_COMMIT,
      };
      const body = path.startsWith('/commit/')
        ? { commit: LIVE_COMMIT }
        : { count: 1, deployments: [deployment] };
      // each platform answers in its own time, as forge-dev's do: one project's read waits longer
      setTimeout(() => res.end(JSON.stringify(body)), latencyOf(path));
    });
    await new Promise<void>((done) => s.listen(0, '127.0.0.1', done));
    server = s;
    base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const passThrough = globalThis.fetch;
    vi.stubGlobal('fetch', (input: URL | string | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      return url.startsWith(PROBE_HOST)
        ? passThrough(`${base}${url.slice(PROBE_HOST.length)}`, init)
        : passThrough(input, init);
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = null;
  });
  return { url: () => base, calls };
}

/**
 * Wires one seeded project as a forge-dev project is: production deployed through a deploy binding
 * (with `coolify`, one naming an application on it and a source probe answered there; without, no
 * probe and no deploy target, so reading it reaches no network), a live master on a box with an
 * open pass naming an issue, an active membership of `ecosystemId`, and a proposed triage on its
 * first feedback item and breakdown on its first requirement.
 */
export async function wireLive(
  projectId: string,
  ownerId: string,
  ecosystemId: string,
  coolify?: string,
): Promise<void> {
  await seedProduction(
    coolify === undefined
      ? { projectId, ownerId, probes: 'none' }
      : {
          projectId,
          ownerId,
          config: {
            baseUrl: coolify,
            targets: [{ id: 't-live', label: 'live', resourceUuid: `app-${projectId}` }],
          },
          probes: 'source',
          probeUrl: `${PROBE_HOST}/commit/${projectId}`,
          probePath: 'commit',
        },
  );
  const deviceId = await createTestDevice(ownerId);
  const runId = randomUUID();
  const master = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, metadata)
    VALUES (${runId}, ${projectId}, 'system', 'running', now() - interval '1 hour', '{}'::jsonb)`);
  await db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, started_at, created_at, last_heartbeat_at)
    VALUES (${master}, ${projectId}, ${deviceId}, ${runId}, 'master', 'running', now() - interval '1 hour',
            now() - interval '1 hour', now() - interval '10 seconds')`);
  await db.execute(sql`
    INSERT INTO master_passes (project_id, master_session_id, verb, issue_key, started_at)
    VALUES (${projectId}, ${master}, 'dispatch', 'ISS-1', now() - interval '5 minutes')`);
  await db.execute(sql`
    INSERT INTO ecosystem_memberships (ecosystem_id, project_id, state, invited_by, decided_by, decided_at)
    VALUES (${ecosystemId}, ${projectId}, 'active', ${ownerId}, ${ownerId}, now())`);
  const payload = {
    answers: TRIAGE_ANSWERS,
    route: 'issue',
    issue: 'ISS-1',
    note: 'the same crash',
  };
  await db.execute(sql`
    INSERT INTO suggestions (project_id, kind, feedback_id, payload, fingerprint, status, producer_kind)
    SELECT ${projectId}, 'feedback_triage', f.id, ${JSON.stringify(payload)}::jsonb, md5(f.id::text), 'proposed', 'agent'
      FROM feedback f WHERE f.project_id = ${projectId} ORDER BY f.fb_seq LIMIT 1`);
  await db.execute(sql`
    INSERT INTO suggestions (project_id, kind, requirement_id, base_revision, payload, fingerprint, status, producer_kind)
    SELECT ${projectId}, 'breakdown', r.id, r.current_revision, '{"issues":[]}'::jsonb, md5(r.id::text), 'proposed', 'agent'
      FROM requirements r WHERE r.project_id = ${projectId} AND r.current_revision IS NOT NULL
     ORDER BY r.req_seq LIMIT 1`);
}

/**
 * Reports of `home`'s feedback through the Forge door, each from another project and naming one of
 * its issues, as Forge's own feedback is reported from every project on forge-dev.
 */
export async function forgeDoorReports(
  home: string,
  from: readonly string[],
  reportedBy: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO feedback_occurrences (feedback_id, reported_by, reporter_agency, source_project_id, source_issue_id)
    SELECT f.id, ${reportedBy}, 'agent', s.project_id,
           (SELECT i.id FROM issues i WHERE i.project_id = s.project_id ORDER BY i.iss_seq LIMIT 1)
      FROM (SELECT id, row_number() OVER (ORDER BY fb_seq) AS n FROM feedback WHERE project_id = ${home}) f
      JOIN (SELECT p, row_number() OVER () AS n FROM unnest(${sql.param([...from])}::uuid[]) AS p) s(project_id, n)
        ON s.n = f.n`);
}
