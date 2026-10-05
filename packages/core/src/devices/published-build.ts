import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const RELEASE_DIR = process.env.RUNNER_RELEASE_DIR ?? '';

/** What a published runner release is: a version and the commit it was built from. */
interface PublishedRunnerBuild {
  version: string;
  /** null for a release published before runner-release.yml wrote COMMIT. */
  commit: string | null;
}

/**
 * The published runner build (the `VERSION` and `COMMIT` files in
 * `RUNNER_RELEASE_DIR`), or null when nothing is published / the dir is unset.
 *
 * The devices and runners kernels read it to flag boxes that lag it (ISS-392). The commit
 * rides along because the version alone cannot tell a released 0.17.0 from a
 * hand-built one, which is how seven landed runner commits reached no box while
 * every surface read healthy (ISS-1165).
 */
export async function getPublishedRunnerBuild(): Promise<PublishedRunnerBuild | null> {
  if (!RELEASE_DIR) return null;
  const read = async (name: string) => {
    try {
      return (await readFile(join(RELEASE_DIR, name), 'utf8')).trim() || null;
    } catch {
      return null;
    }
  };
  const version = await read('VERSION');
  if (!version) return null;
  return { version, commit: await read('COMMIT') };
}
