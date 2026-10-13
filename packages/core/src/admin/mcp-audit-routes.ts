import { Hono } from 'hono';
import { answer } from '../api-reference/declare/describe.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { mcpToolCallCounts } from './mcp-audit-queries.js';
import { mcpAuditSchema, readMcpAudit } from './routes-reference.js';

export const adminMcpAuditRoutes = new Hono<{ Variables: AuthVars }>();
adminMcpAuditRoutes.use('*', requireAuth(), assertEmailVerified(), requireAdmin());

adminMcpAuditRoutes.get('/mcp-audit/tools', readMcpAudit, async (c) => {
  return c.json(answer(mcpAuditSchema, await mcpToolCallCounts()));
});
