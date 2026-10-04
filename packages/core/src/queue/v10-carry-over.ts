import { sql } from 'drizzle-orm';
import { fromDrizzle, type JobInsert, type PgBoss } from 'pg-boss';
import { db } from '../db/client.js';
import { logger } from '../observability/logger.js';

const V10_SCHEMA = 'pgboss';
const V10_SCHEMA_VERSION = 24;
const MARKER = 'pgboss-v10-carry-over';
const V10_POLICIES = new Set(['standard', 'short', 'singleton', 'stately']);

type PgTime = Date | string;
const at = (t: PgTime) => (t instanceof Date ? t : new Date(t));

interface V10Job extends Record<string, unknown> {
  id: string;
  name: string;
  priority: number;
  data: object | null;
  state: 'created' | 'retry';
  retry_limit: number;
  retry_count: number;
  retry_delay: number;
  retry_backoff: boolean;
  start_after: PgTime;
  singleton_key: string | null;
  singleton_on: PgTime | null;
  expire_seconds: number;
  keep_until: PgTime;
  dead_letter: string | null;
}

interface V10Queue extends Record<string, unknown> {
  name: string;
  policy: string | null;
  dead_letter: string | null;
}

class CarryOverRefused extends Error {}

function toInsert(job: V10Job, now: number): JobInsert {
  const startAfter = at(job.start_after);
  const keepUntil = at(job.keep_until).getTime();
  return {
    id: job.id,
    data: job.data ?? {},
    priority: job.priority,
    // A job already retried keeps only the attempts it had left.
    retryLimit:
      job.state === 'retry' ? Math.max(job.retry_limit - job.retry_count, 0) : job.retry_limit,
    retryDelay: job.retry_delay,
    retryBackoff: job.retry_backoff,
    startAfter: startAfter.toISOString(),
    ...(job.singleton_key ? { singletonKey: job.singleton_key } : {}),
    expireInSeconds: Math.max(1, Math.round(job.expire_seconds)),
    retentionSeconds: Math.max(1, Math.ceil((keepUntil - Math.max(startAfter.getTime(), now)) / 1000)),
    ...(job.dead_letter ? { deadLetter: job.dead_letter } : {}),
  };
}

async function v10Installed(): Promise<boolean> {
  const [row] = await db.execute<{ present: boolean }>(
    sql`SELECT to_regclass(${`${V10_SCHEMA}.version`}) IS NOT NULL AS present`,
  );
  return row?.present === true;
}

/** Waiting v10 jobs written after the carry-over: the 10.4.2 build kept enqueuing while it ran. */
async function reportStranded(): Promise<void> {
  const rows = await db.execute<{ id: string; name: string; total: number }>(sql`
    SELECT j.id, j.name, count(*) OVER ()::int AS total
      FROM pgboss.job j, backfill_markers m
     WHERE m.key = ${MARKER} AND j.state IN ('created', 'retry') AND j.created_on > m.completed_at
     ORDER BY j.created_on
     LIMIT 5
  `);
  if (rows.length === 0) return;
  logger.error(
    { total: rows[0]?.total, sample: rows.map((r) => `${r.name}/${r.id}`) },
    'boss: the pg-boss 10 schema holds jobs written after the carry-over, which nothing will run',
  );
}

/**
 * Copies the jobs pg-boss 10.4.2 left waiting (`created`, `retry`) into the pg-boss 12 schema, once
 * per database, keeping their ids. One transaction holds every insert and the marker, so a refused
 * copy leaves nothing behind. A job that cannot be copied as it was is refused by name, which
 * stops the boot. `pgboss` itself is only read.
 */
export async function carryOverV10Jobs(boss: PgBoss): Promise<void> {
  if (!(await v10Installed())) return;

  const [version] = await db.execute<{ version: number }>(sql`SELECT version FROM pgboss.version`);
  if (version?.version !== V10_SCHEMA_VERSION) {
    throw new CarryOverRefused(
      `boss: \`${V10_SCHEMA}\` is at schema version ${version?.version ?? 'none'}; the carry-over reads the version ${V10_SCHEMA_VERSION} layout pg-boss 10.4.2 wrote`,
    );
  }

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${MARKER}))`);
    const [marked] = await tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM backfill_markers WHERE key = ${MARKER}`,
    );
    if ((marked?.n ?? 0) > 0) return null;

    const jobs = await tx.execute<V10Job>(sql`
      SELECT id, name, priority, data, state, retry_limit, retry_count, retry_delay, retry_backoff,
             start_after, singleton_key, singleton_on,
             EXTRACT(epoch FROM expire_in)::int AS expire_seconds, keep_until, dead_letter
        FROM pgboss.job
       WHERE state IN ('created', 'retry') AND keep_until > now()
       ORDER BY created_on, id
    `);
    const queues = new Map(
      (await tx.execute<V10Queue>(sql`SELECT name, policy, dead_letter FROM pgboss.queue`)).map(
        (q) => [q.name, q],
      ),
    );

    const wanted = new Set<string>();
    const want = (name: string) => {
      if (wanted.has(name)) return;
      const q = queues.get(name);
      if (!q) {
        throw new CarryOverRefused(`boss: a v10 job names queue \`${name}\`, which \`${V10_SCHEMA}.queue\` does not hold`);
      }
      if (!V10_POLICIES.has(q.policy ?? 'standard')) {
        throw new CarryOverRefused(`boss: v10 queue \`${name}\` has policy \`${q.policy}\`, which pg-boss 12 does not read the same way`);
      }
      if (q.dead_letter) want(q.dead_letter);
      wanted.add(name);
    };
    for (const job of jobs) {
      want(job.name);
      if (job.dead_letter) want(job.dead_letter);
    }
    // Dead-letter queues were added to `wanted` before the queues that name them.
    for (const name of wanted) {
      if (await boss.getQueue(name)) continue;
      const q = queues.get(name) as V10Queue;
      await boss.createQueue(name, {
        policy: q.policy ?? 'standard',
        ...(q.dead_letter ? { deadLetter: q.dead_letter } : {}),
      });
    }

    const now = Date.now();
    const unslotted: string[] = [];
    const byQueue = new Map<string, V10Job[]>();
    for (const job of jobs) {
      if (job.singleton_on) unslotted.push(`${job.name}/${job.id}`);
      byQueue.set(job.name, [...(byQueue.get(job.name) ?? []), job]);
    }
    const executor = fromDrizzle(tx, sql);
    for (const [name, group] of byQueue) {
      const inserted = new Set(
        (await boss.insert(name, group.map((j) => toInsert(j, now)), { db: executor, returnId: true })) ??
          [],
      );
      const refused = group.filter((j) => !inserted.has(j.id));
      if (refused.length > 0) {
        throw new CarryOverRefused(
          `boss: ${refused.length} v10 job(s) on \`${name}\` could not be copied, a job of the same id or singleton key already holds the place in \`pgboss_v12\`: ${refused
            .slice(0, 5)
            .map((j) => `${j.id}${j.singleton_key ? ` (key ${j.singleton_key})` : ''}`)
            .join(', ')}`,
        );
      }
    }

    const report = { jobs: jobs.length, queues: byQueue.size, unslotted };
    await tx.execute(
      sql`INSERT INTO backfill_markers (key, report) VALUES (${MARKER}, ${JSON.stringify(report)}::jsonb)`,
    );
    return report;
  });

  if (outcome) {
    logger.info(outcome, 'boss: copied the jobs pg-boss 10 left waiting');
    if (outcome.unslotted.length > 0) {
      logger.warn(
        { jobs: outcome.unslotted },
        'boss: throttled v10 jobs were copied without their throttle slot',
      );
    }
  }
  await reportStranded();
}
