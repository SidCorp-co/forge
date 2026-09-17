/**
 * MCP audit log writer (ISS-150).
 *
 * Fire-and-forget insert called by `server.ts` after every tool dispatch.
 * Audit failure must NEVER 5xx a tool call, so all DB errors are swallowed
 * to a console.warn (a future PR will route these to Sentry once the
 * scrubber is sure to redact PAT plaintext from breadcrumbs).
 *
 * This table is NOT swept, on purpose, and `pipeline/retention/policy.ts` is where that
 * is stated and why. `drizzle/migrations/0063_mcp_audit_log.sql` declares 90
 * days in a comment and ISS-1027 superseded it: the MCP tool-deletion rule in
 * `docs/architecture/agent-surface.md` spends a count over the whole table as
 * evidence a tool was never called, so a window here would turn "never called"
 * into "not called lately" and license a deletion nothing would go red for. The
 * 90-day `enforceMcpAuditRetention` that nothing ever called went with it.
 */

import { createHash } from 'node:crypto';
import { db } from '../db/client.js';
import { mcpAuditLog } from '../db/schema.js';

export type AuditResultCode =
  | 'ok'
  | 'forbidden'
  | 'not_found'
  | 'error'
  | 'revoked'
  | 'rate_limited';

export interface AuditRow {
  userId: string | null;
  tokenId: string | null;
  deviceId: string | null;
  tool: string;
  action?: string | null;
  projectId?: string | null;
  resultCode: AuditResultCode;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  payloadDigest?: string | null;
}

/**
 * Stable sha256 of canonicalised args. Keys are sorted so `{a:1,b:2}` and
 * `{b:2,a:1}` produce the same digest. Returns `null` when args is empty
 * to keep the column non-noisy.
 */
export function digestArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const sortedJson = JSON.stringify(args, Object.keys(args as object).sort());
  if (sortedJson === '{}' || sortedJson === 'null') return null;
  return createHash('sha256').update(sortedJson).digest('hex');
}

export function writeMcpAudit(row: AuditRow): void {
  void (async () => {
    try {
      await db.insert(mcpAuditLog).values({
        userId: row.userId,
        tokenId: row.tokenId,
        deviceId: row.deviceId,
        tool: row.tool,
        action: row.action ?? null,
        projectId: row.projectId ?? null,
        resultCode: row.resultCode,
        requestId: row.requestId ?? null,
        ip: row.ip ?? null,
        userAgent: row.userAgent ?? null,
        payloadDigest: row.payloadDigest ?? null,
      });
    } catch (err) {
      // Audit failure must not propagate — log and move on.
      console.warn('[mcp-audit] insert failed', err);
    }
  })();
}
