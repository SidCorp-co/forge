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
import { type Said, say, sayEn } from '@forge/contracts/said';
import {
  type HostFileChange,
  resolveSourceHost,
  type SourceHost,
  SourceHostUnavailable,
} from '../integrations/source-host/index.js';
import { type ProjectDocument, readProjectDocument } from '../project-config/index.js';
import { changedFilesOf } from './carriage.js';

export type SurfaceMap = NonNullable<ProjectDocument['surfaces']>;

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
const COMMIT_UNREAD =
  'its mark records no commit Forge observed and no paths a box read, so what its git landing changed beyond the artifacts named is not read';
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
    // a design approval stamps a git row first (`recordDesignLanding`), so its revision may be all
    // the row names of a landing that also changed code: never read that as everything it changed
    if (own) return named(own, 'mark', [], COMMIT_UNREAD);
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
    // a landing that names where it went is read as named on any shape; a git one waits for the map
    if (own && f.landing && !f.commitSha && !f.readPaths) out.set(f.id, named(own, 'mark'));
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

// a migrator's bookkeeping beside its migrations (drizzle's journal and snapshots): never a schema change
const MIGRATION_META = /(^|\/)migrations?\/(.*\/)?meta\//i;

/** True for a migrator's journal or snapshot: it records migrations, it is not one. */
export const isMigratorBookkeeping = (ref: string): boolean => MIGRATION_META.test(ref);

function riskOf(surface: LandingSurface, change: LandingArtifact['change'], ref: string) {
  if (surface === 'data' && isMigratorBookkeeping(ref)) return null;
  if (surface === 'data' && change === 'removed') return 'data_removed' as const;
  if (surface === 'data' && change === 'changed') return 'data_changed' as const;
  if (surface === 'api' && change === 'removed') return 'api_removed' as const;
  return null;
}

const RISK_SENTENCE: Record<ReleaseChangeRiskView['risk'], (ref: string) => Said> = {
  data_removed: (ref) => say('standing.risk.dataRemoved', { ref }),
  data_changed: (ref) => say('standing.risk.dataChanged', { ref }),
  api_removed: (ref) => say('standing.risk.apiRemoved', { ref }),
};

interface Entry {
  ref: string;
  change: LandingArtifact['change'];
  carriedBy: string | null;
  issues: Set<string>;
}

/** Artifacts gathered per surface, one entry per change of a ref and who carries it. */
class Gathered {
  private readonly bySurface = new Map<LandingSurface, Map<string, Entry>>();

  add(surface: LandingSurface, a: Omit<Entry, 'issues'>, issues: Iterable<string>): void {
    const held = this.bySurface.get(surface) ?? new Map<string, Entry>();
    const id = `${a.change}\u0000${a.ref}\u0000${a.carriedBy ?? ''}`;
    const entry = held.get(id) ?? { ...a, issues: new Set<string>() };
    for (const key of issues) entry.issues.add(key);
    held.set(id, entry);
    this.bySurface.set(surface, held);
  }

  surfaces(): ReleaseSurfaceChanges[] {
    return LANDING_SURFACES.flatMap((surface) => {
      const held = this.bySurface.get(surface);
      if (!held) return [];
      const artifacts = [...held.values()]
        .map((e) => ({
          ref: e.ref,
          change: e.change,
          issues: [...e.issues],
          carriedBy: e.carriedBy,
        }))
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
  }
}

/** The surfaces with the risks the data names, and whether the whole ships nothing. */
function assembled(
  gathered: Gathered,
  unclassified: ReleaseChanges['unclassified'],
  boxRead: string[],
): ReleaseChanges {
  const surfaces = gathered.surfaces();
  const risks: ReleaseChangeRiskView[] = surfaces.flatMap((s) =>
    s.artifacts.flatMap((a) => {
      const risk = riskOf(s.surface, a.change, a.ref);
      return risk
        ? [
            {
              risk,
              surface: s.surface,
              ref: a.ref,
              issues: a.issues,
              sentence: sayEn(RISK_SENTENCE[risk](a.ref)),
              says: { sentence: RISK_SENTENCE[risk](a.ref) },
            },
          ]
        : [];
    }),
  );
  return {
    surfaces,
    risks,
    unclassified,
    boxRead,
    shipsNothing:
      unclassified.length === 0 && surfaces.length > 0 && surfaces.every((s) => s.shipsNothing),
  };
}

/** What a release's landings change together, per surface, with the risks the data names. */
export function releaseChangesOf(
  issues: ReadonlyArray<{ key: string; reading: IssueLandingReading }>,
): ReleaseChanges {
  const gathered = new Gathered();
  const gaps: ReleaseChanges['unclassified'] = [];
  const boxRead: string[] = [];
  for (const { key, reading } of issues) {
    if (reading.source === 'box') boxRead.push(key);
    const gap = gapOf(reading);
    if (gap) gaps.push({ key, ...gap });
    if (reading.kind === 'unclassified') continue;
    for (const a of reading.artifacts) {
      gathered.add(a.surface, { ref: a.ref, change: a.change, carriedBy: a.carriedBy ?? null }, [
        key,
      ]);
    }
  }
  return assembled(gathered, gaps, boxRead);
}

const RANGE_UNMAPPED =
  'no rule of `surfaces` claims these paths the range changes, so they are shown as they are';
const RANGE_NO_MAP =
  "the project document declares no `surfaces`, so the range's changed paths are shown as they are and not sorted by surface";

/**
 * What a release's own commit range changes (REQ-40 BC-9): every file the range changed, sorted by
 * the project's map, each naming the issues whose landing names that path. A landing's other paths
 * are another release's: an issue carried again names all it ever landed, and a later round's mark
 * replaces the commit an earlier release shipped. Design revisions, which no commit range carries
 * and which ship nothing, are kept as the landings name them. Paths no rule claims are shown under no
 * issue, never dropped.
 */
export function rangeChangesOf(
  changed: readonly HostFileChange[],
  map: SurfaceMap | null,
  landed: ReleaseChanges,
): ReleaseChanges {
  const named = new Map<string, Set<string>>();
  const name = (ref: string, keys: Iterable<string>) => {
    const held = named.get(ref) ?? new Set<string>();
    for (const k of keys) held.add(k);
    named.set(ref, held);
  };
  for (const s of landed.surfaces) for (const a of s.artifacts) name(a.ref, a.issues);
  for (const u of landed.unclassified)
    if (u.key !== null) for (const p of u.paths) name(p, [u.key]);

  const gathered = new Gathered();
  for (const s of landed.surfaces) {
    if (!s.shipsNothing) continue;
    for (const a of s.artifacts) {
      gathered.add(s.surface, { ref: a.ref, change: a.change, carriedBy: a.carriedBy }, a.issues);
    }
  }
  if (!map) {
    const paths = [...new Set(changed.map((c) => c.path))].sort();
    return assembled(gathered, paths.length ? [{ key: null, why: RANGE_NO_MAP, paths }] : [], []);
  }
  const { artifacts, unmapped } = classifyChanges(map, changed);
  for (const a of artifacts) {
    gathered.add(
      a.surface,
      { ref: a.ref, change: a.change, carriedBy: null },
      named.get(a.ref) ?? [],
    );
  }
  const gaps = unmapped.length > 0 ? [{ key: null, why: RANGE_UNMAPPED, paths: unmapped }] : [];
  return assembled(gathered, gaps, []);
}

/** The surface map the project's document declares, or none. */
export async function readSurfaceMap(projectId: string): Promise<SurfaceMap | null> {
  return surfaceMapOf(await readDocument(projectId));
}
