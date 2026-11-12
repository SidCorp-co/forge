/**
 * Production monitoring as a Forge integration (ISS-1225 c2, owner ruling 2026-11-12), through the
 * app against real Postgres and a monitoring backend on loopback. A project binds a monitoring
 * connection with role `monitoring`: a rule of an unknown kind, a target not its own, a `for` under
 * two evaluations or a taken name is refused by name with nothing saved, and so are rules on a
 * connection whose backend takes none and rules its ruler refuses. Each rule kind renders scoped to
 * its project with its `for`, and is pushed to a mimir ruler or served for a file ruler to pull. The
 * connection's Prometheus discovers only its own projects' targets, each labelled with its project.
 *
 * @direct-test-of packages/core/src/integrations/prometheus/adapter.ts
 * @direct-test-of packages/core/src/integrations/prometheus/render.ts
 * @direct-test-of packages/core/src/integrations/prometheus/client.ts
 * @direct-test-of packages/core/src/integrations/prometheus/store.ts
 * @direct-test-of packages/core/src/monitoring/routes.ts
 * @direct-test-of packages/core/src/monitoring/project-routes.ts
 * @direct-test-of packages/core/src/monitoring/connections.ts
 * @direct-test-of packages/contracts/src/monitoring.ts
 * @direct-test-of packages/core/src/project-config/documents.ts
 * @direct-test-of packages/core/src/project-config/bind-effects.ts
 * @direct-test-of packages/core/src/project-config/schema.ts
 * @direct-test-of packages/core/src/db/release-axes.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // a monitoring connection's tokens are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

import { registerAllIntegrations } from '../../src/integration-registry.js';
import { api, type Body } from '../helpers/api.js';
import {
  bindingOf,
  codeOf,
  connect,
  door,
  type MonitoringWorld,
  PASSWORD,
  rebind,
  seedMonitoringWorld,
  USER,
  WATCHED,
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
  w.backend.pushed.length = 0;
  w.backend.deleted.length = 0;
  w.backend.refusePush = false;
});

const api1 = { name: 'api', url: 'https://api.example.test/metrics' };

describe('a monitoring binding is refused by name, nothing saved (c2)', () => {
  const cases: [string, Body][] = [
    [
      'MONITORING_RULE_KIND_UNKNOWN',
      {
        scrape: [api1],
        rules: [{ name: 'r', kind: 'raw_promql', target: 'api', for: '1m', severity: 'low' }],
      },
    ],
    [
      'MONITORING_RULE_TARGET_UNKNOWN',
      {
        scrape: [api1],
        rules: [{ name: 'r', kind: 'target_down', target: 'theirs', for: '1m', severity: 'low' }],
      },
    ],
    [
      'MONITORING_RULE_TARGET_UNKNOWN',
      {
        // the host agent's series, while this project runs no agent
        rules: [
          {
            name: 'd',
            kind: 'disk_free_below',
            target: 'agent',
            threshold: 0.1,
            for: '1m',
            severity: 'low',
          },
        ],
      },
    ],
    [
      'MONITORING_FOR_TOO_SHORT',
      {
        scrape: [api1],
        rules: [{ name: 'r', kind: 'target_down', target: 'api', for: '59s', severity: 'low' }],
      },
    ],
    ['MONITORING_NAME_TAKEN', { scrape: [api1, { ...api1, url: 'https://b.example.test/m' }] }],
  ];

  it.each(cases)('%s', async (code, watched) => {
    const before = await bindingOf(w.ownerJwt, w.projects.A.id, w.bindings.A);
    const res = await rebind(w.ownerJwt, w.projects.A.id, w.bindings.A, watched);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codeOf(res.body)).toBe(code);
    expect(await bindingOf(w.ownerJwt, w.projects.A.id, w.bindings.A)).toEqual(before);
    expect(w.backend.pushed).toHaveLength(0);
  });

  it('rules on a connection whose ruler is none: MONITORING_BACKEND_TAKES_NO_RULES', async () => {
    const res = await connect(w.ownerJwt, w.backend, 'none', [
      {
        projectId: w.projects.C.id,
        target: {
          scrape: [api1],
          rules: [{ name: 'r', kind: 'target_down', target: 'api', for: '1m', severity: 'low' }],
        },
      },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codeOf(res.body)).toBe('MONITORING_BACKEND_TAKES_NO_RULES');
    const read = await api(w.memberJwt, 'GET', `/api/projects/${w.projects.C.id}/monitoring`);
    expect(read.body).toMatchObject({ connected: false, registered: null });
  });

  it('rules the ruler refuses: MONITORING_RULES_REFUSED, nothing saved', async () => {
    const before = await bindingOf(w.ownerJwt, w.projects.B.id, w.bindings.B);
    w.backend.refusePush = true;
    const res = await rebind(w.ownerJwt, w.projects.B.id, w.bindings.B, {
      scrape: [api1],
      rules: [{ name: 'down', kind: 'target_down', target: 'api', for: '5m', severity: 'high' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(codeOf(res.body)).toBe('MONITORING_RULES_REFUSED');
    expect(await bindingOf(w.ownerJwt, w.projects.B.id, w.bindings.B)).toEqual(before);
  });

  it('a monitoring connection bound under another role: BINDING_ROLE_UNSUPPORTED', async () => {
    const res = await api(w.ownerJwt, 'POST', '/api/integration-connections', {
      provider: 'prometheus',
      config: { prometheusUrl: w.backend.url, prometheusUser: USER, ruler: 'file' },
      secrets: { prometheusPassword: PASSWORD },
      bindings: [
        { projectId: w.projects.C.id, role: 'service', target: { provider: 'prometheus' } },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codeOf(res.body)).toBe('BINDING_ROLE_UNSUPPORTED');
  });
});

describe('what core renders for the connection (c2)', () => {
  it('each rule kind is pushed scoped to its project, carrying its `for` and project label', async () => {
    const res = await rebind(w.ownerJwt, w.projects.A.id, w.bindings.A, WATCHED);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(w.backend.pushed).toHaveLength(1);
    const slug = w.projects.A.slug;
    const group = w.backend.pushed[0] as {
      name: string;
      rules: { alert: string; expr: string; for: string; labels: Body }[];
    };
    expect(group.name).toBe(`forge-${slug}`);
    expect(group.rules.map((r) => r.alert)).toEqual(WATCHED.rules.map((r) => r.name));
    const own = `forge_project="${slug}"`;
    for (const [i, rule] of group.rules.entries()) {
      const declared = WATCHED.rules[i] as { for: string; severity: string };
      expect(rule.for).toBe(declared.for);
      expect(rule.labels).toMatchObject({ forge_project: slug, severity: declared.severity });
      const selectors = rule.expr.match(/\{[^}]*\}/g) ?? [];
      expect(selectors.length).toBeGreaterThan(0);
      for (const s of selectors) expect(s).toContain(own);
    }
    const expr = (name: string) => group.rules.find((r) => r.alert === name)?.expr;
    expect(expr('api-down')).toBe(`up{${own},forge_target="api"} == 0`);
    expect(expr('home-down')).toBe(`probe_success{${own},forge_target="home"} == 0`);
    expect(expr('slow')).toBe(
      `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{${own},forge_target="api"}[5m]))) > 1.5`,
    );
    expect(expr('errors')).toContain(`http_requests_total{${own},code=~"5.."}`);
    expect(expr('errors')).toMatch(/> 0\.05$/);
    expect(expr('disk')).toMatch(
      /^node_filesystem_avail_bytes\{.*\} \/ node_filesystem_size_bytes\{.*\} < 0\.1$/,
    );
    expect(expr('queue')).toBe(`queue_depth{${own},forge_target="api"} > 100`);

    const read = await api(w.memberJwt, 'GET', `/api/projects/${w.projects.A.id}/monitoring`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({
      connected: true,
      ruler: 'mimir',
      registered: WATCHED,
      rulesLoaded: true,
      alerts: [],
      faults: [],
    });
  });

  it("a file ruler pulls its own projects' groups; a none ruler holds none", async () => {
    const file = await api(w.tokens.file.sd, 'GET', door(w.connections.file, 'rules'));
    expect(file.status, JSON.stringify(file.body)).toBe(200);
    // the file is JSON, which YAML reads as it is
    const groups = (file.body as unknown as { groups: { name: string }[] }).groups;
    expect(groups.map((g) => g.name)).toEqual([`forge-${w.projects.D.slug}`]);

    const none = await api(w.tokens.none.sd, 'GET', door(w.connections.none, 'rules'));
    expect(codeOf(none.body)).toBe('MONITORING_BACKEND_TAKES_NO_RULES');
  });

  it("service discovery serves the connection's own projects, each target labelled with its own", async () => {
    await rebind(w.ownerJwt, w.projects.A.id, w.bindings.A, WATCHED);
    const scrape = await api(
      w.tokens.mimir.sd,
      'GET',
      door(w.connections.mimir, 'targets?job=scrape'),
    );
    expect(scrape.status, JSON.stringify(scrape.body)).toBe(200);
    const groups = scrape.body as unknown as { targets: string[]; labels: Body }[];
    expect(groups.filter((g) => g.labels.forge_project === w.projects.A.slug)).toEqual([
      {
        targets: ['api.example.test:9100'],
        labels: {
          forge_project: w.projects.A.slug,
          forge_target: 'api',
          __scheme__: 'https',
          __metrics_path__: '/metrics',
          __param_x: '1',
          __scrape_interval__: '1m',
        },
      },
    ]);
    const projects = new Set(groups.map((g) => g.labels.forge_project));
    expect(projects).toEqual(new Set([w.projects.A.slug, w.projects.B.slug]));

    const probe = await api(
      w.tokens.mimir.sd,
      'GET',
      door(w.connections.mimir, 'targets?job=probe'),
    );
    expect(probe.body).toEqual([
      {
        targets: ['https://www.example.test/'],
        labels: {
          forge_project: w.projects.A.slug,
          forge_target: 'home',
          __param_module: 'http_2xx',
        },
      },
    ]);

    const other = await api(
      w.tokens.file.sd,
      'GET',
      door(w.connections.file, 'targets?job=scrape'),
    );
    expect(
      (other.body as unknown as { labels: Body }[]).map((g) => g.labels.forge_project),
    ).toEqual([w.projects.D.slug]);

    // the alerts token, or another connection's sd token, discovers nothing here
    for (const token of ['not-the-token', w.tokens.mimir.alerts, w.tokens.file.sd]) {
      const wrong = await api(token, 'GET', door(w.connections.mimir, 'targets?job=scrape'));
      expect(wrong.status).toBe(401);
      expect(codeOf(wrong.body)).toBe('MONITORING_TOKEN_INVALID');
    }
  });
});
