# @forge/core — tests

Infrastructure for the integration tests (Vitest + real Postgres).
Unit tests (with `vi.mock(...)` on the DB) live next to the source under
`src/**/*.test.ts` and do not need any of this.

## Decision — hybrid test DB strategy

Where the database comes from is chosen by `TEST_DB_MODE`:

| Mode        | When                  | What happens                                                                                    |
| ----------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| `container` | CI, fresh clones      | Boot `pgvector/pgvector:pg17` via Testcontainers (`tests/helpers/container.ts`), tear down after. |
| `schema`    | Local dev (preferred) | Use the Postgres already running at `TEST_DATABASE_URL`.                                          |

Unset defaults to `schema` when `TEST_DATABASE_URL` is set, `container`
otherwise. A mode that is set is the one taken, in global setup as in
`setupTestDatabase` (`tests/helpers/schema-mode.ts:resolveDbSource`): `container`
boots one even where `TEST_DATABASE_URL` is set, and `schema` with no
`TEST_DATABASE_URL`, or a value that is neither mode, is refused by name rather
than met with a container. **Testcontainers needs a docker daemon this user can reach**; where
it does not have one, `TEST_DATABASE_URL` is the only route into the suite, and
`startPostgresContainer` says so by name rather than letting an unreachable
socket surface as a broken suite.

Whichever mode resolves the server, `tests/helpers/global-setup.ts` migrates
**one template database**, and `tests/helpers/db.ts:setupTestDatabase` hands each
file a clone of it (`CREATE DATABASE ... TEMPLATE`, a file copy): the database
of the worker slot the file runs in, cloned once per slot and reset between the
files that share it (*One database per worker slot*), or, for a file that
declared `own`, a clone no other file is handed. A migration case clones one of
its own (`scratch-db.ts:caseDbName`). Cloning replaces a container boot plus a
full migration replay — measured at ~8.6s. Whose template it is, and whether it
outlives the run, is the *Shared template* section below.

**Why not just Testcontainers everywhere?** Cold boot is 3–5s per run, painful
on every local edit-test loop.

**Why not just schema mode everywhere?** CI runners do not always have a
long-lived Postgres. Testcontainers needs only Docker, which GitHub Actions'
`ubuntu-latest` provides.

### Shared template

The template is a pure function of `drizzle/migrations/`, so on an instance that outlives the run
(`TEST_DATABASE_URL`) it is built once and every run whose migrations match clones it:
`forge_test_tpl_<24 hex>`, the hash of every file under that directory
(`tests/helpers/shared-template.ts:hashMigrations`). A journal that differs by one entry, or a
migration by one byte, is a different template and the two sit side by side. Global setup prints
which one it took: `[integration] template forge_test_tpl_…, shared (…): reused in 0.2s`.

`TEST_TEMPLATE_MODE` decides, and a value other than the two below is refused by name:

| Value | Meaning |
| ----- | ------- |
| `shared` | One template per migration content on the instance. Needs `TEST_DATABASE_URL`. |
| `fresh` | A private template this run builds and drops, as every run once did. |
| unset | `fresh` when `CI` is set or the run starts a container of its own, otherwise `shared`. CI therefore never trusts a template it did not build. |

How concurrent runs share one without stepping on each other:

- **Build once.** A run takes a build lock (a Postgres advisory lock) before it looks, so two runs
  entering together build one template and the second reuses it. The build happens under a staging
  name and is renamed into place once its marker is written, so the final name never exists
  half-built. The marker is the database's own comment, read without connecting to it.
- **Held while in use.** Every run holds a shared advisory lock on its template for as long as its
  connection lives, on a connection opened with `max_lifetime: 0` (postgres.js otherwise recycles a
  connection after 30 to 60 minutes and the lock would go with it). A crash drops the lock with the
  connection; no clock is involved. Teardown names a connection that was replaced under it.
- **Reaped only when idle.** `reapAbandoned` drops a shared template only when it can take both
  the build lock and the exclusive use lock without waiting **and** the marker's last-used time
  (stamped when a run takes it and when it lets go) is more than a day old. The marker is read only
  once the use lock is held, because a holder's release stamps it and an earlier read can be a day
  stale. A template whose comment it cannot read, or whose marker names other content, is left
  alone.
- **Never dropped by a run's own teardown.** A private (`fresh`) template is dropped by the run that
  built it; a shared one is not, by the run that built it or by any other.
- **Refused, not repaired.** A shared name that exists without a valid marker fails setup naming
  it, and is neither rebuilt nor dropped. A worker cloning a template that has vanished fails naming
  it (`db.ts:explainCloneFailure`).

### Concurrent runs on one server

Every database a run creates is named for that run: a private template is
`forge_test_tpl_<token>`, a worker slot's database is `test_w_<slot>_<token>`, a file that declared
its own gets `test_own_<token>_<stamp>_<rand>` and a migration case's is
`test_case_<token>_<tag>_<stamp>_<rand>`, all minted in
`tests/helpers/scratch-db.ts`. The token is minted per run by global setup and read from
`TEST_PG_RUN_TOKEN`, **not** taken from the template's name, because runs sharing a template must
still sweep only their own databases. Global setup also records its own pid as `TEST_PG_RUN_OWNER`,
and a slot database is handed only to a worker that process forked
(`scratch-db.ts:slotRefusal`): a vitest launched apart that inherited the token would otherwise be
handed a database one of the first run's workers is using, so it is refused naming the owner. A
nested run mints a token of its own, as `tests/helpers/file-isolation/global-setup.ts` does. A run
drops only what it created; anything a crashed run left behind is dropped by `reapAbandoned` once it
is older than any live run could be.

None of those drops happens where vitest is timing something. `DROP DATABASE`
forces a cluster-wide checkpoint and waits for it, which is a wait no test owns. A slot database is
dropped only by the run's global teardown; any other database is given back through
`scratch-db.ts:retireScratchDb` and dropped by a drain behind the test. A teardown waits out that drain for a grace of its
own choosing and then stops; what the grace did not reach is dropped by the run's
global teardown, which vitest gives no budget at all, and after that by the next
run's `reapAbandoned`. `scratch-db.test.ts` holds every file under `tests/` to
that rule, so a teardown written by hand cannot quietly put the wait back
(ISS-1141).

This is load-bearing rather than tidy. The template used to be the single fixed
name `forge_test_tpl`, dropped and recreated at the start of every run, so two
runs entering setup together destroyed each other's template and the loser
reported `template database "forge_test_tpl" does not exist` — a failure naming
a Postgres object, on files the change never touched (ISS-937).

### How many files run at once

`tests/helpers/integration-workers.ts:integrationWorkers` decides, from the machine the run is on,
and global setup prints what vitest resolved before the first file:
`[integration] 6 worker(s) on 4 core(s) — a GitHub-hosted runner, 1.5 per core`.

| Where | Workers | Why |
| ----- | ------- | --- |
| A GitHub-hosted runner (`GITHUB_ACTIONS=true` and `RUNNER_ENVIRONMENT=github-hosted`) | its cores × `HOSTED_WORKERS_PER_CORE` | One job and one package on a VM of its own: nothing to share the cores with. |
| Anywhere else | a quarter of the cores, at least 1, at most 3 | vitest's default is one worker per core PER PACKAGE and turbo fans packages out together, which put a 12-core box at load average 27. |
| Either, with `VITEST_MAX_WORKERS=<n>` | `n` | A one-off run. A value that is not a positive whole number is refused by name; an empty one reads as unset. |

A `--maxWorkers` on the command line beats the machine's rule, and the printed line names the flag
and the count the rule would have given. Giving it beside `VITEST_MAX_WORKERS` is refused before any
file runs, naming both: vitest reads the variable after the command line and would drop the flag
without a word, so the run asks for one of the two.

Running files in parallel is safe because two files running at once never hold the same database:
each holds its worker slot's, and vitest gives a slot to one file at a time (see *One database per
worker slot*). `tests/integration/file-database-isolation-e2e.test.ts` goes red the day a file can
see a row, a seed row's absence, a sequence value or a table the file before it left.

### One database per worker slot

A run clones one database per worker slot, not one per file. `tests/helpers/slot-db.ts:claimSlotDatabase`
creates `test_w_<slot>_<token>` the first time a slot asks (`VITEST_POOL_ID`, 1 to `maxWorkers`)
and hands the same database to every file the slot runs after that. Before handing it over it
resets it, the same way for every file:

1. ends every connection the previous file left (`pg_terminate_backend`, waited on),
2. drops the schemas the queue makes at runtime (`slot-db.ts:RUNTIME_SCHEMAS`, which no migration
   makes), reads the schema and refuses on any difference from the clone it was,
3. empties every table the way `truncateAll` does between cases and removes every large object,
4. writes back the rows the template seeds and sets every sequence to its cloned value.

The schema is read from every catalog the database holds, not from a list of object kinds
(`slot-db.ts:schemaChangesOn`): one hash over every row of every database-local table in
`pg_catalog`, less the planner's statistics, large objects, the `pg_class` columns that move by
use (storage, row estimates, freeze horizons) and what a rewrite (`VACUUM FULL`, `CLUSTER`) moves
without changing the schema: a column's missing value (`atthasmissing`, `attmissingval`), which it
writes into the rows, and a TOAST table, which it drops where no live column needs one. Every row
belonging to a TOAST table is left out, and the storage options a table set on its TOAST table are
read as the table's. An object of the database is read by name and never by oid, so a rebuild that
hands its indexes, constraints and foreign-key triggers new oids, as `ALTER COLUMN ... TYPE` to the
type a column has does, is no difference. A rule, an aggregate, a comment, a collation, a
statistics object or a storage option is a difference as a table is;
`tests/integration/slot-digest-names-every-change-e2e.test.ts` plants each kind and the use that is
not one. Only once the hash moved are the rows grouped by the object they belong to and named the way
Postgres names it (`pg_describe_object`), to say what changed.

What it was cloned as — that hash with the named digest, the seed rows, the sequence values — is
kept on the database's own comment, read without connecting to it. The file's `cleanup()` closes
the app's pool for good (`src/db/client.ts:closeDbFor`, lifted by the next `setupTestDatabase`), so
work the app left running cannot open another one, and leaves the closed pool no socket to open, so
a statement still in its queue is refused rather than run on a reopened connection; it ends its own client, and only then terminates
whatever is still connected, naming it: what is left then is background work that outlived the
file, and the database cannot leave the slot while anything holds it. A statement that work sends on
a connection terminated under it is refused with `CONNECTION_CLOSED` by the patched driver
(`patches/postgres@3.4.9.patch`), not written to the dead socket. It then reads the schema again, so a file that changes it is refused at its own teardown,
naming the file and the objects it added, dropped or changed; the database is then renamed out of
the slot and dropped behind the run, and the next file in the slot gets a fresh clone. A file that
gave its database back without `cleanup()` is caught by the next file's step 2, which names it.

**A file that writes schema or runs a migration declares it** at its own call site,
`setupTestDatabase({ own: '<what it changes>' })`, and gets a `test_own_` clone nobody else is
handed, dropped behind it as every file's database once was. A declaration without a reason is
refused. A file asking for a second slot database while its first is still open is refused too,
because the second hand-out would reset the database under the first.

**What is traded.** A database per file isolated everything Postgres keeps per database; a slot
database isolates what the reset puts back — rows in `current_schema()`, seed rows, sequences, large
objects — and what the schema read compares, which is every catalog row of the database. It does not
isolate a row in a table outside `current_schema()` (of those, the read counts only
`drizzle.__drizzle_migrations`), or the planner statistics `ANALYZE` leaves. A file that writes a row
there, or depends on the statistics, declares `own`. Roles and tablespaces are the cluster's, not a
database's, and a database per file never isolated them either.

**What it costs on an instance that syncs to disk.** A database dropped after its file took its
dirty pages with it; a slot database keeps them, and every `TRUNCATE` a case's `truncateAll` issues
gives each table and index a new file. On a `fsync=on` instance one whole run left checkpoints
syncing 400,000 to 600,000 files and taking 360 to 516 seconds, and every `CREATE` or `DROP DATABASE`
waits on one: `shared-template-e2e` and `shared-template-global-setup-e2e`, whose cases do both, timed
out at 180s. The container this suite starts runs with `fsync=off` (`container.ts`), and global setup
prints a line naming the cost when the instance it was given syncs. Point `TEST_DATABASE_URL` at an
instance started with `-c fsync=off`, as *Running* below does.

**What it buys**, counted from `log_statement=ddl` over one whole local run at three workers:

| | `main` at `e4f44b66c`, a database per file | ISS-1315 at `ea09294f2`, a database per slot |
| --- | --- | --- |
| `CREATE DATABASE` | 537 — 405 per file, 108 per migration case, 24 templates | 167 — 3 slots, 6 in the isolation e2e's nested runs, 27 declared `own` (one of them the gone-template refusal, which Postgres rejects), 108 per case, 23 templates |
| `DROP DATABASE` | 537 | 167, plus 1 slot database renamed aside by the isolation e2e |
| Files / tests, green | 413 / 4276 | 423 / 4380 |
| Wall | 2429s at `fsync=on` | 1431s at `fsync=off` |

The `e4f44b66c` run went under `--sequence.shuffle.files --sequence.seed=1315` on 2026-10-25, the
`ea09294f2` run under `--sequence.shuffle --sequence.seed=1315` (tests shuffled inside each file
too) on 2026-10-26; both with `TEST_TEMPLATE_MODE=fresh` against a `pgvector/pgvector:pg17`
container of their own, on a 56-core box. The two walls ran at different `fsync` settings and are
not a comparison of the two designs. Nothing carrying either run's token was left in `pg_database`
after it.

**What ends it.** The trade holds while every file a slot runs reads only what the reset puts back.
The day a file has to depend on something the reset does not restore and cannot declare `own` for
it, or a reset costs more than the clone it replaces, a database per file comes back — `own` on
every call is that, without a code change.

**Re-deriving the factor.** It is a measurement, not a preference, and it goes stale when the
runner image or the suite changes. Push a throwaway branch carrying a workflow that runs this job's
own steps at `VITEST_MAX_WORKERS` = 1, 2, 4, 6 and 8, two runs each, and read each job's wall off
the Actions API. The factor is the smallest count whose mean wall is within 5% of the lowest mean,
divided by the runner's cores — a tie goes to the smaller count, because workers past the knee buy
flakes and no wall. Record the walls and the date beside `HOSTED_WORKERS_PER_CORE`, then delete the
branch. A leg that fails is read for a test that depends on order; that test is the finding, and
lowering the count to hide it is not an answer.

## Running

### Unit tests (always safe, no DB)

```bash
pnpm --filter @forge/core test
```

### Integration tests — local (schema mode)

```bash
# A Postgres for tests only, started once, that does not sync to disk.
docker run -d --name forge-test-pg -p 127.0.0.1:5433:5432 \
  -e POSTGRES_USER=forge -e POSTGRES_PASSWORD=forge_secret -e POSTGRES_DB=forge \
  pgvector/pgvector:pg17 -c fsync=off

export TEST_DATABASE_URL="postgres://forge:forge_secret@localhost:5433/forge"
pnpm --filter @forge/core test:integration
```

It is not the compose `postgres`: that one keeps the dev data on a volume and syncs to disk, and
against it `shared-template-e2e` and `shared-template-global-setup-e2e` time out (*What it costs on
an instance that syncs to disk* above). `fsync=off` loses what was written if the server crashes,
which a test database can afford and the dev one cannot. `TEST_DATABASE_URL` can point at any
Postgres started that way — including one other runs are using. See *Shared template* and
*Concurrent runs on one server* above for what keeps them apart.

### Integration tests — CI-style (Testcontainers)

```bash
pnpm --filter @forge/core test:integration:ci   # sets TEST_DB_MODE=container
```

Requires a docker daemon this user can reach. No shared Postgres needed.

## Writing a new integration test

```ts
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  setupTestDatabase,
  truncateAll,
  createTestUser,
  createTestProject,
  type TestDatabase,
} from '../helpers/index.js';

describe('my feature', () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await setupTestDatabase();
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(() => truncateAll(harness.db));

  it('does the thing', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    // ...assert against harness.db
  });
});
```

Rules:

- One `setupTestDatabase()` per file (inside `beforeAll`), given back with
  `cleanup()` in `afterAll`. The per-test reset happens in `beforeEach` via
  `truncateAll`; the per-file one is the slot's (*One database per worker slot*).
- Never issue DDL against the test DB from inside a test — migrations are the
  only source of schema changes. A file that has to declares
  `setupTestDatabase({ own: '<what it changes>' })`.
- Do not import `src/db/client.ts` in integration tests (it reads
  `DATABASE_URL`, not the test-scoped URL). Use `harness.db`.
- **Reaching production code that imports it — a mounted router, an exported
  query builder — is the one exception, and it has a shape.** Assign
  `process.env.DATABASE_URL = harness.url` first, then reach the module by
  `await import(...)` inside `beforeAll`. A static `import` is evaluated before
  any hook runs, so it binds `db` to whatever `DATABASE_URL` the shell carried
  and the case then passes or fails against a database that is not the fixture.
  `usage-session-index.test.ts:mountAgentSessions` and
  `issues-list-cost-index.test.ts:loadRollupQuery` are the worked examples.
  Assert through `harness.db` as before; this only governs how the module under
  test is loaded.

## CI wiring

`.github/workflows/ci.yml` runs `pnpm --filter @forge/core test` (unit only) in
the `core` job. The integration suite runs in `core-integration` as
`TEST_DB_MODE=container pnpm --filter @forge/core test:integration:coverage`.
