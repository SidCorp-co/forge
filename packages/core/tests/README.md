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
otherwise. **Testcontainers needs a docker daemon this user can reach**; where
it does not have one, `TEST_DATABASE_URL` is the only route into the suite, and
`startPostgresContainer` says so by name rather than letting an unreachable
socket surface as a broken suite.

Whichever mode resolves the server, `tests/helpers/global-setup.ts` migrates
**one template database** for the run and every test file clones it
(`CREATE DATABASE ... TEMPLATE`, a file copy) in `tests/helpers/db.ts`. That
replaces a container boot plus a full migration replay — measured at ~8.6s —
per test file.

**Why not just Testcontainers everywhere?** Cold boot is 3–5s per run, painful
on every local edit-test loop.

**Why not just schema mode everywhere?** CI runners do not always have a
long-lived Postgres. Testcontainers needs only Docker, which GitHub Actions'
`ubuntu-latest` provides.

### Concurrent runs on one server

Every database a run creates is named for that run: the template is
`forge_test_tpl_<stamp>_<rand>`, each file's clone is
`test_w_<token>_<id>_<stamp>_<rand>` and a migration case's is
`test_case_<token>_<tag>_<stamp>_<rand>`, all minted in
`tests/helpers/scratch-db.ts`. The token is the template's own stamp, so a run
can name its own databases and no other run's. A run drops only what it created;
anything a crashed run left behind is dropped by `reapAbandoned` once it is
older than any live run could be.

None of those drops happens where vitest is timing something. `DROP DATABASE`
forces a cluster-wide checkpoint and waits for it, which is a wait no test owns,
so a database is given back through `scratch-db.ts:retireScratchDb` and dropped
by a drain behind the test. A teardown waits out that drain for a grace of its
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

A `--maxWorkers` on the command line beats the machine's rule, and the printed line says so; it
does not beat `VITEST_MAX_WORKERS`, which vitest itself reads after the command line.

Running files in parallel is safe because every file clones a database of its own (see *Concurrent
runs on one server*); `tests/integration/file-database-isolation-e2e.test.ts` goes red the day two
files are given the same one.

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
# From repo root: start the shared Postgres once.
docker compose up -d postgres

export TEST_DATABASE_URL="postgres://forge:forge_secret@localhost:5432/forge"
pnpm --filter @forge/core test:integration
```

`TEST_DATABASE_URL` can point at any Postgres you have handy — including one
other runs are using. See *Concurrent runs on one server* above for what keeps
them apart.

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

- One `setupTestDatabase()` per file (inside `beforeAll`). The per-test
  reset happens in `beforeEach` via `truncateAll`.
- Never issue DDL against the test DB from inside a test — migrations are the
  only source of schema changes.
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
