/**
 * The newest commit under `packages/runner` on the default branch — the half of the
 * comparison the published release cannot make, because a failed auto-release
 * publishes nothing and leaves a stale box reading current (ISS-1165).
 */
import { latestCommitUnder } from './public-releases.js';

const REPO = process.env.RUNNER_RELEASE_REPO ?? 'SidCorp-co/forge';
const BRANCH = 'main';
const RUNNER_PATH = 'packages/runner';

let cached: string | null = null;

/** The head this process last read, or null when it has never read one. */
export function mainRunnerHead(): string | null {
  return cached;
}

/**
 * Answers null rather than throwing, and the cache keeps what it last knew: one bad
 * response is not evidence that the branch moved.
 */
export async function refreshMainRunnerHead(): Promise<string | null> {
  try {
    const sha = await latestCommitUnder(REPO, BRANCH, RUNNER_PATH);
    cached = sha;
    return sha;
  } catch (err) {
    console.warn(
      `[runner-head] could not read ${RUNNER_PATH}@${BRANCH}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
