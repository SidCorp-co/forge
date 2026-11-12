/**
 * Forge's side of a monitoring connection (ISS-1225, owner rulings 2026-11-12). Four doors answer the
 * connection's own services, each admitted by a bearer Forge minted and never by a session: its
 * Prometheus discovers targets and pulls the rule file at the connection's own path with its `sd`
 * token, its Alertmanager posts alerts there with its `alerts` token, and a project's host agent
 * remote-writes with that project's agent token. Each serves only the projects bound to that
 * connection. A project's own routes are in `project-routes.ts`.
 */

import {
  MONITORING_PROJECT_LABEL,
  type MonitoringConnectionTokenKind,
} from '@forge/contracts/monitoring';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  forwardRemoteWrite,
  probeGroups,
  renderRuleGroup,
  ruleFileOf,
  scrapeGroups,
} from '../integrations/prometheus/index.js';
import { RefusalError, refused } from '../lib/refusal.js';
import { invalid, noQuery, rawBody, strictBody, zValidator } from '../middleware/zod-validator.js';
import { requiresNoPermission } from '../permissions/index.js';
import { projectOfAgentToken } from './agent-tokens.js';
import { ALERTS_WEBHOOK_SHAPE, alertsWebhookSchema, receiveAlerts } from './alerts.js';
import {
  bindingOfProject,
  type ConnectionHeld,
  connectionAdmitting,
  projectsBoundTo,
} from './connections.js';
import { foreignProjects, seriesLabels } from './remote-write.js';

const BEARER = /^Bearer\s+(\S+)$/i;

const tokenRefusal = (detail: string) =>
  new HTTPException(401, { message: detail, cause: { code: 'MONITORING_TOKEN_INVALID' } });

function bearerOf(c: Context): string {
  const token = BEARER.exec(c.req.header('authorization') ?? '')?.[1];
  if (!token) throw tokenRefusal('this door takes its token as `Authorization: Bearer <token>`');
  return token;
}

const connectionParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the connection id is a uuid'),
);

async function connectionOf(
  c: Context,
  kind: MonitoringConnectionTokenKind,
): Promise<ConnectionHeld> {
  const held = await connectionAdmitting(c.req.param('id') ?? '', kind, bearerOf(c));
  if (!held) throw tokenRefusal(`the bearer is not this monitoring connection's ${kind} token`);
  return held;
}

const refuse = (c: Context, code: string, path: string, detail: string) =>
  refused(c, [{ code, path, detail }], code);

export const monitoringDoorRoutes = new Hono();

monitoringDoorRoutes.get(
  '/connections/:id/targets',
  requiresNoPermission(
    "the connection's sd token in Authorization admits the call; it reads the targets of the projects bound to that connection and nothing else",
  ),
  connectionParam,
  zValidator(
    'query',
    z.strictObject({ job: z.string() }),
    invalid('invalid query: ?job=scrape or ?job=probe'),
  ),
  async (c) => {
    const { connectionId } = await connectionOf(c, 'sd');
    const { job } = c.req.valid('query');
    if (job !== 'scrape' && job !== 'probe') {
      return refuse(
        c,
        'MONITORING_JOB_UNKNOWN',
        '/job',
        `job \`${job}\` is not one Prometheus discovers here; it is scrape or probe`,
      );
    }
    const projects = await projectsBoundTo(connectionId);
    return c.json(job === 'scrape' ? scrapeGroups(projects) : probeGroups(projects));
  },
);

monitoringDoorRoutes.get(
  '/connections/:id/rules',
  requiresNoPermission(
    "the connection's sd token in Authorization admits the call; it reads the rule groups of the projects bound to that connection",
  ),
  connectionParam,
  noQuery,
  async (c) => {
    const { connectionId, conn } = await connectionOf(c, 'sd');
    if (conn.config.ruler === 'none') {
      return refuse(
        c,
        'MONITORING_BACKEND_TAKES_NO_RULES',
        '',
        'this connection declares `ruler: none`, so Forge holds no rules for it',
      );
    }
    const groups = (await projectsBoundTo(connectionId)).flatMap(({ slug, monitoring }) => {
      const group = renderRuleGroup(slug, monitoring);
      return group ? [group] : [];
    });
    return c.body(ruleFileOf(groups), 200, { 'content-type': 'application/yaml; charset=utf-8' });
  },
);

monitoringDoorRoutes.post(
  '/write',
  requiresNoPermission(
    "a project's agent token in Authorization admits the call, and only series labelled with that project are forwarded to its connection",
  ),
  rawBody(
    'application/x-protobuf',
    'a Prometheus remote-write v1 request: snappy-compressed prometheus.WriteRequest',
  ),
  async (c) => {
    const agent = await projectOfAgentToken(bearerOf(c));
    if (!agent) throw tokenRefusal("the bearer is no project's monitoring agent token");
    const bound = await bindingOfProject(agent.projectId);
    if (!bound) {
      return refuse(
        c,
        'MONITORING_NOT_CONNECTED',
        '',
        'this project binds no monitoring connection, so its writes have nowhere to go; nothing was forwarded',
      );
    }
    const body = new Uint8Array(await c.req.arrayBuffer());
    const series = seriesLabels(body);
    if (series === null) {
      return refuse(
        c,
        'MONITORING_WRITE_UNDECODABLE',
        '',
        'the body is not a snappy-compressed remote-write WriteRequest; nothing was forwarded',
      );
    }
    const foreign = foreignProjects(series, MONITORING_PROJECT_LABEL, agent.slug);
    if (foreign.length > 0) {
      return refuse(
        c,
        'MONITORING_SERIES_FOREIGN_PROJECT',
        `/timeseries/labels/${MONITORING_PROJECT_LABEL}`,
        `this token writes for project \`${agent.slug}\` only, and the write holds series labelled ${foreign.map((f) => `\`${f}\``).join(', ')}; set external_labels: { ${MONITORING_PROJECT_LABEL}: ${agent.slug} } on the agent. Nothing was forwarded`,
      );
    }
    const forwarded = await forwardRemoteWrite(bound.conn, body);
    if (forwarded.status !== null && forwarded.status >= 200 && forwarded.status < 300) {
      return c.body(null, 204);
    }
    // the backend's own 4xx (a sample out of order) is the agent's to drop; anything else it retries
    const status =
      forwarded.status !== null && forwarded.status >= 400 && forwarded.status < 500
        ? forwarded.status
        : 502;
    throw new HTTPException(status as 400, {
      message: `the connection's Prometheus answered ${forwarded.status ?? 'nothing'}: ${forwarded.text.slice(0, 500)}`,
      cause: { code: 'MONITORING_FORWARD_FAILED' },
    });
  },
);

monitoringDoorRoutes.post(
  '/connections/:id/alerts',
  requiresNoPermission(
    "the connection's alerts token in Authorization admits the call; each alert files on the project its own label names, among the projects bound to that connection",
  ),
  connectionParam,
  strictBody(alertsWebhookSchema, ALERTS_WEBHOOK_SHAPE),
  async (c) => {
    const { connectionId } = await connectionOf(c, 'alerts');
    const bound = await projectsBoundTo(connectionId);
    const { outcomes, refusals } = await receiveAlerts(c.req.valid('json').alerts, bound);
    // the alerts naming a bound project were filed all the same; the answer names each that was not
    if (refusals.length > 0) {
      throw new RefusalError(refusals, 'MONITORING_ALERT_PROJECT_UNKNOWN').withDetails({
        alerts: outcomes,
      });
    }
    return c.json({ alerts: outcomes });
  },
);
