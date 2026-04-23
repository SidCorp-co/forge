import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export interface StartedContainer {
  url: string;
  stop: () => Promise<void>;
}

/**
 * Boot a throwaway Postgres 17 container for the current test run.
 * Used when TEST_DB_MODE=container (CI, fresh clones).
 */
export async function startPostgresContainer(): Promise<StartedContainer> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:17-alpine')
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
