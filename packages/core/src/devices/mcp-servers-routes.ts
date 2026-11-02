import { Hono } from 'hono';
import { z } from 'zod';
import { resolveSessionMcpServers } from '../jobs/index.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requiresNoPermission } from '../permissions/index.js';
import { assertDeviceBoundToProject } from './device-project.js';

const projectQuerySchema = z.object({ projectId: z.uuid() });

const DEVICE_OWN = requiresNoPermission(
  'a paired box’s device credential admits it; each read and write is selected by that device, which the service holds to the projects, sessions and requests it serves',
);

export const deviceMcpServerRoutes = new Hono<{ Variables: DeviceVars }>();

deviceMcpServerRoutes.get(
  '/me/mcp-servers',
  requireDevice(),
  DEVICE_OWN,
  zValidator('query', projectQuerySchema),
  async (c) => {
    const device = c.get('device');
    const { projectId } = c.req.valid('query');
    await assertDeviceBoundToProject(device.id, projectId);

    const { mcpServers, resolvedNames } = await resolveSessionMcpServers(projectId);
    return c.json({ mcpServers: mcpServers ?? {}, resolvedNames });
  },
);
