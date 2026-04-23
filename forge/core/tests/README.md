# @forge/core — tests

Infrastructure for the Phase 2.1+ integration tests (Vitest + real Postgres).
Unit tests (with `vi.mock(...)` on the DB) live next to the source under
`src/**/*.test.ts` and do not need any of this.

## Decision — hybrid test DB strategy

Two modes, selected by the `TEST_DB_MODE` env var:

| Mode        | When                  | What happens                                                                                                          |
| ----------- | --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `container` | CI, fresh clones      | Boot `postgres:17-alpine` via Testcontainers per suite, run migrations, tear down.                                    |
| `schema`    | Local dev (preferred) | Create a disposable `test_w<workerId>_<rand>` schema inside `TEST_DATABASE_URL`, run migrations, drop after the run.  |

If `TEST_DB_MODE` is unset, we default to `schema` when `TEST_DATABASE_URL`
is set and `container` otherwise — so local flows work as soon as the
developer points at their compose Postgres, and CI works out of the box.

**Why not just Testcontainers everywhere?** Cold boot is 3–5s. That is fine
once per CI job but painful on every `pnpm test:integration` during local
edit-test loops. Per-worker schemas give the same isolation guarantees for
Vitest's fork pool without paying that cost repeatedly.

**Why not just schema mode everywhere?** CI runners do not always have a
long-lived Postgres. Testcontainers is self-contained and requires only
Docker, which GitHub Actions' `ubuntu-latest` provides.

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

`TEST_DATABASE_URL` can point at any Postgres you have handy. Each run creates
its own schema and drops it afterwards, so concurrent runs / parallel workers
do not collide.

### Integration tests — CI-style (Testcontainers)

```bash
pnpm --filter @forge/core test:integration:ci   # sets TEST_DB_MODE=container
```

Requires a local Docker daemon. No shared Postgres needed.

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

## Factories (`users`, `projects`)

`createTestUser` and `createTestProject` assume the `users` and `projects`
tables defined in RFC 0002 §Schema. Those tables are scheduled for Phase 2.1-A/B
and 2.1-C respectively. Until they land, the factories throw a clear error
with a pointer to the owning phase — the integration scaffolding ships today so
downstream PRs can write tests without first touching this file.

## Timing

Targets from the Phase 2.1-I acceptance criteria (`<30s` full sweep):

| Scenario                        | Expected  |
| ------------------------------- | --------- |
| Schema mode, smoke test         | < 2s      |
| Container mode, cold smoke test | 5–8s      |

Full Phase 2.1 integration sweep fits inside 30s as long as test files share
the per-worker schema pattern (set up once in `beforeAll`, not per test).

## CI wiring

`.github/workflows/ci.yml` runs `pnpm --filter @forge/core test` (unit only) on
every push. The integration job (Docker + Testcontainers) is gated on the
`core` path filter and invoked via `pnpm --filter @forge/core test:integration:ci`.
