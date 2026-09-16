/**
 * ISS-1043 — the MCP servers a project declares, resolved for a session the BOX
 * starts rather than for a job core dispatches.
 *
 * A run is now a subagent inside a resident master's pane, so the only MCP
 * servers it can ever see are the ones that pane declared at startup. Nothing
 * used to put a project's `pipelineConfig.mcpServers` there: the whole
 * expand-and-resolve chain had exactly two callers, a dispatched job's payload
 * and a core-hosted chat turn, and neither is on the path a master takes. This
 * route is the third caller, and the runner is its only client.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { resolveSessionMcpServers } from '../jobs/resolve-job-mcp-servers.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { assertDeviceBoundToProject } from './device-project.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const unauth = () =>
  new HTTPException(401, { message: 'unauthenticated', cause: { code: 'UNAUTHENTICATED' } });

const projectQuerySchema = z.object({ projectId: z.uuid() });

export const deviceMcpServerRoutes = new Hono<{ Variables: DeviceVars }>();

deviceMcpServerRoutes.get(
  '/me/mcp-servers',
  requireDevice(),
  zValidator('query', projectQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const device = c.get('device');
    if (device.status === 'revoked') throw unauth();
    const { projectId } = c.req.valid('query');
    await assertDeviceBoundToProject(device.id, projectId);

    const { mcpServers, resolvedNames, droppedNames } = await resolveSessionMcpServers(projectId);
    return c.json({ mcpServers: mcpServers ?? {}, resolvedNames, droppedNames });
  },
);
