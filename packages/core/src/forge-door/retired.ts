// The doors REQ-47 retired (BC-8): the agent-report routes and MCP tool answer a refusal naming the
// door that replaced them, so a caller holding the old shape is told where to go, never a bare
// Not Found or Unknown tool. The delivery tools that left the MCP server for REST answer the same way.

import {
  MCP_RETIRED_DELIVERY_TOOLS,
  type McpRetiredDeliveryTool,
} from '@forge/contracts/mcp-tools';
import { Hono } from 'hono';
import { type Refusal, refused } from '../lib/refusal.js';

const NEW_DOOR = {
  rest: 'POST /api/forge/feedback { kind, title, whereSeen, body?, signalKey?, clientVersion? }',
  mcp: 'forge_feedback action submit { kind, title, target: { kind, ref }, body?, signalKey?, clientVersion? }',
} as const;

/** The refusal a retired agent-report door answers, naming the Forge feedback door on that side. */
export function agentReportRetired(door: keyof typeof NEW_DOOR): Refusal {
  return {
    code: 'AGENT_REPORT_RETIRED',
    path: '',
    detail: `agent reports are retired: friction with Forge itself, a skill gap or a learning is feedback about Forge, filed as you into Forge's own home project with ${NEW_DOOR[door]}. Nothing was written.`,
  };
}

/**
 * The routes each delivery tool's actions moved to on 2026-10-16 (`docs/patterns/core-module.md`,
 * "Doors"): what a call to the old name is answered with. A pane reaches them with
 * `forge-runner api <path>`, under the credential its checkout carries.
 */
const DELIVERY_ROUTES: Readonly<Record<McpRetiredDeliveryTool, readonly string[]>> = {
  forge_source: [
    'open-change-request: POST /api/projects/:id/integrations/source/change-requests { head, base, title, body?, draft? }',
    'list: GET /api/projects/:id/integrations/source',
    'diff: GET /api/projects/:id/integrations/source/change-requests/:number/diff',
    'check-log: GET /api/projects/:id/integrations/source/checks/:checkRunId/log',
    'comment: POST /api/projects/:id/integrations/source/change-requests/:number/comments { body }',
    'request-review: POST /api/projects/:id/integrations/source/change-requests/:number/reviewers { reviewers?, teamReviewers? }',
    'review: POST /api/projects/:id/integrations/source/change-requests/:number/reviews { verdict, body }',
    'merge: POST /api/issues/:id/merge-pull-request',
  ],
  forge_coolify_deploy: [
    'every action: /api/projects/:id/integrations/coolify/ (status, deploy, cancel, logs, runtime-logs, applications, targets, rollback-images, rollback)',
  ],
  forge_sentry: [
    'list: GET /api/projects/:id/integrations/sentry/issues',
    'get: GET /api/projects/:id/integrations/sentry/issues/:issueId',
  ],
  forge_storefront_target: ['GET /api/projects/:id/integrations/storefront/target'],
};

function deliveryIsRest(tool: McpRetiredDeliveryTool): Refusal {
  return {
    code: 'MCP_DELIVERY_IS_REST',
    path: '',
    detail: `${tool} is not an MCP tool: delivery is served over REST, the credential staying in core and the call made from it. Its acts are ${DELIVERY_ROUTES[tool].join('; ')}. Nothing was done.`,
  };
}

/** MCP tools that are gone, each answered with the refusal naming its replacement. */
export const RETIRED_MCP_TOOLS: Readonly<Record<string, Refusal>> = {
  forge_agent_report: agentReportRetired('mcp'),
  ...Object.fromEntries(MCP_RETIRED_DELIVERY_TOOLS.map((tool) => [tool, deliveryIsRest(tool)])),
};

const answer = (c: Parameters<typeof refused>[0]) =>
  refused(c, [agentReportRetired('rest')], 'AGENT_REPORT_RETIRED');

/**
 * `/api/agent-reports`: every route it served, answering where reports about Forge go now. No
 * validator stands in front of an answer: the old read REQUIRED `?projectId` unless `scope=all`, so
 * a caller holding the old shape sends a query and is told where reports went, never that the
 * route takes none. The read's open query is a priced amnesty in `api-contract/open-queries.ts`.
 */
export const agentReportsRetiredRoutes = new Hono();
agentReportsRetiredRoutes.get('/', answer);
agentReportsRetiredRoutes.post('/', answer);
agentReportsRetiredRoutes.post('/triage', answer);
agentReportsRetiredRoutes.post('/:id/triage', answer);
