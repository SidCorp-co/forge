/**
 * A monitoring connection's Prometheus and ruler over HTTP (ISS-1225), each reached at the URL the
 * connection names as the basic-auth user it holds: pushing and removing a project's rule group at a
 * Mimir or Cortex ruler, reading the rule groups and alerts Prometheus holds, forwarding a host
 * agent's remote write, and reading what the server can do from its own status API. Every answer
 * that is not a success is returned as a sentence naming the service and its status, never
 * swallowed.
 */

import {
  MONITORING_RULES_DIR,
  type MonitoringConnectionConfig,
  type MonitoringConnectionSecrets,
  type MonitoringReadiness,
  monitoringConnectionDoor,
} from '@forge/contracts/monitoring';
import { asProvider } from '../../lib/outbound-timing.js';
import type { RuleGroup } from './render.js';

/** One alert as Prometheus' `/api/v1/alerts` reports it. */
export interface PromAlert {
  labels: Record<string, string>;
  state: string;
  activeAt?: string;
}

/** What a call to the connection reaches: its config and its decrypted secrets. */
export interface MonitoringConnection {
  config: MonitoringConnectionConfig;
  secrets: Partial<MonitoringConnectionSecrets>;
}

const TIMEOUT_MS = 10_000;
/** The ruler namespace every project's group is held under. */
const NAMESPACE = 'forge';

function headersOf(conn: MonitoringConnection): Record<string, string> {
  const { prometheusUser } = conn.config;
  const { prometheusPassword } = conn.secrets;
  return {
    ...(prometheusUser && prometheusPassword
      ? {
          authorization: `Basic ${Buffer.from(`${prometheusUser}:${prometheusPassword}`).toString('base64')}`,
        }
      : {}),
    ...(conn.config.tenant ? { 'x-scope-orgid': conn.config.tenant } : {}),
  };
}

async function call(
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: Uint8Array | string },
): Promise<{ status: number; text: string } | { status: null; text: string }> {
  return asProvider('prometheus', async () => {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      return { status: null, text: `could not be reached: ${(err as Error).message}` };
    }
  });
}

const ok = (status: number | null) => status !== null && status >= 200 && status < 300;
const said = (what: string, r: { status: number | null; text: string }) =>
  r.status === null ? `${what} ${r.text}` : `${what} answered ${r.status}: ${r.text.slice(0, 300)}`;

const rulerUrl = (conn: MonitoringConnection, group?: string) =>
  `${conn.config.rulerUrl?.replace(/\/$/, '')}/prometheus/config/v1/rules/${NAMESPACE}${group ? `/${group}` : ''}`;

/** Push one project's rule group to the Mimir ruler; why it was not taken, or null. */
export async function pushRuleGroup(
  conn: MonitoringConnection,
  group: RuleGroup,
): Promise<string | null> {
  const r = await call(rulerUrl(conn), {
    method: 'POST',
    headers: {
      ...headersOf(conn),
      'content-type': 'application/yaml',
    },
    body: JSON.stringify(group),
  });
  return ok(r.status) ? null : said('the ruler', r);
}

/** Remove one project's rule group from the Mimir ruler; a group it does not hold is removed. */
export async function deleteRuleGroup(
  conn: MonitoringConnection,
  name: string,
): Promise<string | null> {
  const r = await call(rulerUrl(conn, name), {
    method: 'DELETE',
    headers: headersOf(conn),
  });
  return ok(r.status) || r.status === 404 ? null : said('the ruler', r);
}

const base = (url: string) => url.replace(/\/$/, '');

/** The names of the rule groups Prometheus has loaded, or why they could not be read. */
export async function loadedRuleGroups(
  conn: MonitoringConnection,
): Promise<{ ok: true; names: string[] } | { ok: false; why: string }> {
  const r = await call(`${base(conn.config.prometheusUrl)}/api/v1/rules`, {
    headers: headersOf(conn),
  });
  if (!ok(r.status)) return { ok: false, why: said('Prometheus', r) };
  const body = jsonOf<{ data?: { groups?: { name?: string }[] } }>(r.text);
  if (!body) return { ok: false, why: 'Prometheus /api/v1/rules answered no JSON' };
  return { ok: true, names: (body.data?.groups ?? []).map((g) => g.name ?? '') };
}

/** The alerts Prometheus holds, or null where it could not be read. */
export async function heldAlerts(conn: MonitoringConnection): Promise<PromAlert[] | null> {
  const r = await call(`${base(conn.config.prometheusUrl)}/api/v1/alerts`, {
    headers: headersOf(conn),
  });
  if (!ok(r.status)) return null;
  const body = jsonOf<{ data?: { alerts?: PromAlert[] } }>(r.text);
  return body ? (body.data?.alerts ?? []) : null;
}

/** A body read as JSON, or null where an ok status carried none (a proxy's page, say). */
function jsonOf<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Forward a host agent's remote write as it was sent, to the server's remote-write receiver. */
export async function forwardRemoteWrite(
  conn: MonitoringConnection,
  body: Uint8Array,
): Promise<{ status: number | null; text: string }> {
  return call(`${base(conn.config.prometheusUrl)}/api/v1/write`, {
    method: 'POST',
    headers: {
      ...headersOf(conn),
      'content-type': 'application/x-protobuf',
      'content-encoding': 'snappy',
      'x-prometheus-remote-write-version': '0.1.0',
    },
    body,
  });
}

/** Whether Prometheus answers ready; why not, or null. */
export async function connectionHealth(conn: MonitoringConnection): Promise<string | null> {
  const prometheus = await call(`${base(conn.config.prometheusUrl)}/-/ready`, {
    headers: headersOf(conn),
  });
  return ok(prometheus.status) ? null : said('Prometheus', prometheus);
}

type Read = { ok: true; data: unknown } | { ok: false; status: number | null; why: string };

async function statusRead(conn: MonitoringConnection, path: string, auth = true): Promise<Read> {
  const r = await call(`${base(conn.config.prometheusUrl)}${path}`, {
    headers: auth ? headersOf(conn) : {},
  });
  if (!ok(r.status)) return { ok: false, status: r.status, why: said(`Prometheus ${path}`, r) };
  try {
    return { ok: true, data: (JSON.parse(r.text) as { data?: unknown }).data };
  } catch {
    return { ok: false, status: r.status, why: `Prometheus ${path} answered no JSON` };
  }
}

/** The entries of a top-level YAML list in Prometheus' own rendering of its config. */
function yamlList(yaml: string, key: string): string[] {
  const block = new RegExp(`^${key}:\\n((?:- .*\\n?)+)`, 'm').exec(yaml)?.[1] ?? '';
  return block
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) =>
      line
        .slice(2)
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2'),
    );
}

/** Whether the config names Forge's http_sd door, as a url line, whatever origin it reaches Forge by. */
const discovers = (yaml: string, door: string) =>
  yaml
    .split('\n')
    .some(
      (line) => /^\s*(?:- )?url:/.test(line) && line.replace(/['"]/g, '').trim().endsWith(door),
    );

/**
 * What the connection's server can do, read from its own status API through the connection: whether
 * it refuses a call without credentials, its version and flags, whether its config wires Forge's
 * discovery and rules directory, and whether an Alertmanager is attached. What could not be read is
 * null, never assumed.
 */
export async function readReadiness(
  conn: MonitoringConnection,
  connectionId: string,
): Promise<MonitoringReadiness> {
  const readAt = new Date().toISOString();
  const open = await statusRead(conn, '/api/v1/status/buildinfo', false);
  const authenticated = open.ok ? false : open.status === 401 || open.status === 403 ? true : null;
  const unread: MonitoringReadiness = {
    readAt,
    unreadable: null,
    authenticated,
    version: null,
    remoteWriteReceiver: null,
    lifecycle: null,
    ruleFiles: null,
    discovery: null,
    alertmanager: null,
  };
  const build = await statusRead(conn, '/api/v1/status/buildinfo');
  if (!build.ok) return { ...unread, unreadable: build.why };
  const [flags, config, alertmanagers] = await Promise.all([
    statusRead(conn, '/api/v1/status/flags'),
    statusRead(conn, '/api/v1/status/config'),
    statusRead(conn, '/api/v1/alertmanagers'),
  ]);
  const flag = (name: string) =>
    flags.ok ? (flags.data as Record<string, string>)?.[name] === 'true' : null;
  const yaml = config.ok ? String((config.data as { yaml?: string })?.yaml ?? '') : null;
  return {
    ...unread,
    version: String((build.data as { version?: string })?.version ?? '') || null,
    remoteWriteReceiver: flag('web.enable-remote-write-receiver'),
    lifecycle: flag('web.enable-lifecycle'),
    ruleFiles:
      yaml === null
        ? null
        : yamlList(yaml, 'rule_files').some((f) => f.startsWith(`${MONITORING_RULES_DIR}/`)),
    discovery:
      yaml === null
        ? null
        : {
            scrape: discovers(yaml, monitoringConnectionDoor(connectionId, 'targets?job=scrape')),
            probe: discovers(yaml, monitoringConnectionDoor(connectionId, 'targets?job=probe')),
          },
    alertmanager: alertmanagers.ok
      ? ((alertmanagers.data as { activeAlertmanagers?: unknown[] })?.activeAlertmanagers ?? [])
          .length > 0
      : null,
  };
}
