import { and, inArray, isNotNull, isNull, notInArray, or, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, users } from '../db/schema.js';
import type { ActorAgency } from './actor-agency.js';

export const FORGE_AGENT_LABEL = 'Forge Agent';

/**
 * The pre-column FLOOR, and only that (ISS-1093).
 *
 * `created_via` names the transport and every door stamps it as a constant, so it
 * cannot answer who was at the keyboard: an agent holding a person's PAT files
 * through REST and lands `web`. It stays here because rows written before
 * `creator_agency` existed have nothing else, and because `buildOriginCondition`
 * below reads the same column for a different question.
 */
export function isAgentChannel(createdVia: string | null): boolean {
  return createdVia != null && createdVia !== 'web';
}

export interface CreatorAgencyRow {
  createdVia: string | null;
  creatorAgency: ActorAgency | null;
}

/**
 * Was this issue filed by an agent? Asked of the credential first.
 */
export function creatorIsAgent(row: CreatorAgencyRow): boolean {
  if (row.creatorAgency != null) return row.creatorAgency === 'agent';
  return isAgentChannel(row.createdVia);
}

export const DETECTOR_CHANNELS = ['system', 'schedule'] as const;

export function isDetectorChannel(createdVia: string | null): boolean {
  return createdVia != null && (DETECTOR_CHANNELS as readonly string[]).includes(createdVia);
}

export function buildOriginCondition(origin: 'detector' | 'human'): SQL {
  const channels = [...DETECTOR_CHANNELS];
  const viaDetectorChannel = inArray(issues.createdVia, channels);
  if (origin === 'detector') {
    return or(isNotNull(issues.detectorKey), viaDetectorChannel) as SQL;
  }
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
  rows: ({ id: string; createdById: string } & CreatorAgencyRow)[],
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
      const isAgent = creatorIsAgent(r);
      return [
        r.id,
        {
          creatorEmail: emailById.get(r.createdById) ?? null,
          creatorIsAgent: isAgent,
          creatorLabel: isAgent
            ? FORGE_AGENT_LABEL
            : (emailById.get(r.createdById) ?? 'Unknown user'),
        },
      ];
    }),
  );
}

export function creatorIsAgentCondition(): SQL {
  return sql`((${issues.creatorAgency} = 'agent' OR (${issues.creatorAgency} IS NULL AND ${issues.createdVia} IS NOT NULL AND ${issues.createdVia} <> 'web')) IS TRUE)`;
}

export function buildCreatedByCondition(value: string): SQL {
  if (value === 'agent') return creatorIsAgentCondition();
  return sql`${issues.createdById} = ${value} AND NOT (${creatorIsAgentCondition()})`;
}
