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
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'pgvector/pgvector:pg17',
  )
    .withDatabase('forge_test')
    .withUsername('forge')
    .withPassword('forge')
    .start();

  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}
