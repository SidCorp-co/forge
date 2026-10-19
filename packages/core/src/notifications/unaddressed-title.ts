import { inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { ADDRESS_PATTERN, personName } from '../lib/person-name.js';
import { logger } from '../logger.js';

/**
 * Each address in a notice title read as what that person is called, the unnamed person where it is
 * nobody's: the delivery door's backstop behind `personName`, logged whenever it acts (ISS-1229 r18).
 */
export async function unaddressedTitle(title: string): Promise<string> {
  const addresses = [...new Set(title.match(new RegExp(ADDRESS_PATTERN, 'g')) ?? [])];
  if (addresses.length === 0) return title;
  const rows = await db
    .select({ email: users.email, displayName: users.displayName })
    .from(users)
    .where(
      inArray(
        sql`lower(${users.email})`,
        addresses.map((a) => a.toLowerCase()),
      ),
    );
  const named = new Map(rows.map((r) => [r.email.toLowerCase(), r.displayName]));
  logger.warn(
    { addresses: addresses.length, people: rows.length },
    'notifications: a title carried an email address, and it reads as the name instead',
  );
  return title.replace(new RegExp(ADDRESS_PATTERN, 'g'), (address, offset: number) =>
    personName(named.get(address.toLowerCase()), offset === 0 ? 'start' : 'inside'),
  );
}
