/**
 * Forge's doors of a monitoring connection (ISS-1225 c3, c4), through the app against real Postgres
 * and a monitoring backend on loopback. A host agent's remote write is forwarded to its project's
 * connection only under that project's agent token and only with that project's label; a foreign
 * series, a bad token or a project binding no connection forwards nothing, by name. A firing alert
 * the connection's Alertmanager posts with its alerts token files ONE feedback item on the project its own label names
 * among the connection's projects, seen on `monitoring`; a repeat joins it, and its resolution is
 * recorded on it.
 *
 * @direct-test-of packages/core/src/monitoring/routes.ts
 * @direct-test-of packages/core/src/monitoring/project-routes.ts
 * @direct-test-of packages/core/src/monitoring/alerts.ts
 * @direct-test-of packages/core/src/monitoring/agent-tokens.ts
 * @direct-test-of packages/core/src/monitoring/remote-write.ts
 * @direct-test-of packages/core/src/monitoring/connections.ts
 * @direct-test-of packages/core/src/integrations/prometheus/client.ts
 * @direct-test-of packages/core/src/integrations/prometheus/store.ts
 * @direct-test-of packages/core/src/db/schema-monitoring.ts
 * @direct-test-of packages/core/src/feedback/signal-filing.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // a monitoring connection's tokens are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

import { app } from '../../src/index.js';
import { registerAllIntegrations } from '../../src/integration-registry.js';
import { api, type Body } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import {
  codeOf,
  door,
  type MonitoringWorld,
  remoteWrite,
  seedMonitoringWorld,
} from '../helpers/monitoring-world.js';

let w: MonitoringWorld;

beforeAll(async () => {
  registerAllIntegrations();
  w = await seedMonitoringWorld();
}, 180_000);

afterAll(async () => {
  await w?.backend.close();
});

beforeEach(() => {
  w.backend.writes.length = 0;
});

async function post(token: string, body: Uint8Array) {
  const res = await app.fetch(
    new Request('http://forge.test/api/monitoring/write', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-protobuf',
        'content-encoding': 'snappy',
      },
      body,
    }),
  );
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Body };
}

const mint = (projectId: string, jwt = w.ownerJwt) =>
  api(jwt, 'POST', `/api/projects/${projectId}/monitoring/agent-token`, {});

describe("a host agent's remote write (c3)", () => {
  let tokenA: string;

  beforeAll(async () => {
    const minted = await mint(w.projects.A.id);
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    tokenA = minted.body.token as string;
    expect(tokenA).toMatch(/^fmt_[A-Za-z0-9_-]{43}$/);
    const [stored] = await rows<{ token_hash: string }>(
      sql`SELECT token_hash FROM monitoring_agent_tokens WHERE project_id = ${w.projects.A.id}`,
    );
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is minted by an admin of a project that binds a connection, and by nobody else', async () => {
    expect((await mint(w.projects.A.id, w.memberJwt)).status).toBe(403);
    const unbound = await mint(w.projects.C.id);
    expect(unbound.status, JSON.stringify(unbound.body)).toBe(409);
    expect(codeOf(unbound.body)).toBe('MONITORING_NOT_CONNECTED');
  });

  it("is forwarded as sent to its connection when every series is its own project's", async () => {
    const body = remoteWrite([w.projects.A.slug, w.projects.A.slug]);
    const res = await post(tokenA, body);
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(w.backend.writes).toHaveLength(1);
    expect((w.backend.writes[0] as Buffer).equals(Buffer.from(body))).toBe(true);
  });

  it('a series labelled with another project, or none, is refused and nothing is forwarded', async () => {
    for (const slugs of [[w.projects.A.slug, w.projects.B.slug], [null]]) {
      const res = await post(tokenA, remoteWrite(slugs));
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(codeOf(res.body)).toBe('MONITORING_SERIES_FOREIGN_PROJECT');
    }
    expect(w.backend.writes).toHaveLength(0);
  });

  it('a bad token, or a replaced one, is refused and nothing is forwarded', async () => {
    const bad = await post(
      'fmt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      remoteWrite([w.projects.A.slug]),
    );
    expect(bad.status).toBe(401);
    expect(codeOf(bad.body)).toBe('MONITORING_TOKEN_INVALID');

    const old = tokenA;
    tokenA = (await mint(w.projects.A.id)).body.token as string;
    const replaced = await post(old, remoteWrite([w.projects.A.slug]));
    expect(replaced.status).toBe(401);
    expect(w.backend.writes).toHaveLength(0);
  });
});

interface Filed {
  id: string;
  project_id: string;
  where_seen: string | null;
}

const filedFor = (fingerprint: string) =>
  rows<Filed>(
    sql`SELECT id, project_id, where_seen FROM feedback WHERE signal_key = ${`monitoring:${fingerprint}`}`,
  );
const saidOn = async (feedbackId: string) =>
  (
    await rows<{ said: string | null }>(
      sql`SELECT said FROM feedback_occurrences WHERE feedback_id = ${feedbackId} ORDER BY created_at`,
    )
  ).map((r) => r.said);

const alert = (slug: string, fingerprint: string, status: 'firing' | 'resolved' = 'firing') => ({
  status,
  labels: { alertname: 'api-down', forge_project: slug, severity: 'high' },
  annotations: { summary: 'target_down on api' },
  startsAt: '2026-11-12T08:00:00Z',
  endsAt: status === 'resolved' ? '2026-11-12T08:30:00Z' : '0001-01-01T00:00:00Z',
  generatorURL: 'http://prometheus:9090/graph',
  fingerprint,
});

describe('an alert becomes ONE feedback item on its own project (c4)', () => {
  const deliver = (alerts: unknown[], token = w.tokens.mimir.alerts) =>
    api(token, 'POST', door(w.connections.mimir, 'alerts'), { version: '4', alerts });

  it('firing twice files one item, seen on monitoring, and its resolution is recorded on it', async () => {
    const first = await deliver([alert(w.projects.A.slug, 'a1b2c3')]);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((first.body.alerts as Body[])[0]).toMatchObject({
      act: 'filed',
      project: w.projects.A.slug,
    });
    const again = await deliver([alert(w.projects.A.slug, 'a1b2c3')]);
    expect((again.body.alerts as Body[])[0]).toMatchObject({ act: 'joined' });

    const items = await filedFor('a1b2c3');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ project_id: w.projects.A.id, where_seen: 'monitoring' });

    const resolved = await deliver([alert(w.projects.A.slug, 'a1b2c3', 'resolved')]);
    expect((resolved.body.alerts as Body[])[0]).toMatchObject({ act: 'resolved' });
    expect(await filedFor('a1b2c3')).toHaveLength(1);
    const said = await saidOn((items[0] as Filed).id);
    expect(said.at(-1)).toBe('Resolved at 2026-11-12T08:30:00Z.');
  });

  it("an alert lands on the project its own label names, never another's", async () => {
    const res = await deliver([
      alert(w.projects.B.slug, 'b0b0b0'),
      alert(w.projects.A.slug, 'a0a0a0'),
    ]);
    expect(res.status).toBe(200);
    expect((await filedFor('b0b0b0'))[0]?.project_id).toBe(w.projects.B.id);
    expect((await filedFor('a0a0a0'))[0]?.project_id).toBe(w.projects.A.id);
  });

  it('an alert naming a project not bound to the posting connection files nothing, by name', async () => {
    // D is bound to the file connection, never the mimir one that posts here
    const res = await deliver([alert(w.projects.D.slug, 'c0c0c0'), alert('no-such', 'c1c1c1')]);
    expect(res.status).toBe(422);
    expect(codeOf(res.body)).toBe('MONITORING_ALERT_PROJECT_UNKNOWN');
    expect(await filedFor('c0c0c0')).toHaveLength(0);
    expect(await filedFor('c1c1c1')).toHaveLength(0);

    // a bad bearer, the connection's sd token, or another connection's alerts token posts nothing
    for (const token of ['not-the-token', w.tokens.mimir.sd, w.tokens.file.alerts]) {
      const bad = await deliver([alert(w.projects.A.slug, 'd0d0d0')], token);
      expect(bad.status).toBe(401);
      expect(codeOf(bad.body)).toBe('MONITORING_TOKEN_INVALID');
    }
    expect(await filedFor('d0d0d0')).toHaveLength(0);
  });
});
