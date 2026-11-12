/**
 * A project's own monitoring routes (ISS-1225): an admin mints the agent token its host's Prometheus
 * agent remote-writes with, and a reader reads what the project's monitoring binding registers, the
 * rule group core renders for it, whether the connection's backend holds that group, the alerts
 * firing, and what the connection's server, read now, cannot do for it, by name. A project that binds
 * no monitoring connection mints nothing: MONITORING_NOT_CONNECTED.
 */

import { MONITORING_PROJECT_LABEL, type MonitoringReadResponse } from '@forge/contracts/monitoring';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  heldAlerts,
  loadedRuleGroups,
  noAlertmanager,
  readinessFaults,
  readReadiness,
  recordReadiness,
  renderRuleGroup,
  ruleFileOf,
  ruleGroupName,
} from '../integrations/prometheus/index.js';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { invalid, noQuery, strictBody, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { listProjectHeads } from '../projects/index.js';
import { agentTokenOf, mintAgentToken } from './agent-tokens.js';
import { bindingOfProject } from './connections.js';

export const projectMonitoringRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/monitoring', '/:id/monitoring/*']) {
  projectMonitoringRoutes.use(path, requireAuth(), assertEmailVerified());
}

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);

projectMonitoringRoutes.post(
  '/:id/monitoring/agent-token',
  projectParam,
  requiresOnParam('project.admin', 'id'),
  strictBody(z.strictObject({}), '{} (no fields)'),
  async (c) => {
    const projectId = c.req.valid('param').id;
    if (!(await bindingOfProject(projectId))) {
      return refused(
        c,
        [
          {
            code: 'MONITORING_NOT_CONNECTED',
            path: '',
            detail:
              'this project binds no monitoring connection, so an agent token would admit writes with nowhere to go; bind one with role `monitoring` first',
          },
        ],
        'MONITORING_NOT_CONNECTED',
      );
    }
    return c.json(await mintAgentToken({ projectId, mintedBy: restActor(c).id }), 201);
  },
);

projectMonitoringRoutes.get(
  '/:id/monitoring',
  projectParam,
  requiresOnParam('project.read', 'id'),
  noQuery,
  async (c) => {
    const projectId = c.req.valid('param').id;
    const [bound, [head], agentToken] = await Promise.all([
      bindingOfProject(projectId),
      listProjectHeads([projectId]),
      agentTokenOf(projectId),
    ]);
    const slug = head?.slug ?? null;
    const group = bound && slug ? renderRuleGroup(slug, bound.monitoring) : null;
    const [loaded, alerts, readiness] =
      bound && slug
        ? await Promise.all([
            loadedRuleGroups(bound.conn),
            heldAlerts(bound.conn),
            readReadiness(bound.conn, bound.connectionId),
          ])
        : [null, null, null];
    if (bound && readiness) await recordReadiness(bound.connectionId, readiness);
    const faults =
      bound && readiness
        ? readinessFaults(readiness, bound.monitoring, bound.conn.config.ruler)
        : [];
    // alerts reach Forge only through an Alertmanager, whether or not this binding holds rules yet
    if (
      readiness &&
      readiness.alertmanager !== true &&
      !faults.some((f) => f.code === 'MONITORING_NO_ALERTMANAGER')
    ) {
      faults.push(noAlertmanager(readiness));
    }
    const body: MonitoringReadResponse = {
      connected: bound !== null,
      ruler: bound?.conn.config.ruler ?? null,
      registered: bound?.monitoring ?? null,
      agentToken,
      rules: group ? ruleFileOf([group]) : null,
      rulesLoaded: group && slug && loaded?.ok ? loaded.names.includes(ruleGroupName(slug)) : null,
      alerts:
        alerts
          ?.filter((a) => a.labels[MONITORING_PROJECT_LABEL] === slug)
          .map((a) => ({
            name: a.labels.alertname ?? '',
            state: a.state,
            activeAt: a.activeAt ?? null,
            labels: a.labels,
          })) ?? null,
      readiness,
      faults,
    };
    return c.json(body);
  },
);
