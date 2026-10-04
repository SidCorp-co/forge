import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { mcpAuditLog, personalAccessTokens } from '../db/schema.js';

/** Every personal access token a user holds, revoked ones included, newest first. */
export async function listPatsOf(userId: string) {
  return db
    .select()
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.userId, userId))
    .orderBy(desc(personalAccessTokens.createdAt));
}

/** Whether the user holds a live token with this name. */
export async function hasLivePatNamed(userId: string, name: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: personalAccessTokens.id })
    .from(personalAccessTokens)
    .where(
      and(
        eq(personalAccessTokens.userId, userId),
        eq(personalAccessTokens.name, name),
        isNull(personalAccessTokens.revokedAt),
      ),
    )
    .limit(1);
  return existing !== undefined;
}

/** Whether the token is the user's own. */
export async function ownsPat(tokenId: string, userId: string): Promise<boolean> {
  const [owned] = await db
    .select({ id: personalAccessTokens.id })
    .from(personalAccessTokens)
    .where(and(eq(personalAccessTokens.id, tokenId), eq(personalAccessTokens.userId, userId)))
    .limit(1);
  return owned !== undefined;
}

/** A token's MCP audit entries, newest first. */
export async function patAuditOf(tokenId: string, limit: number) {
  return db
    .select({
      id: mcpAuditLog.id,
      tool: mcpAuditLog.tool,
      action: mcpAuditLog.action,
      projectId: mcpAuditLog.projectId,
      resultCode: mcpAuditLog.resultCode,
      requestId: mcpAuditLog.requestId,
      ip: mcpAuditLog.ip,
      userAgent: mcpAuditLog.userAgent,
      createdAt: mcpAuditLog.createdAt,
    })
    .from(mcpAuditLog)
    .where(eq(mcpAuditLog.tokenId, tokenId))
    .orderBy(desc(mcpAuditLog.createdAt))
    .limit(limit);
}
