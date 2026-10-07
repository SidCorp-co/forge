/**
 * What each issue's landing changed, by surface, and what a release's landings change together —
 * the "What changes" a release's approver reads before the notes.
 *
 * A landing that names its artifacts (`issues.merged_artifacts`: a mark outside git, a design
 * approval) is read as named. A git landing names none of its own: its commit's changed paths are
 * read through the source host and classified by the project document's `release.surfaces`, or by
 * the map shipped for forge-core's own tree where the repository is forge-core. A project declaring
 * no map has its paths shown unclassified, never guessed, and a prose landing written before
 * artifacts existed reads unclassified with why: docs/modules/issues/merge-mark.md.
 */

import { posix } from 'node:path';
import { parseRepository } from '@forge/contracts/git-repository';
import {
  designArtifact,
  designLandingRef,
  LANDING_SURFACES,
  type LandingArtifact,
  type LandingSurface,
  SHIPS_NOTHING,
} from '@forge/contracts/landing-artifacts';
import type {
  IssueLandingReading,
  ReleaseChangeRiskView,
  ReleaseChanges,
  ReleaseSurfaceChanges,
} from '@forge/contracts/releases';
import {
  type HostFileChange,
  resolveSourceHost,
  type SourceHost,
  SourceHostUnavailable,
} from '../integrations/source-host/index.js';
import { type ProjectDocument, readProjectDocument } from '../project-config/index.js';
import { changedFilesOf } from './carriage.js';

export type SurfaceMap = NonNullable<NonNullable<ProjectDocument['release']>['surfaces']>;

/** forge-core's own tree, for the project whose repository is forge-core and declares no map. */
export const FORGE_CORE_SURFACES: SurfaceMap = {
  rules: [
    { surface: 'data', paths: ['packages/core/drizzle/**'] },
    {
      surface: 'api',
      paths: [
        'packages/core/src/**/*routes.ts',
        'packages/core/contracts/**',
        'packages/contracts/src/**',
      ],
    },
    { surface: 'ui', paths: ['packages/web-v2/**'] },
    { surface: 'runner', paths: ['packages/runner/**'] },
    {
      surface: 'config',
      paths: [
        '.forge/**',
        '.github/**',
        'scripts/**',
        'package.json',
        'pnpm-workspace.yaml',
        'pnpm-lock.yaml',
        'turbo.json',
        'packages/*/package.json',
        'packages/*/Dockerfile',
      ],
    },
    { surface: 'logic', paths: ['packages/core/src/**', 'packages/observability/**'] },
  ],
  ignore: [
    'docs/**',
    'changelog.d/**',
    '**/*.md',
    '**/*.test.ts',
    '**/*.test.tsx',
    'packages/core/tests/**',
  ],
};

const FORGE_CORE_REPOSITORY = 'sidcorp-co/forge-core';

/** The map a project's git landings are classified by, or null where it declares none. */
export function surfaceMapOf(document: ProjectDocument | null): SurfaceMap | null {
  if (!document) return null;
  const declared = document.release?.surfaces;
  if (declared) return declared;
  if (document.source.type !== 'git') return null;
  const ref = parseRepository(document.source.git.repository);
  const path = ref.kind === 'local' ? '' : ref.path.replace(/\.git$/, '').toLowerCase();
  return path === FORGE_CORE_REPOSITORY ? FORGE_CORE_SURFACES : null;
}

const matches = (globs: readonly string[], path: string) =>
  globs.some((g) => posix.matchesGlob(path, g));

/** Each changed path's surface by the map's first matching rule; ignored paths drop out. */
export function classifyChanges(
  map: SurfaceMap,
  changes: readonly HostFileChange[],
): { artifacts: LandingArtifact[]; unmapped: string[] } {
  const artifacts: LandingArtifact[] = [];
  const unmapped: string[] = [];
  for (const c of changes) {
    if (matches(map.ignore ?? [], c.path)) continue;
    const rule = map.rules.find((r) => matches(r.paths, c.path));
    if (rule) artifacts.push({ surface: rule.surface, ref: c.path, change: c.change });
    else unmapped.push(c.path);
  }
  return { artifacts, unmapped: [...new Set(unmapped)].sort() };
}

export interface LandingFacts {
  id: string;
  marked: boolean;
  landing: string | null;
  artifacts: LandingArtifact[] | null;
  commitSha: string | null;
}

const PROSE =
  'its landing is text that names no artifact: it was marked before a landing named what it changed';
const UNMARKED = 'it carries no merged mark, so nothing names what it changed';
const NO_LANDING = 'its mark names no landing, so nothing names what it changed';

/** Uncached commit reads one release read makes at most; a cached answer costs none. */
const READ_LIMIT = 60;

function budget(): () => string | null {
  let spent = 0;
  return () => {
    spent += 1;
    return spent <= READ_LIMIT
      ? null
      : `it was not read: one release read makes at most ${READ_LIMIT} uncached repository reads`;
  };
}

type Reader = { host: SourceHost } | { why: string };

interface Deps {
  host?: (projectId: string) => Promise<SourceHost>;
  document?: (projectId: string) => Promise<ProjectDocument | null>;
}

/** The reading of a landing that needs no repository: named artifacts, a design revision, or why not. */
export function namedReading(f: LandingFacts): IssueLandingReading | null {
  if (f.artifacts && f.artifacts.length > 0) {
    return { kind: 'named', artifacts: f.artifacts, unmappedPaths: [] };
  }
  const design = designLandingRef(f.landing);
  if (design) return { kind: 'named', artifacts: [designArtifact(design)], unmappedPaths: [] };
  return null;
}

async function gitReading(
  f: LandingFacts,
  map: SurfaceMap | null,
  reader: () => Promise<Reader>,
  spend: () => string | null,
): Promise<IssueLandingReading> {
  if (!f.commitSha) {
    return {
      kind: 'unclassified',
      why: 'its mark records no commit Forge observed, so the paths it changed cannot be read',
      paths: [],
    };
  }
  const read = await reader();
  if ('why' in read) return { kind: 'unclassified', why: read.why, paths: [] };
  const files = await changedFilesOf(read.host, f.commitSha, spend);
  if (files.kind === 'unread') return { kind: 'unclassified', why: files.why, paths: [] };
  if (!map) {
    return {
      kind: 'unclassified',
      why: 'the project document declares no `release.surfaces`, so its changed paths are shown as they are and not sorted by surface',
      paths: [...files.paths],
    };
  }
  const { artifacts, unmapped } = classifyChanges(map, files.changes);
  if (artifacts.length === 0) {
    return {
      kind: 'unclassified',
      why:
        unmapped.length > 0
          ? 'no rule of `release.surfaces` claims any path it changed'
          : 'every path it changed is one `release.surfaces` ignores',
      paths: unmapped,
    };
  }
  return { kind: 'named', artifacts, unmappedPaths: unmapped };
}

/** Each issue's landing reading, a repository read only for a git landing that names nothing itself. */
export async function readLandingReadings(
  projectId: string,
  facts: readonly LandingFacts[],
  deps: Deps = {},
): Promise<Map<string, IssueLandingReading>> {
  const out = new Map<string, IssueLandingReading>();
  const pending: LandingFacts[] = [];
  for (const f of facts) {
    const named = namedReading(f);
    if (named) out.set(f.id, named);
    else pending.push(f);
  }
  if (pending.length === 0) return out;
  const document = await (deps.document ?? readDocument)(projectId);
  const git = document?.source.type === 'git';
  const map = surfaceMapOf(document);
  let reader: Promise<Reader> | null = null;
  const readerOnce = () => {
    reader ??= (async (): Promise<Reader> => {
      try {
        return { host: await (deps.host ?? ((id) => resolveSourceHost(id, 'kernel')))(projectId) };
      } catch (err) {
        if (err instanceof SourceHostUnavailable) return { why: err.message };
        throw err;
      }
    })();
    return reader;
  };
  const spend = budget();
  for (const f of pending) {
    if (!f.marked) out.set(f.id, { kind: 'unclassified', why: UNMARKED, paths: [] });
    else if (git && !f.landing) out.set(f.id, await gitReading(f, map, readerOnce, spend));
    else out.set(f.id, { kind: 'unclassified', why: f.landing ? PROSE : NO_LANDING, paths: [] });
  }
  return out;
}

async function readDocument(projectId: string): Promise<ProjectDocument | null> {
  return (await readProjectDocument(projectId))?.document ?? null;
}

const ORDER = new Map<LandingSurface, number>(LANDING_SURFACES.map((s, i) => [s, i]));

/** The surfaces a reading touches, in `LANDING_SURFACES` order. */
export function surfacesOf(reading: IssueLandingReading): LandingSurface[] {
  if (reading.kind !== 'named') return [];
  return [...new Set(reading.artifacts.map((a) => a.surface))].sort(
    (a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0),
  );
}

function riskOf(surface: LandingSurface, change: LandingArtifact['change']) {
  if (surface === 'data' && change === 'removed') return 'data_removed' as const;
  if (surface === 'data' && change === 'changed') return 'data_changed' as const;
  if (surface === 'api' && change === 'removed') return 'api_removed' as const;
  return null;
}

const RISK_SENTENCE: Record<ReleaseChangeRiskView['risk'], (ref: string) => string> = {
  data_removed: (ref) => `${ref} is removed: data it held does not come back with a rollback`,
  data_changed: (ref) => `${ref} changes shape: rows written before it are read by the new shape`,
  api_removed: (ref) => `${ref} is removed: a caller still using it is refused after this ships`,
};

/** What a release's landings change together, per surface, with the risks the data names. */
export function releaseChangesOf(
  issues: ReadonlyArray<{ key: string; reading: IssueLandingReading }>,
): ReleaseChanges {
  const bySurface = new Map<
    LandingSurface,
    Map<string, { ref: string; change: LandingArtifact['change']; issues: Set<string> }>
  >();
  const unclassified: ReleaseChanges['unclassified'] = [];
  for (const { key, reading } of issues) {
    if (reading.kind === 'unclassified') {
      unclassified.push({ key, why: reading.why, paths: reading.paths });
      continue;
    }
    for (const a of reading.artifacts) {
      const held = bySurface.get(a.surface) ?? new Map();
      const id = `${a.change}\u0000${a.ref}`;
      const entry = held.get(id) ?? { ref: a.ref, change: a.change, issues: new Set<string>() };
      entry.issues.add(key);
      held.set(id, entry);
      bySurface.set(a.surface, held);
    }
  }
  const surfaces: ReleaseSurfaceChanges[] = LANDING_SURFACES.flatMap((surface) => {
    const held = bySurface.get(surface);
    if (!held) return [];
    const artifacts = [...held.values()]
      .map((e) => ({ ref: e.ref, change: e.change, issues: [...e.issues] }))
      .sort((a, b) => a.ref.localeCompare(b.ref, 'en') || a.change.localeCompare(b.change));
    return [
      {
        surface,
        count: artifacts.length,
        shipsNothing: SHIPS_NOTHING.includes(surface),
        issues: [...new Set(artifacts.flatMap((a) => a.issues))],
        artifacts,
      },
    ];
  });
  const risks: ReleaseChangeRiskView[] = surfaces.flatMap((s) =>
    s.artifacts.flatMap((a) => {
      const risk = riskOf(s.surface, a.change);
      return risk
        ? [
            {
              risk,
              surface: s.surface,
              ref: a.ref,
              issues: a.issues,
              sentence: RISK_SENTENCE[risk](a.ref),
            },
          ]
        : [];
    }),
  );
  return {
    surfaces,
    risks,
    unclassified,
    shipsNothing:
      unclassified.length === 0 && surfaces.length > 0 && surfaces.every((s) => s.shipsNothing),
  };
}
