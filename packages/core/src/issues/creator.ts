import { type SQL, and, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, users } from '../db/schema.js';

export const FORGE_AGENT_LABEL = 'Forge Agent';

// cm:edge contract -> packages/web-v2/src/features/issues/derive.ts — creatorLabelOf mirrors this rule
export function isAgentChannel(createdVia: string | null): boolean {
  return createdVia != null && createdVia !== 'web';
}

/**
 * `detector_key` is the PRIMARY signal for detector output: a row carrying one
 * was written by a sweep, by construction.
 *
 * `created_via` alone is NOT sufficient and must never be the only test. A
 * scheduled agent that creates through MCP records `mcp`, identical to an
 * operator's own CLI session — measured on forge-dev 2026-08-07, every one of
 * its scheduled-sweep drafts was `mcp` or NULL and not a single one was
 * `schedule`. These channels stay in the predicate only to catch server-side
 * writers that never pass a key.
 */
// cm:guard both halves must stay complementary — a row matching neither (or both) vanishes from the UI or shows twice. Change buildOriginCondition's two branches together.
export const DETECTOR_CHANNELS = ['system', 'schedule'] as const;

export function isDetectorChannel(createdVia: string | null): boolean {
  return createdVia != null && (DETECTOR_CHANNELS as readonly string[]).includes(createdVia);
}

// cm:edge contract -> packages/web-v2/src/features/issues/derive.ts — the Backlog/Findings split mirrors this predicate
export function buildOriginCondition(origin: 'detector' | 'human'): SQL {
  const channels = [...DETECTOR_CHANNELS];
  const viaDetectorChannel = inArray(issues.createdVia, channels);
  if (origin === 'detector') {
    return or(isNotNull(issues.detectorKey), viaDetectorChannel) as SQL;
  }
  // cm:why legacy rows predate created_via and are human backlog, so NULL lands in this branch
  return and(
    isNull(issues.detectorKey),
    or(isNull(issues.createdVia), notInArray(issues.createdVia, channels)),
  ) as SQL;
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
