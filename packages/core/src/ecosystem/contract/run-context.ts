import { REPO_PATH } from '@forge/contracts/repo-path';
import { callSiteAt } from '../link-schema.js';
import type { ImpactCallSite, ImpactChange } from './impact.js';
import { compareVersions, type Versioning } from './naming.js';

export interface ContextLink {
  id: string;
  provider: string;
  contractSlug: string;
  pinnedVersion: string;
  callSites: readonly ImpactCallSite[];
  notes: readonly string[];
}

/** One recorded version of a contract, as `versionsOf` reads it: newest first. */
export interface ContextVersion {
  version: string;
  changes: readonly ImpactChange[];
}

type DiffNote = 'measured' | 'already-on-latest' | 'no-version-recorded';

export interface LoadedContract {
  link: string;
  contract: { provider: string; slug: string };
  paths: string[];
  callSites: ImpactCallSite[];
  from: string;
  to: string | null;
  diffNote: DiffNote;
  guide: string[];
  diff: (ImpactChange & { version: string })[];
}

const DIFF_NOTE_TEXT: Record<DiffNote, string> = {
  measured: 'the measured changes between the two versions',
  'already-on-latest': 'the consumer is already on the latest version, so there is no diff',
  'no-version-recorded':
    'the provider has recorded no version of this contract, so there is no diff',
};

const normal = (p: string) => p.trim().replace(/^\.\//, '').replace(/\/+$/, '');

// a path matches a call site when it names that file or a directory holding it: a run that names `cli/src` touches every call site under it, and one naming a sibling touches none
const covers = (path: string, site: string) => site === path || site.startsWith(`${path}/`);

// the diff a consumer moves through is every version after the one it is pinned to, up to the latest, oldest first: one version's measured changes are against its predecessor only
function diffBetween(
  versioning: Versioning,
  pinned: string,
  versions: readonly ContextVersion[],
): Pick<LoadedContract, 'to' | 'diffNote' | 'diff'> {
  const latest = versions[0];
  if (!latest) return { to: null, diffNote: 'no-version-recorded', diff: [] };
  if (compareVersions(versioning, pinned, latest.version) >= 0) {
    return { to: latest.version, diffNote: 'already-on-latest', diff: [] };
  }
  const between = versions
    .filter(
      (v) =>
        compareVersions(versioning, v.version, pinned) > 0 &&
        compareVersions(versioning, v.version, latest.version) <= 0,
    )
    .sort((a, b) => compareVersions(versioning, a.version, b.version));
  return {
    to: latest.version,
    diffNote: 'measured',
    diff: between.flatMap((v) => v.changes.map((c) => ({ ...c, version: v.version }))),
  };
}

/**
 * What a run touching `paths` is given about the contracts it calls: for each link with a call
 * site under one of them, that link's guide notes and the diff from its pinned version to the
 * latest. A link no path reaches contributes nothing.
 */
export function contractContext(input: {
  paths: readonly string[];
  links: readonly ContextLink[];
  versionsOf: (link: ContextLink) => readonly ContextVersion[];
  versioningOf: (link: ContextLink) => Versioning;
}): LoadedContract[] {
  const paths = [...new Set(input.paths.map(normal).filter((p) => p.length > 0))];
  const out: LoadedContract[] = [];
  for (const link of input.links) {
    const matched = paths.filter((p) =>
      link.callSites.some((s) => s.path !== undefined && covers(p, s.path)),
    );
    if (matched.length === 0) continue;
    out.push({
      link: link.id,
      contract: { provider: link.provider, slug: link.contractSlug },
      paths: matched,
      callSites: link.callSites.filter(
        (s) => s.path !== undefined && matched.some((p) => covers(p, s.path as string)),
      ),
      from: link.pinnedVersion,
      guide: [...link.notes],
      ...diffBetween(input.versioningOf(link), link.pinnedVersion, input.versionsOf(link)),
    });
  }
  return out;
}

const PATH_TOKEN = /(?:^|[\s`'"([])((?:[\w.@-]+\/)+[\w.@-]+)/g;

/** The repository paths an issue's text names, as `a/b` tokens a link's call sites can match. */
export function pathsNamedIn(text: string): string[] {
  const found = [...text.matchAll(PATH_TOKEN)].map((m) => normal(m[1] ?? ''));
  return [...new Set(found.filter((p) => REPO_PATH.test(p) && !/^https?:/.test(p)))];
}

/** The prompt block a run is given: the guide and diff of each matched link, nothing else. */
export function renderContractContext(loaded: readonly LoadedContract[]): string | null {
  if (loaded.length === 0) return null;
  const parts = loaded.map((l) => {
    const head = `### ${l.contract.slug} (link ${l.link}) — ${l.from} → ${l.to ?? 'none recorded'}`;
    const why = `Loaded because this run touches ${l.paths.map((p) => `\`${p}\``).join(', ')}, which holds call sites ${l.callSites.map((s) => `${callSiteAt(s)} (${s.operation})`).join(', ')}.`;
    const guide = l.guide.length
      ? ['Guide:', ...l.guide.map((n) => `- ${n}`)].join('\n')
      : 'Guide: the link records no notes.';
    const diff =
      l.diff.length === 0
        ? `Diff: none — ${DIFF_NOTE_TEXT[l.diffNote]}.`
        : [
            `Diff (${DIFF_NOTE_TEXT[l.diffNote]}):`,
            ...l.diff.map((c) => `- [${c.version}] ${c.level} ${c.kind} ${c.element}: ${c.text}`),
          ].join('\n');
    return [head, why, guide, diff].join('\n');
  });
  return ['## Contracts this run calls', ...parts].join('\n\n');
}

/** What the run's record keeps of a load: which link, why, from→to, and how much was given. */
export function contractContextRecord(loaded: readonly LoadedContract[], source: string) {
  return {
    source,
    loadedAt: new Date().toISOString(),
    links: loaded.map((l) => ({
      link: l.link,
      contract: l.contract,
      paths: l.paths,
      from: l.from,
      to: l.to,
      diffNote: l.diffNote,
      guideNotes: l.guide.length,
      changes: l.diff.length,
    })),
  };
}
