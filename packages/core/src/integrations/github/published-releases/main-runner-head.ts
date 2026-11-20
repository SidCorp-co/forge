/**
 * The newest commit under `packages/runner` on the branch this core's runner channel is cut from —
 * `main`, or `dev` on the dev channel (ISS-1358) — the half of the comparison the published release
 * cannot make, because a failed auto-release publishes nothing and leaves a stale box reading
 * current (ISS-1165).
 */
import { channelBranch, servedRunnerChannel } from './channel.js';
import { latestCommitUnder } from './public-releases.js';

const REPO = process.env.RUNNER_RELEASE_REPO ?? 'SidCorp-co/forge';
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
  let branch = 'the channel branch';
  try {
    branch = channelBranch(servedRunnerChannel());
    const sha = await latestCommitUnder(REPO, branch, RUNNER_PATH);
    cached = sha;
    return sha;
  } catch (err) {
    console.warn(
      `[runner-head] could not read ${RUNNER_PATH}@${branch}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
