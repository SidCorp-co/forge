import { OWN_CREDENTIAL_JOB_TYPES } from '@forge/contracts/jobs';
import { type SQL, sql } from 'drizzle-orm';

/** SQL: the job row aliased `job` runs on the claiming box's credential (`actsAsTheBox`, ISS-267). */
export function actsAsTheBoxSql(job: SQL): SQL {
  const own = Object.keys(OWN_CREDENTIAL_JOB_TYPES).map((t) => sql`${t}`);
  return sql`${job}.type NOT IN (${sql.join(own, sql`, `)})`;
}
