import { and, eq, inArray, isNotNull, isNull, notInArray, or, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, users } from '../db/schema.js';

export const DETECTOR_CHANNELS = ['system', 'schedule'] as const;

/**
 * Detector-or-person, which is a question about the DOOR and stays a question
 * about the door (ISS-1137). `created_via` names the transport and answers
 * nothing about who was at the keyboard; the agency question is
 * `users.kind` of the account the credential belongs to, and lives below.
 */
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

const UNKNOWN_CREATOR_LABEL = 'Unknown user';

/**
 * Who filed each issue on this page, keyed by issue id (ISS-756, ISS-1137).
 *
 * One grouped query, the shape `sumCostByIssue` uses. A writer is a named
 * account: its kind is `users.kind` and its label is the display name an org
 * admin or the person themselves typed, falling back to the address. No class
 * label stands in for a group of writers, so two agents on one page read as
 * two agents rather than as one.
 *
 * NEVER falls back to a raw id slice (unlike web-v2 `memberLabel()`) — a
 * creator need not be a project member, so name-or-address is the floor.
 */
export async function hydrateCreatorsForIssues(
  rows: { id: string; createdById: string }[],
): Promise<Map<string, IssueCreator>> {
  if (rows.length === 0) return new Map();
  const createdByIds = [...new Set(rows.map((r) => r.createdById))];
  const writerRows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      kind: users.kind,
    })
    .from(users)
    .where(inArray(users.id, createdByIds));
  const writerById = new Map(writerRows.map((u) => [u.id, u]));
  return new Map(
    rows.map((r) => {
      const writer = writerById.get(r.createdById);
      return [
        r.id,
        {
          creatorEmail: writer?.email ?? null,
          creatorIsAgent: writer?.kind === 'agent',
          creatorLabel: writer?.displayName ?? writer?.email ?? UNKNOWN_CREATOR_LABEL,
        },
      ];
    }),
  );
}

/** The same question in SQL: is this issue's creator an account of kind `agent`? */
export function creatorIsAgentCondition(): SQL {
  return sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${issues.createdById} AND ${users.kind} = 'agent')`;
}

/**
 * The creator filter. `agent` selects every agent's issues; anything else is
 * one writer's id and selects exactly that writer's, agent or person — there
 * is no longer a case where a person's id carries an agent's rows.
 */
export function buildCreatedByCondition(value: string): SQL {
  if (value === 'agent') return creatorIsAgentCondition();
  return eq(issues.createdById, value) as SQL;
}
