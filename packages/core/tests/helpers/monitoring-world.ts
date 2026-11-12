// The fixtures of the monitoring e2e (ISS-1225): a monitoring backend served on loopback (a Prometheus
// and a Mimir ruler in one) that records what core sends it, can be told to refuse a rule push, and
// answers the status API in a shape its test sets: open or behind basic auth, each flag, its
// rule_files, Forge's discovery jobs and its Alertmanagers, as the owner's 2.45.0 server answers
// today (`TODAY`) or set up (`WIRED`). Beside it, a project's full monitoring target with one rule of
// every kind, and a remote-write body as a host agent's Prometheus encodes one.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import protobuf from 'protobufjs';
import { compress } from 'snappyjs';
import { expect } from 'vitest';
import { api, type Body, userToken } from './api.js';
import { addProjectMember, createTestProject, createTestUser } from './factories.js';

/** What the fake server's status API answers. */
export interface ServerShape {
  /** Answers without credentials; otherwise only `USER` with `PASSWORD`. */
  open: boolean;
  remoteWrite: boolean;
  lifecycle: boolean;
  ruleFiles: string[];
  /** The connections whose Forge discovery jobs its config holds. */
  discovers: string[];
  alertmanagers: string[];
}

export const USER = 'forge';
export const PASSWORD = 'correct horse battery staple';

/** The owner's server as read on 2026-11-12: open, every flag off, no rule_files, no Alertmanager. */
export const TODAY: ServerShape = {
  open: true,
  remoteWrite: false,
  lifecycle: false,
  ruleFiles: [],
  discovers: [],
  alertmanagers: [],
};

/** The same server after its setup list, discovering `connectionIds`. */
export const WIRED = (connectionIds: string[]): ServerShape => ({
  open: false,
  remoteWrite: true,
  lifecycle: true,
  ruleFiles: ['/etc/prometheus/forge-rules/*.yml'],
  discovers: connectionIds,
  alertmanagers: ['http://alertmanager:9093/api/v2/alerts'],
});

/** Prometheus' own rendering of a config in this shape: top-level lists unindented, as yaml.v2 writes. */
function configYaml(shape: ServerShape): string {
  const lines = ['global:', '  scrape_interval: 1m', '  evaluation_interval: 1m'];
  if (shape.ruleFiles.length) lines.push('rule_files:', ...shape.ruleFiles.map((f) => `- ${f}`));
  lines.push('scrape_configs:', '- job_name: prometheus', '  static_configs:', '  - targets:');
  lines.push('    - localhost:9090');
  for (const id of shape.discovers) {
    for (const job of ['scrape', 'probe']) {
      lines.push(`- job_name: forge-${job}`, '  http_sd_configs:');
      lines.push(`  - url: http://forge.test/api/monitoring/connections/${id}/targets?job=${job}`);
      lines.push('    authorization:', '      type: Bearer', '      credentials_file: /etc/x');
    }
  }
  return `${lines.join('\n')}\n`;
}

export interface Backend {
  url: string;
  shape: ServerShape;
  /** Rule groups pushed to the ruler, in order, as sent. */
  pushed: Body[];
  deleted: string[];
  /** Remote writes forwarded, as sent. */
  writes: Buffer[];
  /** While set, the ruler refuses every push 400. */
  refusePush: boolean;
  close(): Promise<void>;
}

export async function startBackend(): Promise<Backend> {
  const held = new Map<string, Body>();
  const backend: Omit<Backend, 'url' | 'close'> = {
    shape: { ...TODAY },
    pushed: [],
    deleted: [],
    writes: [],
    refusePush: false,
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = String(req.url).split('?')[0] ?? '';
      const body = Buffer.concat(chunks);
      const json = (status: number, value: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(value));
      };
      const basic = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;
      if (!backend.shape.open && req.headers.authorization !== basic) {
        return json(401, { error: 'Unauthorized' });
      }
      const status = {
        '/api/v1/status/buildinfo': { version: '2.45.0', revision: '8ef767e', branch: 'HEAD' },
        '/api/v1/status/flags': {
          'web.enable-lifecycle': String(backend.shape.lifecycle),
          'web.enable-remote-write-receiver': String(backend.shape.remoteWrite),
          'config.file': '/etc/prometheus/prometheus.yml',
        },
        '/api/v1/status/config': { yaml: configYaml(backend.shape) },
        '/api/v1/alertmanagers': {
          activeAlertmanagers: backend.shape.alertmanagers.map((url) => ({ url })),
          droppedAlertmanagers: [],
        },
      }[path];
      if (status) return json(200, { status: 'success', data: status });
      if (req.method === 'POST' && path === '/prometheus/config/v1/rules/forge') {
        if (backend.refusePush) return json(400, { error: 'group failed to load' });
        const group = JSON.parse(body.toString('utf8')) as Body;
        backend.pushed.push(group);
        held.set(group.name as string, group);
        return json(202, {});
      }
      if (req.method === 'DELETE' && path.startsWith('/prometheus/config/v1/rules/forge/')) {
        const name = decodeURIComponent(path.split('/').at(-1) ?? '');
        backend.deleted.push(name);
        held.delete(name);
        return json(202, {});
      }
      if (path === '/api/v1/rules') {
        return json(200, { status: 'success', data: { groups: [...held.values()] } });
      }
      if (path === '/api/v1/alerts') return json(200, { status: 'success', data: { alerts: [] } });
      if (req.method === 'POST' && path === '/api/v1/write') {
        backend.writes.push(body);
        res.statusCode = 204;
        return res.end();
      }
      if (path === '/-/ready' || path === '/-/healthy') return json(200, {});
      return json(404, { error: `no ${req.method} ${path}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(backend, {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

/** A monitoring connection whose backend is `backend`, bound into `bindings` in the same call. */
export async function connect(
  token: string,
  backend: Backend,
  ruler: 'mimir' | 'file' | 'none',
  bindings: { projectId: string; target: Body }[] = [],
  credentials: { prometheusUser?: string; prometheusPassword?: string } = {
    prometheusUser: USER,
    prometheusPassword: PASSWORD,
  },
): Promise<{ status: number; body: Body }> {
  const { prometheusUser, prometheusPassword } = credentials;
  return api(token, 'POST', '/api/integration-connections', {
    provider: 'prometheus',
    displayName: `prometheus ${ruler}`,
    config: {
      prometheusUrl: backend.url,
      ruler,
      ...(prometheusUser ? { prometheusUser } : {}),
      ...(ruler === 'mimir' ? { rulerUrl: backend.url } : {}),
    },
    secrets: prometheusPassword ? { prometheusPassword } : {},
    ...(bindings.length === 0 ? {} : { bindings: bindings.map(asBinding) }),
  });
}

const asBinding = (b: { projectId: string; target: Body }) => ({
  projectId: b.projectId,
  role: 'monitoring',
  target: { provider: 'prometheus', ...b.target },
});

/** Bind an existing connection into `bindings`, as one write. */
export const bindInto = (
  token: string,
  connectionId: string,
  bindings: { projectId: string; target: Body }[],
) =>
  api(token, 'POST', `/api/integration-connections/${connectionId}/bindings`, {
    bindings: bindings.map(asBinding),
  });

/** Mint the connection's sd and alerts tokens. */
export async function mintTokens(token: string, connectionId: string) {
  const mint = async (kind: 'sd' | 'alerts') => {
    const res = await api(
      token,
      'POST',
      `/api/integration-connections/${connectionId}/monitoring/tokens/${kind}`,
      {},
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.token as string;
  };
  return { sd: await mint('sd'), alerts: await mint('alerts') };
}

/** A door of the connection, by path. */
export const door = (connectionId: string, path: string) =>
  `/api/monitoring/connections/${connectionId}/${path}`;

/** The binding document a project holds now, and its revision. */
export async function bindingOf(
  token: string,
  projectId: string,
  bindingId: string,
): Promise<{ revision: number; document: Body }> {
  const read = await api(token, 'GET', `/api/projects/${projectId}/bindings/${bindingId}`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return { revision: read.body.revision as number, document: read.body.document as Body };
}

/** Rewrite the binding's target with `watched`, at the revision it holds. */
export async function rebind(token: string, projectId: string, bindingId: string, watched: Body) {
  const held = await bindingOf(token, projectId, bindingId);
  return api(token, 'PUT', `/api/projects/${projectId}/bindings/${bindingId}`, {
    baseRevision: held.revision,
    document: { ...held.document, target: { provider: 'prometheus', ...watched } },
  });
}

export const WATCHED = {
  scrape: [{ name: 'api', url: 'https://api.example.test:9100/metrics?x=1', interval: '1m' }],
  probe: [{ name: 'home', url: 'https://www.example.test/' }],
  agent: { enabled: true },
  rules: [
    { name: 'api-down', kind: 'target_down', target: 'api', for: '2m', severity: 'high' },
    { name: 'home-down', kind: 'probe_failed', target: 'home', for: '1m', severity: 'high' },
    {
      name: 'slow',
      kind: 'latency_quantile_above',
      target: 'api',
      metric: 'http_request_duration_seconds',
      quantile: 0.95,
      threshold: 1.5,
      for: '5m',
      severity: 'medium',
    },
    {
      name: 'errors',
      kind: 'error_ratio_above',
      target: 'agent',
      metric: 'http_requests_total',
      threshold: 0.05,
      for: '5m',
      severity: 'medium',
    },
    {
      name: 'disk',
      kind: 'disk_free_below',
      target: 'agent',
      threshold: 0.1,
      for: '10m',
      severity: 'low',
    },
    {
      name: 'queue',
      kind: 'series_above',
      target: 'api',
      metric: 'queue_depth',
      threshold: 100,
      for: '3m',
      severity: 'low',
    },
  ],
};

const WriteRequest = protobuf.Root.fromJSON({
  nested: {
    Label: { fields: { name: { type: 'string', id: 1 }, value: { type: 'string', id: 2 } } },
    Sample: { fields: { value: { type: 'double', id: 1 }, timestamp: { type: 'int64', id: 2 } } },
    TimeSeries: {
      fields: {
        labels: { rule: 'repeated', type: 'Label', id: 1 },
        samples: { rule: 'repeated', type: 'Sample', id: 2 },
      },
    },
    WriteRequest: { fields: { timeseries: { rule: 'repeated', type: 'TimeSeries', id: 1 } } },
  },
}).lookupType('WriteRequest');

/** A remote write of one `up` series per entry, labelled with that project, or with none. */
export function remoteWrite(projectSlugs: (string | null)[]): Uint8Array {
  const message = WriteRequest.create({
    timeseries: projectSlugs.map((slug) => ({
      labels: [
        { name: '__name__', value: 'up' },
        ...(slug === null ? [] : [{ name: 'forge_project', value: slug }]),
      ],
      samples: [{ value: 1, timestamp: Date.now() }],
    })),
  });
  return compress(WriteRequest.encode(message).finish());
}

type Ruler = 'mimir' | 'file' | 'none';

export interface MonitoringWorld {
  backend: Backend;
  ownerId: string;
  ownerJwt: string;
  memberJwt: string;
  /** A and B bound to the mimir connection, D to the file one; C binds nothing. */
  projects: Record<'A' | 'B' | 'C' | 'D', { id: string; slug: string }>;
  bindings: Record<'A' | 'B' | 'D', string>;
  connections: Record<Ruler, string>;
  tokens: Record<Ruler, { sd: string; alerts: string }>;
}

/**
 * Owner, member and four projects; a mimir, a file and a none connection on one wired backend, each
 * with its tokens minted; the mimir one bound into A and B, the file one into D.
 */
export async function seedMonitoringWorld(): Promise<MonitoringWorld> {
  const backend = await startBackend();
  const owner = await createTestUser({ verified: true });
  const member = await createTestUser({ verified: true });
  const ownerJwt = await userToken(owner.id);
  const memberJwt = await userToken(member.id);
  const projects = {} as MonitoringWorld['projects'];
  for (const key of ['A', 'B', 'C', 'D'] as const) {
    const project = await createTestProject(owner.id);
    await addProjectMember(project.id, owner.id, 'admin');
    await addProjectMember(project.id, member.id, 'member');
    projects[key] = { id: project.id, slug: project.slug };
  }
  const connections = {} as MonitoringWorld['connections'];
  const tokens = {} as MonitoringWorld['tokens'];
  for (const ruler of ['mimir', 'file', 'none'] as const) {
    const made = await connect(ownerJwt, backend, ruler);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    connections[ruler] = (made.body.connection as { id: string }).id;
    tokens[ruler] = await mintTokens(ownerJwt, connections[ruler]);
  }
  backend.shape = WIRED(Object.values(connections));
  const scrape = { scrape: [{ name: 'api', url: 'https://api.example.test/metrics' }] };
  const mimir = await bindInto(ownerJwt, connections.mimir, [
    { projectId: projects.A.id, target: {} },
    { projectId: projects.B.id, target: scrape },
  ]);
  expect(mimir.status, JSON.stringify(mimir.body)).toBe(200);
  const file = await bindInto(ownerJwt, connections.file, [
    {
      projectId: projects.D.id,
      target: {
        ...scrape,
        rules: [{ name: 'down', kind: 'target_down', target: 'api', for: '1m', severity: 'low' }],
      },
    },
  ]);
  expect(file.status, JSON.stringify(file.body)).toBe(200);
  const ids = (res: { body: Body }) =>
    (res.body.bindings as { bindingId: string }[]).map((b) => b.bindingId);
  const [a = '', b = ''] = ids(mimir);
  const [d = ''] = ids(file);
  return {
    backend,
    ownerId: owner.id,
    ownerJwt,
    memberJwt,
    projects,
    bindings: { A: a, B: b, D: d },
    connections,
    tokens,
  };
}

/** Every code an answer names, in order. */
export const codesOf = (b: Body): string[] =>
  ((b.error as Body | undefined)?.refusals as { code: string }[] | undefined)?.map((r) => r.code) ??
  [];

/** The code an answer names, whether a refusal envelope or a door's problem body. */
export const codeOf = (b: Body): string | undefined => {
  const error = b.error as Body | undefined;
  const refusals = error?.refusals as { code: string }[] | undefined;
  return refusals?.[0]?.code ?? (error?.code as string | undefined) ?? (b.code as string);
};
