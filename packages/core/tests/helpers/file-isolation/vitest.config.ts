import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

// The files clone the outer run's template (inherited TEST_PG_ADMIN_URL and TEST_PG_TEMPLATE) under
// a token this run mints in its own global setup. ISOLATION_INHERIT=1 leaves that setup out, so the
// files run under the outer run's token, which is the case a slot database must refuse.
const FILES = (process.env.ISOLATION_FILES ?? '').split(',').filter(Boolean);

class Listed extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const at = (f: TestSpecification): number =>
      FILES.findIndex((name) => f.moduleId.endsWith(`/${name}.fixture.ts`));
    return [...files].sort((a, b) => at(a) - at(b));
  }
}

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('../../..', import.meta.url)),
    include: FILES.map((name) => `tests/helpers/file-isolation/${name}.fixture.ts`),
    globalSetup:
      process.env.ISOLATION_INHERIT === '1' ? [] : ['tests/helpers/file-isolation/global-setup.ts'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: true,
    maxWorkers: Number(process.env.ISOLATION_WORKERS),
    sequence: { sequencer: Listed },
    // Relative to `root` above, which is what vitest and the whole-tree gate both resolve it from.
    setupFiles: ['../../scripts/lib/whole-tree-guard.mjs'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
