// The integration setup file that holds every suite to REQ-12 BC-18 r6 (ISS-1181): no fact is
// reported by two outbox events for the same subject in one transaction. A test-only trigger copies
// each `pipeline_outbox` row with `txid_current()` (a savepoint's rows carry their parent's id, so it
// groups by the real transaction) into a schema of its own in this file's database; after each test,
// and once at the file's end, the rows written since are read and `outbox-fact-pairs.ts:FACT_PAIRS`
// refuses `OUTBOX_FACT_TWICE <type-a>+<type-b> <subject>`. Nothing here reaches production code.
import postgres from 'postgres';
import { afterAll, afterEach } from 'vitest';
import { FACT_PAIRS, factsSaidTwice, type GuardedEvent } from './outbox-fact-pairs.js';

/** Pairs still said twice by an act, each named with the issue that folds it; never refused. */
const PENDING: Readonly<Record<string, string>> = {
  F1: 'ISS-1181',
  F2: 'ISS-1181',
  F3: 'ISS-1181',
  F4: 'ISS-1181',
  F5: 'ISS-1181',
};

const SCHEMA = 'outbox_fact_guard';
// read before the file runs: a test may point DATABASE_URL at a role it means to be refused
const fileUrl = process.env.DATABASE_URL;
if (!fileUrl)
  throw new Error('outbox-fact-guard: DATABASE_URL is unset; file-database.ts runs first');

const guard = postgres(fileUrl, {
  max: 1,
  idle_timeout: 1,
  onnotice: () => {},
  connection: { application_name: 'outbox-fact-guard' },
});
await guard.unsafe(`
  CREATE SCHEMA IF NOT EXISTS ${SCHEMA};
  CREATE TABLE IF NOT EXISTS ${SCHEMA}.events (
    n bigserial PRIMARY KEY,
    txid bigint NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL
  );
  CREATE OR REPLACE FUNCTION ${SCHEMA}.copy() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    INSERT INTO ${SCHEMA}.events (txid, type, payload) VALUES (txid_current(), NEW.type, NEW.payload);
    RETURN NULL;
  END $$;
  DROP TRIGGER IF EXISTS outbox_fact_guard ON public.pipeline_outbox;
  CREATE TRIGGER outbox_fact_guard AFTER INSERT ON public.pipeline_outbox
    FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.copy();
`);

const refused = FACT_PAIRS.filter((p) => !(p.key in PENDING));
let seen = 0;

/** The refusals the rows written since the last read say, under the pairs not pending. */
async function saidSince(): Promise<string[]> {
  const rows = await guard<(GuardedEvent & { n: string })[]>`
    SELECT n::text, txid::text, type, payload FROM ${guard(SCHEMA)}.events WHERE n > ${seen} ORDER BY n
  `;
  const last = rows.at(-1);
  if (last) seen = Number(last.n);
  return factsSaidTwice(rows, refused);
}

function refuse(said: readonly string[]): void {
  if (said.length === 0) return;
  throw new Error(
    `${said.join('\n')}\none act reported one fact with two outbox events (REQ-12 BC-18): ` +
      'emit the one event its consumers read (tests/helpers/outbox-fact-pairs.ts names each pair)',
  );
}

afterEach(async () => {
  refuse(await saidSince());
});

afterAll(async () => {
  try {
    refuse(await saidSince());
  } finally {
    await guard.end({ timeout: 5 });
  }
});
