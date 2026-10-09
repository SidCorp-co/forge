/**
 * The merge's half of the pattern rule (Issue lifecycle r14 `design-check`; Issue to release r20
 * `rule-merge`): an approved new pattern's catalog page lands in the issue's own change, or it is
 * refused PATTERN_ENTRY_MISSING (REQ-36 BC-3). It is asked wherever an approved new pattern and a
 * change first meet, because either can come first:
 *
 *   - the merge check (`merge-check.ts:recordMergeCheck`), over the files its report says the change
 *     touches, for the patterns approved when it runs;
 *   - the merge mark (`merge-marker.ts`), over the commit it marks, for the patterns approved then;
 *   - the approval of a new pattern on an issue whose merge is already marked
 *     (`patterns.ts:decidePattern`), over the change the mark names;
 *   - the move to awaiting_release (`transition-guards.ts`), over the change the mark names, for every
 *     pattern approved by then.
 *
 * The change the mark names is read, in order, from: the paths the box read at the marked commit when
 * it marked, the catalog pages a merge check passing at that commit recorded, and the project's
 * repository at that commit. The running build's catalog is never read: it holds a page only after a
 * release, and holding it there does not put it in this issue's change. Anything unshown is refused
 * by name, saying what was read and, for the repository, the host's own answer.
 */

import type { FileChange, ReadPaths } from '@forge/contracts/landing-artifacts';
import { MERGE_CHECK_RECORD } from '@forge/contracts/merge-check';
import {
  PATTERN_CATALOG_DIR,
  PATTERN_ENTRY_MISSING,
  PATTERN_SLUG_PATTERN,
} from '@forge/contracts/patterns';
import { eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { issuePatterns } from '../db/schema-issue-patterns.js';
import { issueDisplayIds } from './display-ids.js';
import { currentMarkClaims } from './mark-trail.js';
import type { PatternRowFacts } from './pattern-rules.js';
import { resolveSourceHost } from './ports.js';
import { listRecordEvents } from './record-events/store.js';

/** A catalog page is a few kilobytes; reading more than this proves nothing more. */
const PAGE_READ_BYTES = 64 * 1024;

/** The field a passing merge check's record keeps each catalog page its change carried in. */
export const CATALOG_PAGE_FIELD = 'catalog-page';

export const entryPageOf = (slug: string): string => `${PATTERN_CATALOG_DIR}/${slug}.md`;

/** The catalog pages a list of changed files carries: `docs/patterns/<slug>.md`, not removed. */
export function catalogPagesIn(changes: readonly FileChange[]): string[] {
  const prefix = `${PATTERN_CATALOG_DIR}/`;
  const pages = changes
    .filter((c) => c.change !== 'removed' && c.path.startsWith(prefix) && c.path.endsWith('.md'))
    .map((c) => c.path)
    .filter((p) => PATTERN_SLUG_PATTERN.test(p.slice(prefix.length, -'.md'.length)));
  return [...new Set(pages)];
}

/** The record fields a passing merge check keeps of the catalog pages its change carried. */
export function catalogPageFields(
  changes: readonly FileChange[],
): { key: string; value: string }[] {
  return catalogPagesIn(changes).map((value) => ({ key: CATALOG_PAGE_FIELD, value }));
}

/** What the repository holds at a commit of the pages nothing else showed, with the host's answers. */
export type TreeReading =
  | {
      kind: 'read';
      sha: string;
      held: ReadonlySet<string>;
      /** Each page the host did not hand back, with the host's own reason. */
      missing: ReadonlyMap<string, string>;
    }
  | { kind: 'unread'; why: string };

/** One list of the change's files that was read: the pages it shows, and how to say it showed none. */
export interface ChangeList {
  pages: ReadonlySet<string>;
  none: string;
}

export interface EntryReading {
  lists: readonly ChangeList[];
  tree: TreeReading;
}

/** The approved new patterns of the issue, live: the ones whose page the change must carry. */
export function approvedNew(
  rows: readonly Pick<PatternRowFacts, 'pattern' | 'kind' | 'decision' | 'retractedAt'>[],
): string[] {
  return rows
    .filter((r) => r.kind === 'new' && r.decision === 'approved' && r.retractedAt === null)
    .map((r) => r.pattern);
}

function listed(page: string, reading: Pick<EntryReading, 'lists'>): boolean {
  return reading.lists.some((l) => l.pages.has(page));
}

/** Whether the reading shows the slug's page: a list of the change's files, or the repository. */
export function shownIn(slug: string, reading: EntryReading): boolean {
  const page = entryPageOf(slug);
  return listed(page, reading) || (reading.tree.kind === 'read' && reading.tree.held.has(page));
}

function whatWasRead(reading: EntryReading, pages: readonly string[]): string {
  const { tree } = reading;
  const repository =
    tree.kind === 'read'
      ? `the repository at ${tree.sha} holds none (${pages.map((p) => tree.missing.get(p) ?? `${p}: the host answered neither its text nor why`).join('; ')})`
      : `the repository could not be read (${tree.why})`;
  return [...reading.lists.map((l) => l.none), repository].join('; ');
}

/** Where the refusal is given, which decides what the change is called and what to do next. */
export type EntrySite = 'merge-check' | 'mark' | 'approval' | 'move';

const SITES: Record<EntrySite, { path: string; change: string; next: string }> = {
  'merge-check': {
    path: '/touched',
    change: 'the change this merge check reads',
    next: "The page lands in this issue's own change, so add it and run the merge check again. Nothing was recorded",
  },
  mark: {
    path: '/commit',
    change: 'the change this mark names',
    next: "The page lands in this issue's own change: add it, run the merge check on that change, and mark the commit that carries it. Nothing was marked",
  },
  approval: {
    path: '/decision',
    change: "the change this issue's merge mark already names",
    next: "Approving it would let that merge stand without its page. Unmark the merge, land the page in this issue's change, mark the merge again, then decide the pattern. Nothing was decided",
  },
  move: {
    path: '/status',
    change: "the change this issue's merge mark names",
    next: "The page lands in this issue's own change: add it, run the merge check on that change, then unmark the merge and mark it again naming the commit that carries the page. The issue did not move",
  },
};

export interface EntryRefusal {
  code: typeof PATTERN_ENTRY_MISSING;
  path: string;
  detail: string;
}

/** The refusal at `site`, or null where every approved new pattern's page is shown. */
export function entryRefusal(
  issueRef: string,
  approved: readonly string[],
  reading: EntryReading,
  site: EntrySite,
): EntryRefusal | null {
  const missing = approved.filter((slug) => !shownIn(slug, reading));
  if (missing.length === 0) return null;
  const many = missing.length > 1;
  const pages = missing.map(entryPageOf);
  const { path, change, next } = SITES[site];
  return {
    code: PATTERN_ENTRY_MISSING,
    path,
    detail: `${issueRef} introduces the approved new pattern${many ? 's' : ''} ${missing.map((p) => `\`${p}\``).join(', ')}, and ${change} holds no page for ${many ? 'them' : 'it'} (${pages.join(', ')}): ${whatWasRead(reading, pages)}. ${next}`,
  };
}

/** What the repository holds at `commit` of `pages`, read through the project's source host. */
async function readTree(
  projectId: string,
  commit: string | null,
  pages: readonly string[],
): Promise<TreeReading> {
  if (commit === null) return { kind: 'unread', why: 'there is no commit to read it at' };
  if (pages.length === 0) return { kind: 'read', sha: commit, held: new Set(), missing: new Map() };
  try {
    const host = await resolveSourceHost(projectId, 'kernel');
    const held = new Set<string>();
    const missing = new Map<string, string>();
    for (const page of pages) {
      const answer: unknown = await host.readFile(page, commit, PAGE_READ_BYTES);
      if (typeof answer === 'string') held.add(page);
      else if (answer && typeof (answer as { missing?: unknown }).missing === 'string') {
        missing.set(page, (answer as { missing: string }).missing);
      }
    }
    return { kind: 'read', sha: commit, held, missing };
  } catch (err) {
    // an unbound host and a failed read alike leave the page unshown, and the refusal says which
    return { kind: 'unread', why: err instanceof Error ? err.message : String(err) };
  }
}

/** The pages of `approved` no list showed, which only the repository can still show. */
const unlisted = (approved: readonly string[], lists: readonly ChangeList[]) =>
  approved.map(entryPageOf).filter((page) => !listed(page, { lists }));

type Reader = Pick<Tx, 'select' | 'execute'>;

/** The issue's approved new patterns, as the rules read its rows. */
export async function approvedNewOf(executor: Pick<Tx, 'select'>, issueId: string) {
  const rows = await executor
    .select({
      pattern: issuePatterns.pattern,
      kind: issuePatterns.kind,
      decision: issuePatterns.decision,
      retractedAt: issuePatterns.retractedAt,
    })
    .from(issuePatterns)
    .where(eq(issuePatterns.issueId, issueId));
  return approvedNew(rows);
}

/** Whether the issue introduces an approved new pattern, whose page the merge check asks for. */
export async function hasApprovedNewPattern(issueId: string): Promise<boolean> {
  return (await approvedNewOf(db, issueId)).length > 0;
}

async function issueRefOf(issueId: string): Promise<string> {
  return (await issueDisplayIds([issueId])).get(issueId) ?? issueId;
}

/**
 * The merge check's pattern refusal: the issue's approved new patterns, each needing its page in the
 * files the report says the change touches, or in the repository at its head. Null where the issue
 * has none, or every page is shown.
 */
export async function patternEntryRefusal(args: {
  issueId: string;
  projectId: string;
  paths: { commit: string; changes: readonly FileChange[] };
}): Promise<EntryRefusal | null> {
  const approved = await approvedNewOf(db, args.issueId);
  if (approved.length === 0) return null;
  const lists: ChangeList[] = [
    {
      pages: new Set(catalogPagesIn(args.paths.changes)),
      none: `the files the change touches at ${args.paths.commit} list none`,
    },
  ];
  const tree = await readTree(args.projectId, args.paths.commit, unlisted(approved, lists));
  return entryRefusal(await issueRefOf(args.issueId), approved, { lists, tree }, 'merge-check');
}

const sameCommit = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
};

interface MarkColumns {
  mergedAt: Date | null;
  mergedCommitSha: string | null;
  mergedPaths: ReadPaths | null;
}

async function markColumnsOf(executor: Pick<Tx, 'select'>, issueId: string) {
  const [row] = await executor
    .select({
      mergedAt: issues.mergedAt,
      mergedCommitSha: issues.mergedCommitSha,
      mergedPaths: issues.mergedPaths,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return (row ?? null) as MarkColumns | null;
}

/** The commit a standing mark names: the one Forge observed, else the one the current mark claims. */
async function markedCommitOf(
  executor: Reader,
  issueId: string,
  row: MarkColumns,
): Promise<string | null> {
  if (row.mergedAt === null) return null;
  return row.mergedCommitSha ?? (await currentMarkClaims([issueId], executor)).get(issueId) ?? null;
}

/** The catalog pages the merge checks passing at `commit` recorded, and whether any passed there. */
async function checkedPagesAt(
  issueId: string,
  commit: string,
): Promise<{ passed: boolean; pages: Set<string> }> {
  const records = await listRecordEvents(issueId, { kinds: ['verification'], kernelOnly: true });
  const pages = new Set<string>();
  let passed = false;
  for (const record of records) {
    const field = (key: string) => record.fields.find((f) => f.key === key)?.value;
    const head = field('head');
    if (field('check') !== MERGE_CHECK_RECORD || field('result') !== 'pass') continue;
    if (!head || !sameCommit(head, commit)) continue;
    passed = true;
    for (const f of record.fields) if (f.key === CATALOG_PAGE_FIELD) pages.add(f.value);
  }
  return { passed, pages };
}

/** A reading of the change a standing mark names, and the commit it was read at. */
export interface MarkedReading extends EntryReading {
  commit: string | null;
}

/**
 * The change the issue's standing merge mark names, read for the pages of `approved`; null where the
 * issue's merge is not marked. Reads the repository only for pages no list showed.
 */
export async function readMarkedChange(
  issue: { id: string; projectId: string },
  approved: readonly string[],
): Promise<MarkedReading | null> {
  const row = await markColumnsOf(db, issue.id);
  if (!row || row.mergedAt === null) return null;
  const commit = await markedCommitOf(db, issue.id, row);
  return readChangeAt(issue, commit, row.mergedPaths, approved);
}

/**
 * The change at `commit`, read for the pages of `approved`: the paths the box read there, the pages
 * a merge check passing there recorded, then the repository there for what neither listed.
 */
async function readChangeAt(
  issue: { id: string; projectId: string },
  commit: string | null,
  read: { commit: string; changes: readonly FileChange[] } | null,
  approved: readonly string[],
): Promise<MarkedReading> {
  if (commit === null) {
    return {
      commit,
      lists: [
        {
          pages: new Set(),
          none: 'the merge mark names no whole commit, so no list of its files can be matched to it',
        },
      ],
      tree: { kind: 'unread', why: 'there is no commit to read it at' },
    };
  }
  const boxList: ChangeList =
    read && sameCommit(read.commit, commit)
      ? {
          pages: new Set(catalogPagesIn(read.changes)),
          none: `the paths the box read at ${commit} for the merge mark list none`,
        }
      : { pages: new Set(), none: `the mark carries no paths the box read at ${commit}` };
  const checked = await checkedPagesAt(issue.id, commit);
  const checkList: ChangeList = {
    pages: checked.pages,
    none: checked.passed
      ? `the merge check passing at ${commit} recorded none`
      : `no merge check passing at ${commit} is recorded`,
  };
  const lists = [boxList, checkList];
  const tree = await readTree(issue.projectId, commit, unlisted(approved, lists));
  return { commit, lists, tree };
}

/**
 * The merge mark's refusal (Issue to release r20 `rule-merge`): marking `commit` while an approved
 * new pattern of the issue has no page in that change, as the paths the mark sends, the merge checks
 * passing there, or the repository there show it. Null where the issue has no approved new pattern.
 * Asked before the mark's owed merge check, so the refusal names the page rather than the check.
 */
export async function markEntryRefusal(args: {
  issueId: string;
  projectId: string;
  commit: string | null;
  changedPaths: { commit: string; changes: readonly FileChange[] } | null;
}): Promise<EntryRefusal | null> {
  const approved = await approvedNewOf(db, args.issueId);
  if (approved.length === 0) return null;
  const issue = { id: args.issueId, projectId: args.projectId };
  const reading = await readChangeAt(issue, args.commit, args.changedPaths, approved);
  return entryRefusal(await issueRefOf(args.issueId), approved, reading, 'mark');
}

/**
 * The approval's refusal: approving the new pattern `patternId` on an issue whose merge is already
 * marked, while the change the mark names holds no page for it. Null where the issue is not marked,
 * the row is not a new pattern, or the page is shown.
 */
export async function approvalEntryRefusal(args: {
  issueId: string;
  projectId: string;
  patternId: string;
}): Promise<EntryRefusal | null> {
  const [row] = await db
    .select({ pattern: issuePatterns.pattern, kind: issuePatterns.kind })
    .from(issuePatterns)
    .where(eq(issuePatterns.id, args.patternId))
    .limit(1);
  if (row?.kind !== 'new') return null;
  const reading = await readMarkedChange({ id: args.issueId, projectId: args.projectId }, [
    row.pattern,
  ]);
  if (!reading) return null;
  return entryRefusal(await issueRefOf(args.issueId), [row.pattern], reading, 'approval');
}

/** What the move to awaiting_release read before its lock: the approved patterns and the marked change. */
export interface MoveEntryFacts {
  approved: readonly string[];
  commit: string | null;
  reading: MarkedReading | null;
}

/** Read before the move's lock, so the guard calls no host while it holds it. */
export async function readMoveEntryFacts(issue: {
  id: string;
  projectId: string;
}): Promise<MoveEntryFacts> {
  const approved = await approvedNewOf(db, issue.id);
  if (approved.length === 0) return { approved, commit: null, reading: null };
  const reading = await readMarkedChange(issue, approved);
  return { approved, commit: reading?.commit ?? null, reading };
}

/**
 * The move to awaiting_release's refusal, under its lock: each pattern approved now needs its page in
 * the change the mark names now. A pattern approved, or a mark moved, after the reading was taken is
 * refused rather than passed on a reading of something else.
 */
export async function moveEntryRefusal(
  tx: Reader,
  issueId: string,
  facts: MoveEntryFacts,
): Promise<EntryRefusal | null> {
  const approved = await approvedNewOf(tx, issueId);
  if (approved.length === 0) return null;
  const row = await markColumnsOf(tx, issueId);
  const commit = row ? await markedCommitOf(tx, issueId, row) : null;
  const issueRef = (await issueDisplayIds([issueId], tx as Tx)).get(issueId) ?? issueId;
  const late = approved.filter((slug) => !facts.approved.includes(slug));
  if (facts.reading === null || commit !== facts.commit || late.length > 0) {
    const stale: EntryReading = {
      lists: [
        {
          pages: new Set(),
          none: `the merge mark or the issue's approved patterns changed while this move read the change (read at ${facts.commit ?? 'no marked commit'}, marked now at ${commit ?? 'no commit'}), so it was not read for ${approved.map((s) => `\`${s}\``).join(', ')}; move again`,
        },
      ],
      tree: { kind: 'unread', why: 'not read for the mark that stands now' },
    };
    return entryRefusal(issueRef, approved, stale, 'move');
  }
  return entryRefusal(issueRef, approved, facts.reading, 'move');
}
