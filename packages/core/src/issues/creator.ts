import { and, eq, inArray, isNotNull, isNull, notInArray, or, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, users } from '../db/schema.js';

export const DETECTOR_CHANNELS = ['system', 'schedule'] as const;

/** Detector-or-person, a question about the DOOR. Not about who wrote it. */
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
 * Who filed each issue on this page, one grouped query (ISS-756, ISS-1137). A
 * writer is a named account: `users.kind` is its kind and `display_name` its
 * label, so no class label stands in for a group of writers. Never a raw id.
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

/** `agent` selects every agent's issues; anything else is one writer's id. */
export function buildCreatedByCondition(value: string): SQL {
  if (value === 'agent') return creatorIsAgentCondition();
  return eq(issues.createdById, value) as SQL;
}
