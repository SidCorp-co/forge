/**
 * The newest commit under `packages/runner` on the default branch — the half of the
 * comparison the published release cannot make, because a failed auto-release
 * publishes nothing and leaves a stale box reading current (ISS-1165).
 *
 * For a pull request merged with a merge commit this is its head, never the merge a
 * release is stamped at, so a release is compared with it by containment.
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

const COMPARE_DEADLINE_MS = 5_000;
const contains = new Map<string, boolean>();

/** Forgets every answer `releaseContainsRunnerHead` remembered. */
export function forgetReleaseContainment(): void {
  contains.clear();
}

/**
 * Whether the release's commit is the runner head or a descendant of it, by GitHub's
 * compare of `head...release`. Null where GitHub could not say, which is core's blind
 * spot and never `false`. An answer is kept, ancestry cannot change; a failure is not.
 */
export async function releaseContainsRunnerHead(
  release: string,
  head: string,
): Promise<boolean | null> {
  const key = `${head}...${release}`;
  const known = contains.get(key);
  if (known !== undefined) return known;
  const url = `https://api.github.com/repos/${REPO}/compare/${key}?per_page=1`;
  // A request path awaits this, so a stalled GitHub must read as unanswered, body included.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), COMPARE_DEADLINE_MS);
  try {
    const res = await fetch(url, { headers: ghHeaders(), signal: deadline.signal });
    if (!res.ok) throw new Error(`GitHub compare API ${res.status}`);
    const body = (await res.json()) as { status?: unknown };
    const held =
      body.status === 'ahead' || body.status === 'identical'
        ? true
        : body.status === 'behind' || body.status === 'diverged'
          ? false
          : null;
    if (held === null) throw new Error(`GitHub compare API answered status ${String(body.status)}`);
    contains.set(key, held);
    return held;
  } catch (err) {
    console.warn(
      `[runner-head] could not compare ${short(head)} with release ${short(release)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function short(sha: string): string {
  return sha.length > 10 ? sha.slice(0, 10) : sha;
}
