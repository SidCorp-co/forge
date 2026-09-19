import { Hono } from 'hono';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { mcpToolCallCounts } from './mcp-audit-queries.js';

export const adminMcpAuditRoutes = new Hono<{ Variables: AuthVars }>();
adminMcpAuditRoutes.use('*', requireAuth(), assertEmailVerified(), requireAdmin());

adminMcpAuditRoutes.get('/mcp-audit/tools', async (c) => {
  return c.json(await mcpToolCallCounts());
});
