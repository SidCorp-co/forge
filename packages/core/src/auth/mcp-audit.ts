/**
 * MCP audit log writer (ISS-150).
 *
 * Fire-and-forget insert called by `server.ts` after every tool dispatch.
 * Audit failure must NEVER 5xx a tool call, so all DB errors are swallowed
 * to a console.warn (a future PR will route these to Sentry once the
 * scrubber is sure to redact PAT plaintext from breadcrumbs).
 *
 * Retention: rows older than 90 days are deleted by `enforceMcpAuditRetention()`
 * — called from the existing stale-detector cadence. A follow-up PR can
 * migrate this table to monthly RANGE partitions for cheaper retention.
 */

import { createHash } from 'node:crypto';
import { lt, sql } from 'drizzle-orm';
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

/** Delete audit rows older than 90 days. Idempotent; call on a cron tick. */
export async function enforceMcpAuditRetention(): Promise<number> {
  const result = await db
    .delete(mcpAuditLog)
    .where(lt(mcpAuditLog.createdAt, sql`now() - interval '90 days'`))
    .returning({ id: mcpAuditLog.id });
  return result.length;
}
