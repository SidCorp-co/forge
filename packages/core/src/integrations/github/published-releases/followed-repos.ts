/**
 * A public GitHub repository a project follows (ISS-1252): its newest releases, or its tags where it
 * publishes none, and whether it is archived and when it was last pushed. GitHub's public REST API
 * with no connection behind it, under the same headers the runner's release fetch sends (an
 * instance token where one is set, raising the limit; none needed for a public repository). The list
 * is asked with the ETag of the last read, so an unchanged list answers 304 and costs no rate limit;
 * a spent limit is answered by name with when it resets, never retried here.
 */

import { publicApiHeaders } from './public-releases.js';

const API = 'https://api.github.com';
const PAGE = 20;
const TIMEOUT_MS = 15_000;

export interface FollowedRelease {
  tag: string;
  name: string | null;
  url: string;
  /** The release notes, empty for a bare tag. */
  body: string;
  publishedAt: string | null;
}

export interface FollowedRepoFacts {
  archived: boolean;
  pushedAt: string | null;
}

export type FollowedRead =
  | { ok: true; repo: FollowedRepoFacts; unchanged: true; etag: string | null }
  | {
      ok: true;
      repo: FollowedRepoFacts;
      unchanged: false;
      etag: string | null;
      /** Newest first. */
      releases: FollowedRelease[];
      from: 'releases' | 'tags';
    }
  | { ok: false; status: number; reason: string; resetsAt: string | null };

interface Got {
  status: number;
  etag: string | null;
  body: unknown;
  limited: string | null;
}

/** When the limit resets, where this answer says the hourly limit is spent; null otherwise. */
function spentLimit(res: Response): string | null {
  if (res.status !== 403 && res.status !== 429) return null;
  if (res.headers.get('x-ratelimit-remaining') !== '0' && res.status !== 429) return null;
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  return Number.isFinite(reset) && reset > 0
    ? new Date(reset * 1000).toISOString()
    : new Date().toISOString();
}

async function get(path: string, etag?: string | null): Promise<Got> {
  const headers = publicApiHeaders();
  if (etag) headers['if-none-match'] = etag;
  const res = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const limited = spentLimit(res);
  const body = res.status === 200 ? ((await res.json()) as unknown) : null;
  return { status: res.status, etag: res.headers.get('etag'), body, limited };
}

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function releasesOf(repo: string, body: unknown): FollowedRelease[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((r: Record<string, unknown>) => {
    const tag = text(r.tag_name);
    if (!tag || r.draft === true) return [];
    return [
      {
        tag,
        name: text(r.name),
        url:
          text(r.html_url) ?? `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
        body: text(r.body) ?? '',
        publishedAt: text(r.published_at),
      },
    ];
  });
}

function tagsOf(repo: string, body: unknown): FollowedRelease[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((t: Record<string, unknown>) => {
    const tag = text(t.name);
    return tag
      ? [
          {
            tag,
            name: null,
            url: `https://github.com/${repo}/tree/${encodeURIComponent(tag)}`,
            body: '',
            publishedAt: null,
          },
        ]
      : [];
  });
}

const failed = (got: Got, what: string): FollowedRead => ({
  ok: false,
  status: got.status,
  reason: got.limited
    ? `GitHub's rate limit is spent reading ${what}; it resets at ${got.limited}`
    : `GitHub answered ${got.status} reading ${what}`,
  resetsAt: got.limited,
});

/** The repository `owner/name`'s newest releases (or tags), unless unchanged since `etag`. */
export async function readFollowedRepo(
  repo: string,
  etag: string | null = null,
): Promise<FollowedRead> {
  const meta = await get(`/repos/${repo}`);
  if (meta.status !== 200) return failed(meta, `${repo}`);
  const m = meta.body as Record<string, unknown>;
  const facts: FollowedRepoFacts = { archived: m.archived === true, pushedAt: text(m.pushed_at) };

  const releases = await get(`/repos/${repo}/releases?per_page=${PAGE}`, etag);
  if (releases.status === 304) return { ok: true, repo: facts, unchanged: true, etag };
  if (releases.status !== 200) return failed(releases, `${repo}'s releases`);
  const read = releasesOf(repo, releases.body);
  if (read.length > 0) {
    return {
      ok: true,
      repo: facts,
      unchanged: false,
      etag: releases.etag,
      releases: read,
      from: 'releases',
    };
  }
  const tags = await get(`/repos/${repo}/tags?per_page=${PAGE}`);
  if (tags.status !== 200) return failed(tags, `${repo}'s tags`);
  return {
    ok: true,
    repo: facts,
    unchanged: false,
    // an empty release list stays unchanged while tags move, so a tags read keeps no ETag
    etag: null,
    releases: tagsOf(repo, tags.body),
    from: 'tags',
  };
}
