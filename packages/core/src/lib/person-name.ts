import { type SQL, sql } from 'drizzle-orm';
import { logger } from '../logger.js';

/** The one slot of a title that names a person: the name they gave, never an address (ISS-1229). */
export const UNNAMED_PERSON = 'another member';
export const UNNAMED_PERSON_AT_START = 'Another member';

/** Read alike by JavaScript and Postgres. */
export const ADDRESS_PATTERN = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}';

export function carriesAnAddress(text: string): boolean {
  return new RegExp(ADDRESS_PATTERN).test(text);
}

/** A display name that is blank or holds an address names nobody, and reads as the unnamed person. */
export function personName(
  displayName: string | null | undefined,
  at: 'inside' | 'start' = 'inside',
): string {
  const given = displayName?.trim();
  if (given && !carriesAnAddress(given)) return given;
  if (given)
    logger.warn('person-name: a name held an email address, so it reads as another member');
  return at === 'start' ? UNNAMED_PERSON_AT_START : UNNAMED_PERSON;
}

export function personNameSql(displayName: SQL, at: 'inside' | 'start' = 'inside'): SQL<string> {
  const unnamed = at === 'start' ? UNNAMED_PERSON_AT_START : UNNAMED_PERSON;
  const given = sql`regexp_replace(${displayName}, '^[[:space:]]+|[[:space:]]+$', '', 'g')`;
  return sql<string>`(CASE WHEN nullif(${given}, '') IS NULL OR ${displayName} ~ ${ADDRESS_PATTERN}
                   THEN ${unnamed}::text ELSE ${given} END)`;
}
