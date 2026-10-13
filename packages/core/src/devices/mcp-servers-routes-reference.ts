import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';

export const projectQuerySchema = z.object({ projectId: z.uuid() });

export const mcpServersSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()),
  resolvedNames: z.array(z.string()),
  droppedNames: z.array(z.string()),
});

export const readMcpServers = describeOperation({
  summary: "Read the MCP servers a project's sessions on this device are given",
  description: '`droppedNames` are servers the project declared that did not survive resolution.',
  responses: {
    200: json(mcpServersSchema),
    401: fail('UNAUTHENTICATED', 'the device is revoked'),
    403: fail('FORBIDDEN', 'the device is not bound to the project'),
  },
});
