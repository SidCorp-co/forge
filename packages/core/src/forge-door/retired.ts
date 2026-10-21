// The doors REQ-47 retired (BC-8): the agent-report routes and MCP tool answer a refusal naming the
// door that replaced them, so a caller holding the old shape is told where to go, never a bare
// Not Found or Unknown tool.

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

/** MCP tools that are gone, each answered with the refusal naming its replacement. */
export const RETIRED_MCP_TOOLS: Readonly<Record<string, Refusal>> = {
  forge_agent_report: agentReportRetired('mcp'),
};

const answer = (c: Parameters<typeof refused>[0]) =>
  refused(c, [agentReportRetired('rest')], 'AGENT_REPORT_RETIRED');

/** `/api/agent-reports`: every route it served, answering where reports about Forge go now. */
export const agentReportsRetiredRoutes = new Hono();
agentReportsRetiredRoutes.get('/', answer);
agentReportsRetiredRoutes.post('/', answer);
agentReportsRetiredRoutes.post('/triage', answer);
agentReportsRetiredRoutes.post('/:id/triage', answer);
