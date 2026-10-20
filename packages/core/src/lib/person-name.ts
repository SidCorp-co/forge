import {
  ADDRESS_PATTERN,
  givenName,
  personName as named,
  UNNAMED_PERSON,
  UNNAMED_PERSON_AT_START,
} from '@forge/contracts/person-name';
import { type SQL, sql } from 'drizzle-orm';
import { logger } from '../logger.js';

export {
  ADDRESS_PATTERN,
  carriesAnAddress,
  givenName,
  personInitials,
  UNNAMED_PERSON,
  UNNAMED_PERSON_AT_START,
} from '@forge/contracts/person-name';

/** `@forge/contracts/person-name`'s, saying when a name it was handed held an address (ISS-1229). */
export function personName(
  displayName: string | null | undefined,
  at: 'inside' | 'start' = 'inside',
): string {
  if (displayName?.trim() && givenName(displayName) === null)
    logger.warn('person-name: a name held an email address, so it reads as another member');
  return named(displayName, at);
}

export function personNameSql(displayName: SQL, at: 'inside' | 'start' = 'inside'): SQL<string> {
  const unnamed = at === 'start' ? UNNAMED_PERSON_AT_START : UNNAMED_PERSON;
  const given = sql`regexp_replace(${displayName}, '^[[:space:]]+|[[:space:]]+$', '', 'g')`;
  return sql<string>`(CASE WHEN nullif(${given}, '') IS NULL OR ${displayName} ~ ${ADDRESS_PATTERN}
                   THEN ${unnamed}::text ELSE ${given} END)`;
}
