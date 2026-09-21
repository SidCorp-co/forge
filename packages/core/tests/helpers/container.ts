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
