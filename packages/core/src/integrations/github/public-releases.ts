/**
 * Reads of a public GitHub repository with no connection behind them: the runner's own releases
 * and pinned tool downloads. Imports nothing but the platform, because the image build runs it
 * before anything else exists.
 */

const USER_AGENT = 'forge-core-release-fetch';

export interface PublicReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface PublicRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: PublicReleaseAsset[];
}

function apiHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: 'application/vnd.github+json',
  };
  const token = process.env.RUNNER_RELEASE_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

export async function listRepoReleases(repo: string): Promise<PublicRelease[]> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=50`, {
    headers: apiHeaders(),
  });
  if (!res.ok) throw new Error(`GitHub releases API ${res.status}`);
  return (await res.json()) as PublicRelease[];
}

/** The newest commit touching `path` on `branch`; throws naming what it could not read. */
export async function latestCommitUnder(
  repo: string,
  branch: string,
  path: string,
): Promise<string> {
  const url =
    `https://api.github.com/repos/${repo}/commits` +
    `?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}&per_page=1`;
  const res = await fetch(url, { headers: apiHeaders() });
  if (!res.ok) throw new Error(`GitHub commits API ${res.status}`);
  const rows = (await res.json()) as Array<{ sha?: unknown }>;
  const sha = Array.isArray(rows) ? rows[0]?.sha : undefined;
  if (typeof sha !== 'string' || sha.length === 0) {
    throw new Error(`no commit under ${path} on ${branch}`);
  }
  return sha;
}

export function releaseDownloadUrl(repo: string, tag: string, name: string): string {
  return `https://github.com/${repo}/releases/download/${tag}/${name}`;
}

export type AssetDownload = { ok: true; bytes: Buffer } | { ok: false; status: number };

export async function downloadReleaseAsset(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<AssetDownload> {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    redirect: 'follow',
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, bytes: Buffer.from(await res.arrayBuffer()) };
}
