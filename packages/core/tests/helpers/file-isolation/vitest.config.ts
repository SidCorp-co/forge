import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

// No global setup: the files clone the outer run's template (inherited TEST_PG_ADMIN_URL and
// TEST_PG_TEMPLATE), so what they mint carries that run's token and its teardown sweeps it.
class WriterFirst extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const writer = (f: TestSpecification): number =>
      f.moduleId.endsWith('writer.fixture.ts') ? 0 : 1;
    return [...files].sort((a, b) => writer(a) - writer(b));
  }
}

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('../../..', import.meta.url)),
    include: ['tests/helpers/file-isolation/*.fixture.ts'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: true,
    maxWorkers: Number(process.env.ISOLATION_WORKERS),
    sequence: { sequencer: WriterFirst },
    // Relative to `root` above, which is what vitest and the whole-tree gate both resolve it from.
    setupFiles: ['../../scripts/lib/whole-tree-guard.mjs'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
