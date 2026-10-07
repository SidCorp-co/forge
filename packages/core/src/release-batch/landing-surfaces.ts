/**
 * What each issue's landing changed, by surface, and what a release's landings change together —
 * the "What changes" a release's approver reads before the notes.
 *
 * A landing that names its artifacts (`issues.merged_artifacts`: a mark outside git, a design
 * approval) is read as named. A git landing names none of its own: its commit's changed paths —
 * read through the source host where Forge observed the merge, else as a box read them from its
 * checkout and sent them with the mark (labelled box-read) — are classified by the project
 * document's `surfaces`. A project declaring no map has its paths shown unclassified, never
 * guessed, and a prose landing written before
 * artifacts existed reads unclassified with why: docs/modules/issues/merge-mark.md.
 */

import { posix } from 'node:path';
import {
  designArtifact,
  designLandingRef,
  LANDING_SURFACES,
  type LandingArtifact,
  type LandingSurface,
  type ReadPaths,
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

type SurfaceMap = NonNullable<ProjectDocument['surfaces']>;

/** The map a project's git landings are classified by: its document's own, or none. */
export function surfaceMapOf(document: ProjectDocument | null): SurfaceMap | null {
  return document?.surfaces ?? null;
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

interface LandingFacts {
  id: string;
  marked: boolean;
  landing: string | null;
  artifacts: LandingArtifact[] | null;
  commitSha: string | null;
  /** The paths a box read for the landing commit from its checkout, where it sent them. */
  readPaths: ReadPaths | null;
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

/** What a landing names of its own: stored artifacts, or a design revision its text names. */
function ownArtifacts(f: LandingFacts): LandingArtifact[] | null {
  if (f.artifacts && f.artifacts.length > 0) return f.artifacts;
  const design = designLandingRef(f.landing);
  return design ? [designArtifact(design)] : null;
}

type Source = 'mark' | 'host' | 'box';
type PathSource = Exclude<Source, 'mark'>;

const named = (
  artifacts: LandingArtifact[],
  source: Source,
  unmappedPaths: string[] = [],
  unread: string | null = null,
): IssueLandingReading => ({ kind: 'named', artifacts, unmappedPaths, unread, source });

const unclassified = (
  why: string,
  source: PathSource | null,
  paths: string[] = [],
): IssueLandingReading => ({ kind: 'unclassified', why, paths, source });

/** A commit's changed files, whoever read them, sorted by the project's map. */
function classifiedReading(
  changes: readonly HostFileChange[],
  map: SurfaceMap | null,
  source: PathSource,
): IssueLandingReading {
  if (!map) {
    return unclassified(
      'the project document declares no `surfaces`, so its changed paths are shown as they are and not sorted by surface',
      source,
      [...new Set(changes.map((c) => c.path))].sort(),
    );
  }
  const { artifacts, unmapped } = classifyChanges(map, changes);
  if (artifacts.length === 0) {
    return unclassified(
      unmapped.length > 0
        ? 'no rule of `surfaces` claims any path it changed'
        : 'every path it changed is one `surfaces` ignores',
      source,
      unmapped,
    );
  }
  return named(artifacts, source, unmapped);
}

/** The observed commit's reading through the source host, or why it was not read. */
async function hostReading(
  commitSha: string,
  map: SurfaceMap | null,
  reader: () => Promise<Reader>,
  spend: () => string | null,
): Promise<IssueLandingReading> {
  const read = await reader();
  if ('why' in read) return unclassified(read.why, 'host');
  const files = await changedFilesOf(read.host, commitSha, spend);
  if (files.kind === 'unread') return unclassified(files.why, 'host');
  return classifiedReading(files.changes, map, 'host');
}

/**
 * A git landing: what its commit changed — read by the source host where Forge observed the merge,
 * else as the box read it from its checkout — beside what the row names of its own (a design
 * revision its approval wrote). A commit that cannot be read leaves the own artifacts standing with
 * why the rest is unread, never an answer that the commit changed nothing.
 */
async function gitReading(
  f: LandingFacts,
  own: LandingArtifact[] | null,
  map: SurfaceMap | null,
  reader: () => Promise<Reader>,
  spend: () => string | null,
): Promise<IssueLandingReading> {
  let commit: IssueLandingReading | null = null;
  if (f.commitSha) commit = await hostReading(f.commitSha, map, reader, spend);
  else if (f.readPaths) commit = classifiedReading(f.readPaths.changes, map, 'box');
  if (!commit) {
    if (own) return named(own, 'mark');
    return unclassified(
      'its mark records no commit Forge observed and no paths a box read, so what it changed cannot be named',
      null,
    );
  }
  if (!own) return commit;
  const source = commit.source ?? 'mark';
  if (commit.kind === 'named') {
    return named([...own, ...commit.artifacts], source, commit.unmappedPaths);
  }
  return named(own, source, commit.paths, commit.why);
}

/** Each issue's landing reading, a repository read only for a git landing's observed commit. */
export async function readLandingReadings(
  projectId: string,
  facts: readonly LandingFacts[],
  deps: Deps = {},
): Promise<Map<string, IssueLandingReading>> {
  const out = new Map<string, IssueLandingReading>();
  const pending: LandingFacts[] = [];
  for (const f of facts) {
    const own = ownArtifacts(f);
    if (own && !f.commitSha && !f.readPaths) out.set(f.id, named(own, 'mark'));
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
    const own = ownArtifacts(f);
    if (!f.marked) out.set(f.id, unclassified(UNMARKED, null));
    else if (git && !f.landing) {
      out.set(f.id, await gitReading(f, own, map, readerOnce, spend));
    } else if (own) out.set(f.id, named(own, 'mark'));
    else out.set(f.id, unclassified(f.landing ? PROSE : NO_LANDING, null));
  }
  return out;
}

async function readDocument(projectId: string): Promise<ProjectDocument | null> {
  return (await readProjectDocument(projectId))?.document ?? null;
}

/** What a reading leaves unnamed, or null where it names everything its landing changed. */
export function gapOf(reading: IssueLandingReading): { why: string; paths: string[] } | null {
  if (reading.kind === 'unclassified') return { why: reading.why, paths: reading.paths };
  if (reading.unread) return { why: reading.unread, paths: reading.unmappedPaths };
  if (reading.unmappedPaths.length > 0) {
    return {
      why: `${reading.unmappedPaths.length} path(s) it changed are claimed by no rule of \`release.surfaces\`, so they are shown as they are`,
      paths: reading.unmappedPaths,
    };
  }
  return null;
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
  const gaps: ReleaseChanges['unclassified'] = [];
  const boxRead: string[] = [];
  for (const { key, reading } of issues) {
    if (reading.source === 'box') boxRead.push(key);
    const gap = gapOf(reading);
    if (gap) gaps.push({ key, ...gap });
    if (reading.kind === 'unclassified') continue;
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
    unclassified: gaps,
    boxRead,
    shipsNothing: gaps.length === 0 && surfaces.length > 0 && surfaces.every((s) => s.shipsNothing),
  };
}
