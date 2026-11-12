/**
 * A monitoring connection works against the server the owner runs, and refuses by name what that
 * server cannot do (ISS-1225, owner 2026-11-12), through the app against real Postgres and a fake
 * Prometheus status API in the shape the owner's 2.45.0 server answers today: open, no remote-write
 * receiver, no lifecycle, no rule_files, no Alertmanager. A connection holding no credentials is
 * refused; one holding them is read on save and on demand; a binding needing what the server does
 * not do is refused by each missing thing's name, nothing saved; the binding read says alerts cannot
 * reach Forge with no Alertmanager attached; once the server is set up, the binding is taken. Its
 * tokens are minted per connection, shown once and kept hashed, and its setup list names the
 * connection's real doors and no secret.
 *
 * @direct-test-of packages/core/src/integrations/prometheus/readiness.ts
 * @direct-test-of packages/core/src/integrations/prometheus/client.ts
 * @direct-test-of packages/core/src/integrations/prometheus/store.ts
 * @direct-test-of packages/core/src/integrations/prometheus/adapter.ts
 * @direct-test-of packages/core/src/monitoring/connection-admin.ts
 * @direct-test-of packages/core/src/monitoring/setup.ts
 * @direct-test-of packages/core/src/integration-door/connection-routes.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

import { registerAllIntegrations } from '../../src/integration-registry.js';
import { api, type Body } from '../helpers/api.js';
import { addProjectMember, createTestProject, rows } from '../helpers/factories.js';
import {
  type Backend,
  bindInto,
  codeOf,
  codesOf,
  connect,
  door,
  type MonitoringWorld,
  mintTokens,
  PASSWORD,
  type ServerShape,
  seedMonitoringWorld,
  startBackend,
  TODAY,
  WATCHED,
  WIRED,
} from '../helpers/monitoring-world.js';

let w: MonitoringWorld;
let owners: Backend;
let connectionId: string;

beforeAll(async () => {
  registerAllIntegrations();
  w = await seedMonitoringWorld();
  owners = await startBackend();
  owners.shape = { ...TODAY };
  const made = await connect(w.ownerJwt, owners, 'file');
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  connectionId = (made.body.connection as { id: string }).id;
}, 180_000);

afterAll(async () => {
  await w?.backend.close();
  await owners?.close();
});

const connectionRead = (id = connectionId) =>
  api(w.ownerJwt, 'GET', `/api/integration-connections/${id}/monitoring`);

describe('a monitoring connection on the server the owner runs', () => {
  it('holding no credentials is refused MONITORING_SERVER_UNAUTHENTICATED, nothing stored', async () => {
    const before = await api(w.ownerJwt, 'GET', '/api/integration-connections');
    for (const credentials of [{}, { prometheusUser: 'forge' }, { prometheusPassword: PASSWORD }]) {
      const res = await connect(w.ownerJwt, owners, 'file', [], credentials);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(codeOf(res.body)).toBe('MONITORING_SERVER_UNAUTHENTICATED');
    }
    const after = await api(w.ownerJwt, 'GET', '/api/integration-connections');
    expect((after.body.items as unknown[]).length).toBe((before.body.items as unknown[]).length);
  });

  it('is read on save and on demand, as the server answers today', async () => {
    const today = {
      unreadable: null,
      authenticated: false,
      version: '2.45.0',
      remoteWriteReceiver: false,
      lifecycle: false,
      ruleFiles: false,
      discovery: { scrape: false, probe: false },
      alertmanager: false,
    };
    await vi.waitFor(
      async () => expect((await connectionRead()).body.readiness).toMatchObject(today),
      { timeout: 10_000 },
    );
    const now = await api(
      w.ownerJwt,
      'POST',
      `/api/integration-connections/${connectionId}/monitoring/readiness`,
      {},
    );
    expect(now.status, JSON.stringify(now.body)).toBe(200);
    expect(now.body.readiness).toMatchObject(today);
  });
});

/** The server set up for this connection, but for one thing. */
const wiredBut = (over: Partial<ServerShape>): ServerShape => ({
  ...WIRED([connectionId]),
  ...over,
});

describe('a binding asking what the server cannot do is refused by name, nothing saved', () => {
  const cases: [string, () => ServerShape, string[]][] = [
    [
      'today, every missing thing',
      () => ({ ...TODAY }),
      [
        'MONITORING_SERVER_UNAUTHENTICATED',
        'MONITORING_DISCOVERY_NOT_WIRED',
        'MONITORING_DISCOVERY_NOT_WIRED',
        'MONITORING_REMOTE_WRITE_DISABLED',
        'MONITORING_RULES_NOT_WIRED',
        'MONITORING_NO_ALERTMANAGER',
      ],
    ],
    ['an open server', () => wiredBut({ open: true }), ['MONITORING_SERVER_UNAUTHENTICATED']],
    [
      // the server discovers another connection's projects, never this one's
      'no discovery job',
      () => wiredBut({ discovers: [w.connections.mimir] }),
      ['MONITORING_DISCOVERY_NOT_WIRED', 'MONITORING_DISCOVERY_NOT_WIRED'],
    ],
    [
      'no remote-write receiver',
      () => wiredBut({ remoteWrite: false }),
      ['MONITORING_REMOTE_WRITE_DISABLED'],
    ],
    [
      'no rule_files',
      () => wiredBut({ ruleFiles: ['/etc/other/*.yml'] }),
      ['MONITORING_RULES_NOT_WIRED'],
    ],
    ['no lifecycle', () => wiredBut({ lifecycle: false }), ['MONITORING_RULES_NOT_WIRED']],
    ['no Alertmanager', () => wiredBut({ alertmanagers: [] }), ['MONITORING_NO_ALERTMANAGER']],
  ];

  it.each(cases)('%s', async (_, shape, codes) => {
    owners.shape = shape();
    // a project of its own, so a binding a fault let through spoils no other case
    const project = await createTestProject(w.ownerId);
    await addProjectMember(project.id, w.ownerId, 'admin');
    const res = await bindInto(w.ownerJwt, connectionId, [
      { projectId: project.id, target: WATCHED },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codesOf(res.body)).toEqual(codes);
    const held = await api(
      w.ownerJwt,
      'GET',
      `/api/integration-connections/${connectionId}/bindings`,
    );
    expect(
      (held.body.items as { projectId: string }[]).filter((b) => b.projectId === project.id),
    ).toEqual([]);
  });

  it('names what rules miss on a file ruler', async () => {
    owners.shape = wiredBut({ ruleFiles: [], lifecycle: false });
    const res = await bindInto(w.ownerJwt, connectionId, [
      { projectId: w.projects.C.id, target: WATCHED },
    ]);
    const detail = ((res.body.error as Body).refusals as { detail: string }[])[0]?.detail;
    expect(detail).toContain('rule_files names no file under /etc/prometheus/forge-rules');
    expect(detail).toContain('--web.enable-lifecycle');
  });
});

describe('the binding read, and the server once set up', () => {
  it('says alerts cannot reach Forge while no Alertmanager is attached', async () => {
    const project = await createTestProject(w.ownerId);
    await addProjectMember(project.id, w.ownerId, 'admin');
    owners.shape = { ...TODAY };
    // a binding watching nothing asks nothing of the server, and is taken
    const bound = await bindInto(w.ownerJwt, connectionId, [{ projectId: project.id, target: {} }]);
    expect(bound.status, JSON.stringify(bound.body)).toBe(200);
    const read = await api(w.ownerJwt, 'GET', `/api/projects/${project.id}/monitoring`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect((read.body.faults as { code: string }[]).map((f) => f.code)).toContain(
      'MONITORING_NO_ALERTMANAGER',
    );
    expect(read.body.readiness).toMatchObject({ alertmanager: false });
  });

  it('takes the binding once the server is set up', async () => {
    owners.shape = WIRED([connectionId]);
    const res = await bindInto(w.ownerJwt, connectionId, [
      { projectId: w.projects.C.id, target: WATCHED },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const read = await api(w.ownerJwt, 'GET', `/api/projects/${w.projects.C.id}/monitoring`);
    expect(read.body).toMatchObject({ connected: true, faults: [] });
  });
});

describe("the connection's tokens and setup list", () => {
  it('mints each token once, keeps its hash, and a new one replaces the old', async () => {
    owners.shape = WIRED([connectionId]);
    const first = await mintTokens(w.ownerJwt, connectionId);
    expect(first.sd).toMatch(/^fms_[A-Za-z0-9_-]{43}$/);
    expect(first.alerts).toMatch(/^fma_[A-Za-z0-9_-]{43}$/);
    const read = await connectionRead();
    expect(JSON.stringify(read.body)).not.toContain(first.sd);
    expect(read.body.tokens).toMatchObject({
      sd: { prefix: first.sd.slice(0, 12) },
      alerts: { prefix: first.alerts.slice(0, 12) },
    });
    const [stored] = await rows<{ sd: string; alerts: string }>(
      sql`SELECT sd_token_hash AS sd, alerts_token_hash AS alerts FROM monitoring_connections WHERE connection_id = ${connectionId}`,
    );
    expect(stored?.sd).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.alerts).toMatch(/^[0-9a-f]{64}$/);

    const second = await mintTokens(w.ownerJwt, connectionId);
    const targets = door(connectionId, 'targets?job=scrape');
    expect((await api(first.sd, 'GET', targets)).status).toBe(401);
    expect((await api(second.sd, 'GET', targets)).status).toBe(200);

    const stranger = await api(
      w.memberJwt,
      'POST',
      `/api/integration-connections/${connectionId}/monitoring/tokens/sd`,
      {},
    );
    expect(stranger.status).not.toBe(201);
  });

  it("renders the server's changes with the connection's doors and no secret", async () => {
    const minted = await mintTokens(w.ownerJwt, connectionId);
    const res = await api(
      w.ownerJwt,
      'GET',
      `/api/integration-connections/${connectionId}/monitoring/setup`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const steps = res.body.steps as { step: string; content: string }[];
    expect([...new Set(steps.map((s) => s.step))]).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    const all = steps.map((s) => s.content).join('\n');
    for (const directive of [
      'basic_auth_users:',
      '--web.config.file=/etc/prometheus/web.yml',
      '--web.enable-remote-write-receiver',
      '--web.enable-lifecycle',
      `/api/monitoring/connections/${connectionId}/targets?job=scrape`,
      `/api/monitoring/connections/${connectionId}/targets?job=probe`,
      'replacement: blackbox-exporter:9115',
      '- /etc/prometheus/forge-rules/*.yml',
      'promtool check rules',
      '/-/reload',
      'group_by: [forge_project, alertname]',
      `/api/monitoring/connections/${connectionId}/alerts`,
      'send_resolved: true',
      'credentials_file: /etc/alertmanager/forge-alerts-token',
      'prom/alertmanager:v0.28.1',
    ]) {
      expect(all).toContain(directive);
    }
    for (const secret of [minted.sd, minted.alerts, PASSWORD]) {
      expect(JSON.stringify(res.body)).not.toContain(secret);
    }
  });
});
