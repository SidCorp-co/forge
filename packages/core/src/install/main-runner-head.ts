/**
 * The newest commit under `packages/runner` on the default branch — the half of the
 * comparison the published release cannot make, because a failed auto-release
 * publishes nothing and leaves a stale box reading current (ISS-1165).
 */
const REPO = process.env.RUNNER_RELEASE_REPO ?? 'SidCorp-co/forge';
const BRANCH = process.env.RUNNER_RELEASE_BRANCH ?? 'main';
const RUNNER_PATH = 'packages/runner';

interface CommitRow {
  sha: string;
}

let cached: string | null = null;

/** The head this process last read, or null when it has never read one. */
export function mainRunnerHead(): string | null {
  return cached;
}

export function setMainRunnerHead(sha: string | null): void {
  cached = sha;
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    'user-agent': 'forge-core-release-fetch',
    accept: 'application/vnd.github+json',
  };
  const token = process.env.RUNNER_RELEASE_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/**
 * Answers null rather than throwing, and the cache keeps what it last knew: one bad
 * response is not evidence that the branch moved.
 */
export async function refreshMainRunnerHead(): Promise<string | null> {
  const url =
    `https://api.github.com/repos/${REPO}/commits` +
    `?sha=${encodeURIComponent(BRANCH)}&path=${encodeURIComponent(RUNNER_PATH)}&per_page=1`;
  try {
    const res = await fetch(url, { headers: ghHeaders() });
    if (!res.ok) throw new Error(`GitHub commits API ${res.status}`);
    const rows = (await res.json()) as CommitRow[];
    const sha = Array.isArray(rows) ? rows[0]?.sha : undefined;
    if (typeof sha !== 'string' || sha.length === 0) {
      throw new Error(`no commit under ${RUNNER_PATH} on ${BRANCH}`);
    }
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
