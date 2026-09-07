/**
 * ISS-946 — `GET /api/admin/mcp-audit/tools`, the only surface over
 * `mcp_audit_log` that answers the question the MCP deletion rule asks.
 *
 * Own `requireAdmin()` router, mirroring `alert-routes.ts`, so it is
 * importable standalone in an integration test.
 */

import { Hono } from 'hono';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { mcpToolCallCounts } from './mcp-audit-queries.js';

// cm:guard this route is admin-only and lives under `/api/admin` DELIBERATELY, and moving it inside the PAT fence is the one change it must not receive. The counts are cross-project by nature — a tool's callers span every project on the instance — so the route resolves no project for `beginPatRequest` to fence on, which is the same shape `/api/me/ops-health` is permanently fenced out for. A project-scoped twin is worse than no route rather than a smaller version of this one: a tool at zero calls in one project and hundreds in another would read CLEAR, which is precisely the silent substitution `7f0c5a56` shipped. If an agent needs these numbers, a human runs this route and pastes them — `docs/architecture/agent-surface.md` records that as the answer and its price.
// cm:edge contract -> packages/core/src/middleware/pat-rest-surface.ts — `/api/admin` must stay off PAT_ALLOWED_PREFIXES; `middleware/pat-allowlist-reachable.test.ts` holds that as an assertion rather than an intention
export const adminMcpAuditRoutes = new Hono<{ Variables: AuthVars }>();
adminMcpAuditRoutes.use('*', requireAuth(), assertEmailVerified(), requireAdmin());

adminMcpAuditRoutes.get('/mcp-audit/tools', async (c) => {
  return c.json(await mcpToolCallCounts());
});
