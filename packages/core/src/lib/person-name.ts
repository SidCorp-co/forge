import {
  ADDRESS_PATTERN,
  carriesAnAddress,
  personName as named,
  UNNAMED_PERSON,
  UNNAMED_PERSON_AT_START,
} from '@forge/contracts/person-name';
import { type SQL, sql } from 'drizzle-orm';
import { logger } from '../logger.js';

export {
  ADDRESS_PATTERN,
  carriesAnAddress,
  displayNameRefusal,
  givenName,
  personInitials,
  READER_INITIAL,
  readerInitials,
  readerName,
  UNNAMED_PERSON,
  UNNAMED_PERSON_AT_START,
} from '@forge/contracts/person-name';

/** `@forge/contracts/person-name`'s, saying when a name it was handed held an address (ISS-1229). */
export function personName(
  displayName: string | null | undefined,
  at: 'inside' | 'start' = 'inside',
): string {
  if (displayName && carriesAnAddress(displayName))
    logger.warn('person-name: a name held an email address, so it reads as a member');
  return named(displayName, at);
}

export function personNameSql(displayName: SQL, at: 'inside' | 'start' = 'inside'): SQL<string> {
  const unnamed = at === 'start' ? UNNAMED_PERSON_AT_START : UNNAMED_PERSON;
  const given = sql`regexp_replace(${displayName}, '^[[:space:]]+|[[:space:]]+$', '', 'g')`;
  return sql<string>`(CASE WHEN nullif(${given}, '') IS NULL OR ${displayName} ~ ${ADDRESS_PATTERN}
                        OR lower(${given}) = ${UNNAMED_PERSON}
                   THEN ${unnamed}::text ELSE ${given} END)`;
}
