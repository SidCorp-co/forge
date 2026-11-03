// What is live for a person's home (ISS-919): each project's latest release on production and on
// testing, from the release list the Releases page reads, with how many of the person's items it
// carried; and, for the search, the release an issue went live in.

import type { HomeLiveRelease } from '@forge/contracts/owner-home';
import type { ReleaseListResponse, ReleaseSummary } from '@forge/contracts/releases';
import { listReleases } from '../release-batch/index.js';
import type { HomeProject } from './home-moving.js';

export type ReleaseEnvironment = HomeLiveRelease['environment'];

/** The environment a release went out to; null while it has not gone out. */
export function environmentOf(r: ReleaseSummary): ReleaseEnvironment | null {
  if (!r.releasedAt) return null;
  if (r.state === 'shipped') return 'production';
  if (r.state === 'landed') return 'testing';
  return null;
}

const keysOf = (r: ReleaseSummary) => r.contents.flatMap((g) => g.issues.map((i) => i.key));

export async function releasesOf(projectId: string): Promise<ReleaseListResponse> {
  return listReleases(projectId, null);
}

/** The project's latest release per environment, production first, with the person's items it carried. */
export function liveOf(
  project: HomeProject,
  list: ReleaseListResponse,
  mine: ReadonlySet<string>,
): HomeLiveRelease[] {
  const out: HomeLiveRelease[] = [];
  for (const env of ['production', 'testing'] as const) {
    const latest = list.releases
      .filter((r) => environmentOf(r) === env)
      .sort((a, b) => (b.releasedAt ?? '').localeCompare(a.releasedAt ?? ''))[0];
    if (!latest?.releasedAt) continue;
    out.push({
      projectSlug: project.slug,
      projectName: project.name,
      environment: env,
      environmentName:
        env === 'production' ? (list.production.ok ? list.production.name : null) : latest.landedOn,
      version: latest.version,
      name: latest.name,
      at: latest.releasedAt,
      mine: keysOf(latest).filter((k) => mine.has(k)).length,
    });
  }
  return out;
}

export interface WentLive {
  environment: ReleaseEnvironment;
  version: string;
  since: string;
}

/** The first release that carried `key`, production before testing; null where none went out. */
function firstCarrying(list: ReleaseListResponse, key: string): WentLive | null {
  const carrying = list.releases
    .filter((r) => environmentOf(r) !== null && keysOf(r).includes(key))
    .sort((a, b) => (a.releasedAt ?? '').localeCompare(b.releasedAt ?? ''));
  const first =
    carrying.find((r) => environmentOf(r) === 'production') ??
    carrying.find((r) => environmentOf(r) === 'testing');
  const env = first ? environmentOf(first) : null;
  return first?.releasedAt && env
    ? { environment: env, version: first.version, since: first.releasedAt }
    : null;
}

/**
 * Where an item whose work is `keys` went live: the release that carried the last of them, on
 * testing if any went out only there. Null where any of them has gone out nowhere, or there are none.
 */
export function wentLiveIn(list: ReleaseListResponse, keys: readonly string[]): WentLive | null {
  if (keys.length === 0) return null;
  const each = keys.map((k) => firstCarrying(list, k));
  if (each.some((w) => w === null)) return null;
  const all = each as WentLive[];
  const environment = all.some((w) => w.environment === 'testing') ? 'testing' : 'production';
  const last = all.sort((a, b) => b.since.localeCompare(a.since))[0] as WentLive;
  return { ...last, environment };
}
