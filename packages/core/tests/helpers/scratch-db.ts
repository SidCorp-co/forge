import { randomBytes } from 'node:crypto';
import postgres, { type Sql } from 'postgres';

export const TEMPLATE_PREFIX = 'forge_test_tpl_';
export const WORKER_PREFIX = 'test_w';
export const CASE_PREFIX = 'test_case_';

const TAG_SHAPE = /^[a-z0-9]{1,16}$/;

const ABANDONED_AFTER_MS = 2 * 60 * 60 * 1000;

const STAMPED = /_([0-9a-z]+)_[0-9a-f]{8}$/;

const EPOCH_FLOOR = Date.UTC(2020, 0, 1);

let drainer: Sql | undefined;
let draining: Promise<void> = Promise.resolve();
let queued = 0;

function stamp(): string {
  return `${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

export function templateDbName(): string {
  return `${TEMPLATE_PREFIX}${stamp()}`;
}

export function workerDbName(workerId: string): string {
  return `${WORKER_PREFIX}${workerId}_${stamp()}`;
}

/** The token every scratch database of THIS run carries, read off `TEST_PG_TEMPLATE`. */
export function runToken(
  template: string | undefined = process.env.TEST_PG_TEMPLATE,
): string | null {
  if (template === undefined || !template.startsWith(TEMPLATE_PREFIX)) return null;
  const token = template.slice(TEMPLATE_PREFIX.length);
  return token.length > 0 ? token : null;
}

/** A database for ONE test case: this run's token, the minting suite's `tag`, this call's stamp. */
export function caseDbName(tag: string, token: string | null = runToken()): string {
  if (token === null) {
    throw new Error(
      'scratch-db: no TEST_PG_TEMPLATE, so this run has no token and a case database minted now ' +
        'could be swept by neither its own run nor the reaper. Global setup builds the template; ' +
        'a suite reaching here without one has not run it.',
    );
  }
  if (!TAG_SHAPE.test(tag)) {
    throw new Error(
      `scratch-db: "${tag}" is not a usable tag — lower-case letters and digits, 1 to 16 of them, ` +
        'so the name it goes into stays inside the 63 bytes Postgres truncates an identifier at.',
    );
  }
  return `${CASE_PREFIX}${token}_${tag}_${stamp()}`;
}

/** When the run that created `datname` started, or null for a name this suite did not mint. */
export function bornAt(datname: string): number | null {
  const m = STAMPED.exec(datname);
  if (!m?.[1]) return null;
  const ms = Number.parseInt(m[1], 36);
  return Number.isFinite(ms) && ms >= EPOCH_FLOOR ? ms : null;
}

/** True when `datname` is old enough that no live run can still own it. */
export function isAbandoned(datname: string, now: number): boolean {
  const born = bornAt(datname);
  return born !== null && now - born > ABANDONED_AFTER_MS;
}

/** Drop the scratch databases left by runs that crashed before their teardown. */
export async function reapAbandoned(admin: Sql, now: number = Date.now()): Promise<string[]> {
  const rows = await admin<{ datname: string }[]>`
    SELECT datname FROM pg_database
    WHERE datname LIKE ${`${TEMPLATE_PREFIX}%`}
       OR datname LIKE ${`${WORKER_PREFIX}%`}
       OR datname LIKE ${`${CASE_PREFIX}%`}
  `;
  const dropped: string[] = [];
  for (const { datname } of rows) {
    if (!isAbandoned(datname, now)) continue;
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}"`);
      dropped.push(datname);
    } catch {}
  }
  return dropped;
}

/** How a drain reaches Postgres; a seam, so a held or refused drop can be tested. */
export type DrainConnect = (url: string) => Sql;

/**
 * Hand a case database back: dropped, but not on the clock of the case that used it.
 *
 * `DROP DATABASE` forces a cluster-wide checkpoint and waits for it — 3 to 13s with two suites on
 * one server — against a case's 30-second budget, which is how a case timed out with nothing
 * wrong. This returns before the drop is issued; one drop at a time per process, on a connection
 * of the drain's own so the next `CREATE DATABASE` never queues behind one. A refused drop is
 * swallowed and falls to the sweep, and the names behind it are dropped as if it had succeeded.
 */
export function retireCaseDb(
  adminUrl: string,
  datname: string,
  connect: DrainConnect = (url) => postgres(url, { max: 1, onnotice: () => {} }),
): void {
  drainer ??= connect(adminUrl);
  const client = drainer;
  queued += 1;
  draining = draining.then(async () => {
    try {
      await client.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    } catch {}
    queued -= 1;
  });
}

/**
 * Wait out the drain, up to `graceMs`, and answer how many names are still queued. Expiry stops
 * nothing: the drain keeps dropping, and what it has not reached is `sweepRunScratchDbs`'s and
 * then `reapAbandoned`'s, so the caller's wait is bounded by `graceMs` and no name by nobody.
 */
export async function drainRetiredCaseDbs(graceMs = 15_000): Promise<number> {
  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs);
    timer.unref();
  });
  await Promise.race([draining, grace]);
  if (timer) clearTimeout(timer);
  if (queued === 0 && drainer) {
    await drainer.end({ timeout: 5 }).catch(() => {});
    drainer = undefined;
  }
  return queued;
}

/**
 * Drop every case database THIS run minted, and nothing another run's token names — the backstop
 * behind the drain. The match is on the token, not a `LIKE` whose `_` is a wildcard that would
 * reach a concurrently running suite's database (ISS-937).
 */
export async function sweepRunScratchDbs(
  admin: Sql,
  token: string | null = runToken(),
): Promise<string[]> {
  if (token === null) return [];
  const mine = `${CASE_PREFIX}${token}_`;
  const rows = await admin<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE starts_with(datname, ${mine})
  `;
  const dropped: string[] = [];
  for (const { datname } of rows) {
    if (!datname.startsWith(mine)) continue;
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
      dropped.push(datname);
    } catch {}
  }
  return dropped;
}
