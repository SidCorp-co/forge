/**
 * The merge's half of the pattern rule (Issue lifecycle r14 `design-check`; Issue to release r20
 * `rule-merge`): an approved new pattern's catalog page lands in the issue's own change, or its merge
 * is refused PATTERN_ENTRY_MISSING (REQ-36 BC-3).
 *
 * Core has no check before the merge yet (ISS-472 builds it), so the merge mark asks this
 * (`merge-marker.ts:preflightMark`). The mark is the one merge-time act that reads the landed change.
 * The running build's catalog is the wrong thing to read: it holds the page only after a release,
 * and a release claims only issues already past this check.
 *
 * A page counts as shown when the running build's catalog already holds it, when the box's reading
 * of the marked commit's changed files lists it, or when the project's repository holds it at that
 * commit. Anything else is refused by name, saying what was read.
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
  /** The box's reading of the marked commit's changed files; null where the mark carries none. */
  paths: { commit: string; changes: readonly FileChange[] } | null;
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
  return reading.paths?.changes.some((c) => c.path === page && c.change !== 'removed') ?? false;
}

function whatWasRead(reading: EntryReading): string {
  const parts: string[] = [];
  if (reading.paths) {
    parts.push(`the files commit ${reading.paths.commit} changed, as the box read them, list none`);
  }
  if (reading.tree.kind === 'read') {
    parts.push(`the repository holds none at ${reading.tree.sha}`);
  } else {
    parts.push(`the repository could not be read (${reading.tree.why})`);
    if (!reading.paths) {
      parts.push(
        'and the mark carries no `changedPaths`, which `forge-runner api` adds to a mark naming a commit its checkout holds',
      );
    }
  }
  return parts.join('; ');
}

/** The mark refuses with this code at `/commit`, which the merge refusals declare. */
export interface EntryRefusal {
  code: typeof PATTERN_ENTRY_MISSING;
  path: '/commit';
  detail: string;
}

/** The mark's refusal, or null where every approved new pattern's page is shown. */
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
    path: '/commit',
    detail: `${issueRef} introduces the approved new pattern${many ? 's' : ''} ${missing.map((p) => `\`${p}\``).join(', ')}, and the change this mark reads holds no page for ${many ? 'them' : 'it'} (${missing.map(entryPageOf).join(', ')}): ${whatWasRead(reading)}. The page lands in this issue's own change, so land it and mark the commit that carries it. Nothing was marked`,
  };
}

/** What the repository holds at `commit` of `pages`, read through the project's source host. */
async function readTree(
  projectId: string,
  commit: string | null,
  pages: readonly string[],
): Promise<TreeReading> {
  if (pages.length === 0) return { kind: 'read', sha: commit ?? '', held: new Set() };
  if (!commit) return { kind: 'unread', why: 'the mark names no commit' };
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

/**
 * The merge mark's pattern refusal: the issue's approved new patterns, each needing its page in the
 * change the mark reads. Null where the issue has none, or every page is shown.
 */
export async function patternEntryRefusal(args: {
  issueId: string;
  projectId: string;
  commit: string | null;
  changedPaths: { commit: string; changes: readonly FileChange[] } | null;
}): Promise<EntryRefusal | null> {
  const approved = approvedNew(await patternFactsIn(db, args.issueId));
  if (approved.length === 0) return null;
  const catalog = await catalogOf(args.projectId);
  const running = catalog.kind === 'read' ? catalog.slugs : new Set<string>();
  const unshown = approved.filter(
    (slug) => !shownWithoutTree(slug, { running, paths: args.changedPaths }),
  );
  const tree = await readTree(args.projectId, args.commit, unshown.map(entryPageOf));
  const issueRef = (await issueDisplayIds([args.issueId])).get(args.issueId) ?? args.issueId;
  return entryRefusal(issueRef, approved, { running, paths: args.changedPaths, tree });
}
