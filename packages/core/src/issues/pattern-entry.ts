/**
 * The merge's half of the pattern rule (Issue lifecycle r14 `design-check`; Issue to release r20
 * `rule-merge`): an approved new pattern's catalog page lands in the issue's own change, or its merge
 * check is refused PATTERN_ENTRY_MISSING (REQ-36 BC-3). The merge check asks it
 * (`merge-check.ts:recordMergeCheck`), on the files the change touches as the check reported them;
 * the merge mark asks for a passing check, not for the page (ISS-472).
 *
 * The running build's catalog alone is the wrong thing to read: it holds the page only after a
 * release, and a release claims only issues already past this check. A page counts as shown when
 * that catalog already holds it, when the change's touched files list it, or when the project's
 * repository holds it at the change's head. Anything else is refused by name, saying what was read.
 */

import type { FileChange } from '@forge/contracts/landing-artifacts';
import { PATTERN_CATALOG_DIR, PATTERN_ENTRY_MISSING } from '@forge/contracts/patterns';
import { db } from '../db/client.js';
import { issueDisplayIds } from './display-ids.js';
import type { PatternRowFacts } from './pattern-rules.js';
import { catalogOf, patternFactsIn } from './patterns.js';
import { resolveSourceHost } from './ports.js';

/** A catalog page is a few kilobytes; reading more than this proves nothing more. */
const PAGE_READ_BYTES = 64 * 1024;

export const entryPageOf = (slug: string): string => `${PATTERN_CATALOG_DIR}/${slug}.md`;

/** What the repository holds at the marked commit, for the pages nothing else showed. */
export type TreeReading =
  | { kind: 'read'; sha: string; held: ReadonlySet<string> }
  | { kind: 'unread'; why: string };

export interface EntryReading {
  /** The slugs the running build's catalog holds. */
  running: ReadonlySet<string>;
  /** The files the change touches, at its head, as its merge check reported them. */
  paths: { commit: string; changes: readonly FileChange[] };
  tree: TreeReading;
}

/** The approved new patterns of the issue, live: the ones whose page the change must carry. */
export function approvedNew(rows: readonly PatternRowFacts[]): string[] {
  return rows
    .filter((r) => r.kind === 'new' && r.decision === 'approved' && r.retractedAt === null)
    .map((r) => r.pattern);
}

/** Whether a page is shown without reading the repository: released already, or among the paths. */
export function shownWithoutTree(
  slug: string,
  reading: Pick<EntryReading, 'running' | 'paths'>,
): boolean {
  if (reading.running.has(slug)) return true;
  const page = entryPageOf(slug);
  return reading.paths.changes.some((c) => c.path === page && c.change !== 'removed');
}

function whatWasRead(reading: EntryReading): string {
  const tree =
    reading.tree.kind === 'read'
      ? `the repository holds none at ${reading.tree.sha}`
      : `the repository could not be read (${reading.tree.why})`;
  return `the files the change touches at ${reading.paths.commit} list none; ${tree}`;
}

/** The merge check refuses with this code at `/touched`, the report's list of the change's files. */
export interface EntryRefusal {
  code: typeof PATTERN_ENTRY_MISSING;
  path: '/touched';
  detail: string;
}

/** The merge check's refusal, or null where every approved new pattern's page is shown. */
export function entryRefusal(
  issueRef: string,
  approved: readonly string[],
  reading: EntryReading,
): EntryRefusal | null {
  const missing = approved.filter(
    (slug) =>
      !shownWithoutTree(slug, reading) &&
      !(reading.tree.kind === 'read' && reading.tree.held.has(entryPageOf(slug))),
  );
  if (missing.length === 0) return null;
  const many = missing.length > 1;
  return {
    code: PATTERN_ENTRY_MISSING,
    path: '/touched',
    detail: `${issueRef} introduces the approved new pattern${many ? 's' : ''} ${missing.map((p) => `\`${p}\``).join(', ')}, and the change this merge check reads holds no page for ${many ? 'them' : 'it'} (${missing.map(entryPageOf).join(', ')}): ${whatWasRead(reading)}. The page lands in this issue's own change, so add it and run the merge check again. Nothing was recorded`,
  };
}

/** What the repository holds at `commit` of `pages`, read through the project's source host. */
async function readTree(
  projectId: string,
  commit: string,
  pages: readonly string[],
): Promise<TreeReading> {
  if (pages.length === 0) return { kind: 'read', sha: commit, held: new Set() };
  try {
    const host = await resolveSourceHost(projectId, 'kernel');
    const held = new Set<string>();
    for (const page of pages) {
      const text = await host.readFile(page, commit, PAGE_READ_BYTES);
      if (typeof text === 'string') held.add(page);
    }
    return { kind: 'read', sha: commit, held };
  } catch (err) {
    // an unbound host and a failed read alike leave the page unshown, and the refusal says which
    return { kind: 'unread', why: err instanceof Error ? err.message : String(err) };
  }
}

/** Whether the issue introduces an approved new pattern, whose page only the merge check asks for. */
export async function hasApprovedNewPattern(issueId: string): Promise<boolean> {
  return approvedNew(await patternFactsIn(db, issueId)).length > 0;
}

/**
 * The merge check's pattern refusal: the issue's approved new patterns, each needing its page in the
 * change the check reads. Null where the issue has none, or every page is shown.
 */
export async function patternEntryRefusal(args: {
  issueId: string;
  projectId: string;
  paths: { commit: string; changes: readonly FileChange[] };
}): Promise<EntryRefusal | null> {
  const approved = approvedNew(await patternFactsIn(db, args.issueId));
  if (approved.length === 0) return null;
  const catalog = await catalogOf(args.projectId);
  const running = catalog.kind === 'read' ? catalog.slugs : new Set<string>();
  const unshown = approved.filter(
    (slug) => !shownWithoutTree(slug, { running, paths: args.paths }),
  );
  const tree = await readTree(args.projectId, args.paths.commit, unshown.map(entryPageOf));
  const issueRef = (await issueDisplayIds([args.issueId])).get(args.issueId) ?? args.issueId;
  return entryRefusal(issueRef, approved, { running, paths: args.paths, tree });
}
