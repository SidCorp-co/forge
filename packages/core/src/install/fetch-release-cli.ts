import { run } from './fetch-release.js';

run()
  .catch((err) => {
    console.warn(`[runner-release] skipped: ${err instanceof Error ? err.message : String(err)}`);
  })
  .finally(() => process.exit(0));
