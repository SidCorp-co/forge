import { resolve } from 'node:path';
import { fetchOasdiff, OASDIFF_VERSION } from './oasdiff.js';

const dir = process.argv[2];
if (!dir) {
  console.error('oasdiff-fetch: name the directory to install oasdiff into');
  process.exit(2);
}
try {
  const bin = await fetchOasdiff(resolve(dir));
  console.log(`oasdiff ${OASDIFF_VERSION} at ${bin}`);
} catch (err) {
  console.error(`oasdiff-fetch: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
