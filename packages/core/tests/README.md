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
`forge_test_tpl_<stamp>_<rand>` and each worker's clone is
`test_w<id>_<stamp>_<rand>`, both minted in `tests/helpers/scratch-db.ts`. A run
drops only what it created; anything a crashed run left behind is dropped by
`reapAbandoned` once it is older than any live run could be.

This is load-bearing rather than tidy. The template used to be the single fixed
name `forge_test_tpl`, dropped and recreated at the start of every run, so two
runs entering setup together destroyed each other's template and the loser
reported `template database "forge_test_tpl" does not exist` — a failure naming
a Postgres object, on files the change never touched (ISS-937).

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

## CI wiring

`.github/workflows/ci.yml` runs `pnpm --filter @forge/core test` (unit only) in
the `core` job. The integration suite runs in `core-integration` as
`TEST_DB_MODE=container pnpm --filter @forge/core test:integration:coverage`.
