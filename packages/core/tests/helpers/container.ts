import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export interface StartedContainer {
  url: string;
  stop: () => Promise<void>;
}

/**
 * Boot a throwaway Postgres 17 container for the current test run.
 * Used when TEST_DB_MODE=container (CI, fresh clones).
 *
 * Uses `pgvector/pgvector:pg17` so the ADR-0011 `vector` extension is
 * available — required by migration 0010 (`CREATE EXTENSION vector`).
 */
// cm:guard a container that never started is an ENVIRONMENT condition and must say so by name. Testcontainers reports an unreachable daemon as a connection error deep in its own stack, and vitest surfaces that as a failed suite — so a box whose docker socket refuses the runner (`permission denied ... /var/run/docker.sock`, measured on forge-vm 2026-09-06) reads as a broken test suite rather than as a missing prerequisite, and the reader has no way to tell which. Naming the condition here is what makes `TEST_DATABASE_URL` findable instead of guessable.
export async function startPostgresContainer(): Promise<StartedContainer> {
  let container: StartedPostgreSqlContainer;
  try {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg17')
      .withDatabase('forge_test')
      .withUsername('forge')
      .withPassword('forge')
      .start();
  } catch (err) {
    throw new Error(
      'could not start a Postgres container, so the integration suite has no database. ' +
        'This is an ENVIRONMENT condition, not a failure of the code under test: ' +
        'Testcontainers needs a docker daemon this user can reach. Either fix docker access, ' +
        'or point the suite at a Postgres you already have with ' +
        'TEST_DATABASE_URL=postgres://user:pass@host:5432/db — see packages/core/tests/README.md. ' +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}
