// ISS-1077 — a production of several sites: where each site stands on a release, and the record that
// ships it. A release is its agent's record (owner 2026-11-01, `release-is-the-agents-record`), so a
// site reads shipped only where that record names it, with the version or commit the agent read it
// serving through the site's own runtime verification; Forge compares no commit. A release whose
// record leaves a site out is refused by that site's name, and holds as not shipped until every site
// is recorded or the run is aborted: no `partial` state lets its issues close while a site serves the
// old build.

import type { ReleaseSiteState, ReleaseSiteView, ReleaseState } from '@forge/contracts/releases';
import { deployHoldsOf } from '../pipeline/index.js';
import { pendingConfirmBindingsOf } from './coolify-prod-gate.js';
import { refuseRelease } from './refuse.js';

/** One site as a release's own record names it: shipped, serving `serves`. */
export interface SiteRecord {
  name: string;
  /** The version or commit the agent read the site serving, through its own runtime verification. */
  serves: string;
}

/**
 * What a release reads of one declared site: its name, the binding it deploys through, its origin.
 * A site deployed outside Forge has no binding (ISS-1139): no run deploys it, and only its record
 * says it shipped.
 */
export interface SiteChannel {
  site: string;
  bindingId: string | null;
  url: string | null;
}

/** The site record a run carries: its finish's, else a recorded release's. Null where none was written. */
export function recordedSitesOf(metadata: unknown): SiteRecord[] | null {
  const md = (metadata ?? {}) as { finish?: { sites?: unknown } | null; sites?: unknown };
  const raw = md.finish?.sites ?? md.sites;
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((r) => {
    const { name, serves } = (r ?? {}) as Partial<SiteRecord>;
    return typeof name === 'string' && typeof serves === 'string' ? [{ name, serves }] : [];
  });
}

/** Where one site stands on this run, read off its own deploys: never `shipped`, which only a record says. */
function deployStateOf(bindingId: string | null, metadata: unknown): ReleaseSiteState {
  if (bindingId === null) return 'not_reached';
  if (pendingConfirmBindingsOf(metadata).has(bindingId)) return 'awaiting_confirm';
  const holds = Object.values(deployHoldsOf(metadata)).filter((h) => h.bindingId === bindingId);
  if (holds.some((h) => h.status === 'pending')) return 'deploying';
  if (holds.some((h) => h.status === 'succeeded')) return 'deployed';
  if (holds.some((h) => h.status === 'failed')) return 'failed';
  return 'not_reached';
}

/**
 * Each declared site and where it stands on a release run: `shipped` where the record names it, else
 * what this run's own deploys of it say. A run with no record lists the sites production declares now.
 */
export function siteStatesOf(
  channels: readonly SiteChannel[],
  metadata: unknown,
): ReleaseSiteView[] {
  const recorded = new Map((recordedSitesOf(metadata) ?? []).map((r) => [r.name, r.serves]));
  return channels.map((c) => {
    const serves = recorded.get(c.site) ?? null;
    return {
      name: c.site,
      state: serves !== null ? 'shipped' : deployStateOf(c.bindingId, metadata),
      serves,
      url: c.url,
    };
  });
}

const STATE_WORDS: Record<ReleaseSiteState, string> = {
  shipped: 'shipped',
  deploying: 'its deploy is still running',
  deployed: 'deployed, and your record does not name it',
  awaiting_confirm: "its deploy waits on a person's confirm, so this run sent it nothing",
  failed: 'the deploy this run sent it failed',
  not_reached: 'this run sent it no deploy',
};

/**
 * The sites a release's record ships, admitted against the sites production declares: every one
 * named once, and none still waiting on its confirm on this run. A production of one site whose
 * record names none records that site serving `fallback` (the commit the finish names, else the
 * version) and is refused nothing new: a single-binding document reads as one site, and the body a
 * release job sends today finishes it as before.
 *
 * THROWS `RELEASE_SITE_UNDECLARED` for a name production does not declare or a site named twice, and
 * `RELEASE_SITE_NOT_SHIPPED` naming each site the record leaves out or that waits on its confirm.
 */
export function admitSiteRecord(
  channels: readonly SiteChannel[],
  named: readonly SiteRecord[] | undefined,
  ctx: { metadata: unknown; fallback: string; remedy: string },
): SiteRecord[] {
  const declared = channels.map((c) => c.site);
  if (channels.length === 0) {
    if (named && named.length > 0) {
      throw refuseRelease(
        'RELEASE_SITE_UNDECLARED',
        `This record names ${named.map((s) => `\`${s.name}\``).join(', ')}, and this project's production deploys through no binding, so it declares no site to record. Leave \`sites\` out.`,
      );
    }
    return [];
  }
  // a production of one site finishes as it always has: today's body, read as that site (ISS-1077)
  if (named === undefined && channels.length === 1) {
    return [{ name: declared[0] as string, serves: ctx.fallback }];
  }
  const sites: readonly SiteRecord[] = named ?? [];
  const seen = new Set<string>();
  for (const s of sites) {
    if (!declared.includes(s.name) || seen.has(s.name)) {
      throw refuseRelease(
        'RELEASE_SITE_UNDECLARED',
        `This record names site \`${s.name}\` ${seen.has(s.name) ? 'twice' : 'which production does not declare'}; production's sites are ${declared.map((d) => `\`${d}\``).join(', ')}, each named once.`,
      );
    }
    seen.add(s.name);
  }
  const pending = pendingConfirmBindingsOf(ctx.metadata);
  const waits = (c: SiteChannel) => c.bindingId !== null && pending.has(c.bindingId);
  const unshipped = channels.filter((c) => !seen.has(c.site) || waits(c));
  if (unshipped.length > 0) {
    const lines = unshipped.map((c) => {
      if (c.bindingId === null) return `\`${c.site}\` (${EXTERNAL_WORDS})`;
      const state = waits(c) ? 'awaiting_confirm' : deployStateOf(c.bindingId, ctx.metadata);
      return `\`${c.site}\` (${STATE_WORDS[state]})`;
    });
    throw refuseRelease(
      'RELEASE_SITE_NOT_SHIPPED',
      `This release is not shipped while a production site is not: ${lines.join('; ')}. Production's sites are ${declared.map((d) => `\`${d}\``).join(', ')}, and a record names every one in \`sites\`, each with the version or commit its own runtime verification reads it serving (\`[{"name":"<site>","serves":"<version or commit>"}]\`). ${ctx.remedy}`,
    );
  }
  return [...sites];
}

/** A site deployed outside Forge, which the record left out: no run deploys it, so only the record ships it. */
const EXTERNAL_WORDS =
  'deployed outside Forge, and your record does not name it: once its door deployed this release, name it with what its runtime verification reads it serving';

const ENDED: ReadonlySet<ReleaseState> = new Set(['shipped', 'landed', 'failed', 'aborted']);

/**
 * Each production site and where it stands on a cut release (ISS-1077). An open run reads every site
 * production declares now; an ended run its own record, else, where it never shipped, what its own
 * deploys say. A release that shipped before sites were recorded lists none: nothing says which it reached.
 */
export function releaseSitesOf(
  run: { runMetadata?: unknown; releasedAt: Date | null; state: ReleaseState },
  declared: readonly SiteChannel[],
): ReleaseSiteView[] {
  if (run.runMetadata === undefined) return [];
  const recorded = recordedSitesOf(run.runMetadata);
  const open = run.releasedAt === null && !ENDED.has(run.state);
  if (open || (recorded === null && run.state !== 'shipped')) {
    return siteStatesOf(declared, run.runMetadata);
  }
  const urls = new Map(declared.map((c) => [c.site, c.url]));
  return (recorded ?? []).map((r) => ({
    name: r.name,
    state: 'shipped' as const,
    serves: r.serves,
    url: urls.get(r.name) ?? null,
  }));
}
