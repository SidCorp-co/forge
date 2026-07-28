import { type SQL, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, users } from '../db/schema.js';

export const FORGE_AGENT_LABEL = 'Forge Agent';

// cm:edge contract -> packages/web-v2/src/features/issues/derive.ts — creatorLabelOf mirrors this rule
export function isAgentChannel(createdVia: string | null): boolean {
  return createdVia != null && createdVia !== 'web';
}

export interface IssueCreator {
  creatorEmail: string | null;
  creatorIsAgent: boolean;
  creatorLabel: string;
}

/**
 * ISS-756 — one grouped query per page, mirrors `sumCostByIssue`'s shape.
 * NEVER falls back to a raw id slice (unlike web-v2 `memberLabel()`) — a
 * creator need not be a project member, so email-or-agent-label is the floor.
 */
export async function hydrateCreatorsForIssues(
  rows: { id: string; createdById: string; createdVia: string | null }[],
): Promise<Map<string, IssueCreator>> {
  if (rows.length === 0) return new Map();
  const createdByIds = [...new Set(rows.map((r) => r.createdById))];
  const emailRows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.id, createdByIds));
  const emailById = new Map(emailRows.map((u) => [u.id, u.email]));
  return new Map(
    rows.map((r) => {
      const creatorIsAgent = isAgentChannel(r.createdVia);
      return [
        r.id,
        {
          creatorEmail: emailById.get(r.createdById) ?? null,
          creatorIsAgent,
          creatorLabel: creatorIsAgent
            ? FORGE_AGENT_LABEL
            : (emailById.get(r.createdById) ?? 'Unknown user'),
        },
      ];
    }),
  );
}

/**
 * ISS-756 — `createdBy` search predicate. `value === 'agent'` returns every
 * agent-channel row. A person's uuid EXCLUDES their agent-channel rows — an
 * owner-id row created through MCP displays as Forge Agent, so filtering by
 * that person must not surface it (keeps display and filter in lockstep).
 */
export function buildCreatedByCondition(value: string): SQL {
  if (value === 'agent') {
    return sql`${issues.createdVia} IS NOT NULL AND ${issues.createdVia} <> 'web'`;
  }
  return sql`${issues.createdById} = ${value} AND (${issues.createdVia} IS NULL OR ${issues.createdVia} = 'web')`;
}
