import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestProject } from 'vitest/node';
import { resolveDbSource } from './schema-mode.js';

const container = vi.hoisted(() => ({
  startPostgresContainer: vi.fn(async () => {
    throw new Error('a container was started');
  }),
}));
vi.mock('./container.js', () => container);

const URL_NAMED = 'postgres://forge:forge_secret@localhost:5433/forge';

describe('resolveDbSource', () => {
  it('takes the server TEST_DATABASE_URL names in schema mode, set or defaulted', () => {
    expect(resolveDbSource({ TEST_DB_MODE: 'schema', TEST_DATABASE_URL: URL_NAMED })).toEqual({
      mode: 'schema',
      url: URL_NAMED,
    });
    expect(resolveDbSource({ TEST_DATABASE_URL: URL_NAMED })).toEqual({
      mode: 'schema',
      url: URL_NAMED,
    });
  });

  it('starts a container where the caller asked for one, whatever TEST_DATABASE_URL names', () => {
    expect(resolveDbSource({})).toEqual({ mode: 'container' });
    expect(resolveDbSource({ TEST_DB_MODE: 'container', TEST_DATABASE_URL: URL_NAMED })).toEqual({
      mode: 'container',
    });
  });

  it('refuses schema mode with no server named, saying which variable to set', () => {
    for (const unset of [undefined, '']) {
      expect(() => resolveDbSource({ TEST_DB_MODE: 'schema', TEST_DATABASE_URL: unset })).toThrow(
        'TEST_DATABASE_URL is required when TEST_DB_MODE=schema',
      );
    }
  });

  it('refuses a mode that is neither, by its value', () => {
    expect(() =>
      resolveDbSource({ TEST_DB_MODE: 'schemas', TEST_DATABASE_URL: URL_NAMED }),
    ).toThrow('TEST_DB_MODE="schemas" is not a database mode');
  });
});

describe('the integration global setup in schema mode with no server named', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is refused by name, and no container stands in for the server', async () => {
    vi.stubEnv('TEST_DB_MODE', 'schema');
    vi.stubEnv('TEST_DATABASE_URL', '');
    const { setup } = await import('./global-setup.js');
    const project = {
      vitest: { config: { cliOptions: {} } },
      config: { maxWorkers: 1 },
    } as unknown as TestProject;

    await expect(setup(project)).rejects.toThrow(
      'TEST_DATABASE_URL is required when TEST_DB_MODE=schema',
    );
    expect(container.startPostgresContainer).not.toHaveBeenCalled();
  });
});
