import type { WaitingCommit } from '../integrations/github/live-divergence.js';

/**
 * `declares_issue` — read by `declaredIssueSeqs`; `merged_in` — given by `carry`; `recorded_head` —
 * given by `readingOwnership` to a commit the other two leave to nobody.
 */
export type OwnerVia = 'declares_issue' | 'merged_in' | 'recorded_head';

/** Every issue each waiting commit is the work of, keyed by the commit's lower-cased sha. */
export type CommitOwners = ReadonlyMap<string, ReadonlyMap<number, OwnerVia>>;

const PR_REF_TAIL = /(?:\s*\(#\d+\))+\s*$/;
const TRAILER = /\(([^()]*)\)\s*$/;
const PR_MERGE = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/;
const BRANCH_MERGE = /^Merge (?:remote-tracking )?branch (?:'([^']+)'|(\S+))/;
const LOCAL_MERGE = /^Merge branch '?([^'\s]+)'?/;
const REMOTE_MERGE = /^Merge remote-tracking branch '([^'\s]+)'/;
const BARE_MERGE = /^Merge (?!branch |remote-tracking |pull request )([^'\s]+)/;
const MERGE_LEAD = /^Merge\s+/;
const LABEL_LEAD = /^[\w.-]+(?:\([^)]*\))?!?:\s*/;

export function subjectOf(message: string): string {
  return message.split('\n', 1)[0]?.trim() ?? '';
}

function lastSegment(ref: string): string {
  return ref.split('/').pop() ?? '';
}

/**
 * Whether the subject merges the base branch into another one. Git names a local branch as it is
 * and a remote-tracking one as `<remote>/<name>`; a hand-written `Merge <ref> into …` is read as
 * local unless it is qualified by `origin`, since a topic branch may itself end in the base's name.
 */
function mergesBase(subject: string, base: string): boolean {
  const remote = REMOTE_MERGE.exec(subject)?.[1];
  if (remote !== undefined) return remote.slice(remote.indexOf('/') + 1) === base;
  const local = LOCAL_MERGE.exec(subject)?.[1];
  if (local !== undefined) return local === base;
  const bare = BARE_MERGE.exec(subject)?.[1];
  return bare === base || bare === `origin/${base}`;
}

function seqsIn(text: string, pattern: RegExp): number[] {
  return [...text.matchAll(pattern)].map((m) => Number(m[1]));
}

const leadingLists = new Map<string, RegExp>();

/** The keys that open `text`, joined by `,`, `+`, `&`, `/` or `and`, and none past the first gap. */
function leadingSeqs(text: string, pattern: RegExp): number[] {
  let list = leadingLists.get(pattern.source);
  if (!list) {
    const ref = pattern.source;
    list = new RegExp(`^(?:${ref})(?:(?:\\s*[,+&/]\\s*|\\s+and\\s+)(?:${ref}))*`, 'i');
    leadingLists.set(pattern.source, list);
  }
  const m = list.exec(text);
  return m ? seqsIn(m[0], pattern) : [];
}

/**
 * The issues a commit's subject declares. A key is declared in the parenthesised group ending the
 * subject; failing that, for a merge subject, at the start of the merged branch's name; failing
 * that, in the keys opening the subject after any `Merge` or `type(scope):` lead. A merge of the
 * base branch into another branch declares nothing: what it carries is placed by its own commits.
 * A key anywhere else in the subject, or in the body, is a citation and declares nothing.
 */
export function declaredIssueSeqs(message: string, pattern: RegExp, baseBranch: string): number[] {
  const subject = subjectOf(message);
  if (mergesBase(subject, baseBranch)) return [];

  const trailer = TRAILER.exec(subject.replace(PR_REF_TAIL, ''));
  const trailed = trailer?.[1] ? seqsIn(trailer[1], pattern) : [];
  if (trailed.length > 0) return trailed;

  const merged = PR_MERGE.exec(subject) ?? BRANCH_MERGE.exec(subject);
  const branch = merged?.[1] ?? merged?.[2];
  if (branch) {
    const fromBranch = leadingSeqs(lastSegment(branch), pattern).slice(0, 1);
    if (fromBranch.length > 0) return fromBranch;
  }

  const rest = subject.replace(MERGE_LEAD, '');
  const opening = leadingSeqs(rest, pattern);
  return opening.length > 0 ? opening : leadingSeqs(rest.replace(LABEL_LEAD, ''), pattern);
}

function reachable(start: string, bySha: ReadonlyMap<string, WaitingCommit>): Set<string> {
  const seen = new Set<string>();
  const stack = [start.toLowerCase()];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    const c = bySha.get(sha);
    if (!c || seen.has(sha)) continue;
    seen.add(sha);
    for (const p of c.parents) stack.push(p.toLowerCase());
  }
  return seen;
}

/**
 * Give each commit that declares nothing the issues of the merge that brought it in: the commits
 * reachable from the merge's later parents and not from its first. A declaring merge met on the
 * way keeps its own side, so the walk follows only its first parent.
 */
function carry(
  merge: WaitingCommit,
  seqs: readonly number[],
  bySha: ReadonlyMap<string, WaitingCommit>,
  declared: ReadonlyMap<string, readonly number[]>,
  owners: Map<string, Map<number, OwnerVia>>,
): void {
  const onBase = reachable(merge.parents[0] ?? '', bySha);
  const seen = new Set<string>();
  const stack = merge.parents.slice(1).map((p) => p.toLowerCase());
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    const c = bySha.get(sha);
    if (!c || seen.has(sha) || onBase.has(sha)) continue;
    seen.add(sha);
    const own = declared.get(sha) ?? [];
    if (own.length > 0 && c.parents.length > 1) {
      if (c.parents[0]) stack.push(c.parents[0].toLowerCase());
      continue;
    }
    if (own.length === 0) {
      const into = owners.get(sha) ?? new Map<number, OwnerVia>();
      for (const s of seqs) into.set(s, 'merged_in');
      owners.set(sha, into);
    }
    for (const p of c.parents) stack.push(p.toLowerCase());
  }
}

function computeOwners(
  commits: readonly WaitingCommit[],
  pattern: RegExp,
  baseBranch: string,
): CommitOwners {
  const bySha = new Map(commits.map((c) => [c.sha.toLowerCase(), c]));
  const declared = new Map<string, number[]>();
  const owners = new Map<string, Map<number, OwnerVia>>();
  for (const [sha, c] of bySha) {
    const seqs = declaredIssueSeqs(c.message, pattern, baseBranch);
    declared.set(sha, seqs);
    if (seqs.length > 0) owners.set(sha, new Map(seqs.map((s) => [s, 'declares_issue'])));
  }
  for (const [sha, c] of bySha) {
    const seqs = declared.get(sha) ?? [];
    if (c.parents.length > 1 && seqs.length > 0) carry(c, seqs, bySha, declared, owners);
  }
  return owners;
}

const held = new WeakMap<readonly WaitingCommit[], Map<string, CommitOwners>>();

/** Which issues each of a reading's waiting commits is the work of, computed once per reading. */
export function commitOwners(
  commits: readonly WaitingCommit[],
  pattern: RegExp,
  baseBranch: string,
): CommitOwners {
  const key = `${pattern.source}\0${pattern.flags}\0${baseBranch}`;
  let byKey = held.get(commits);
  if (!byKey) {
    byKey = new Map();
    held.set(commits, byKey);
  }
  let owners = byKey.get(key);
  if (!owners) {
    owners = computeOwners(commits, pattern, baseBranch);
    byKey.set(key, owners);
  }
  return owners;
}

/**
 * What the tracker holds of one issue that can claim a waiting commit: its recorded merged commit,
 * and the `head`, `base` and `branch` its last pushed capture wrote to `sessionContext.worklog`.
 */
export interface IssueWorkRecord {
  issSeq: number;
  mergedCommitSha: string | null;
  head: string | null;
  base: string | null;
  branch: string | null;
}

export interface ReadingOwnership {
  owners: CommitOwners;
  /** The waiting commits no source gives to any issue, in the reading's order. */
  ownerless: WaitingCommit[];
}

/** A capture recorded work of its own: it moved past where it was cut, on a branch of its own. */
function headOf(r: IssueWorkRecord, branches: readonly string[]): string | null {
  const head = r.head?.trim().toLowerCase();
  const base = r.base?.trim().toLowerCase();
  if (!head || !base || head === base) return null;
  if (!r.branch || branches.includes(r.branch)) return null;
  return head;
}

/**
 * Every waiting commit's issues. `commitOwners` first; then a commit that no record's merged commit
 * is and that `commitOwners` gives to nobody goes to each issue whose recorded work head it is. The
 * head never outranks a subject or a merge: runs capture heads on other issues' commits, so it
 * answers only where nothing else does.
 */
export function readingOwnership(
  commits: readonly WaitingCommit[],
  pattern: RegExp,
  branches: { baseBranch: string; liveBranch: string },
  records: readonly IssueWorkRecord[],
): ReadingOwnership {
  const byRule = commitOwners(commits, pattern, branches.baseBranch);
  const merged = new Set(
    records.map((r) => r.mergedCommitSha?.trim().toLowerCase()).filter((s): s is string => !!s),
  );
  const heads = new Map<string, number[]>();
  const refs = [branches.baseBranch, branches.liveBranch];
  for (const r of records) {
    const head = headOf(r, refs);
    if (head) heads.set(head, [...(heads.get(head) ?? []), r.issSeq]);
  }
  let owners: Map<string, ReadonlyMap<number, OwnerVia>> | null = null;
  const ownerless: WaitingCommit[] = [];
  for (const c of commits) {
    const sha = c.sha.toLowerCase();
    if ((byRule.get(sha)?.size ?? 0) > 0 || merged.has(sha)) continue;
    const seqs = heads.get(sha);
    if (!seqs) {
      ownerless.push(c);
      continue;
    }
    owners ??= new Map(byRule);
    owners.set(sha, new Map(seqs.map((s) => [s, 'recorded_head' as const])));
  }
  return { owners: owners ?? byRule, ownerless };
}

/** The waiting commits a subject or a merge gives to nobody: the only ones a work record can claim. */
export function unclaimedShas(
  commits: readonly WaitingCommit[],
  pattern: RegExp,
  baseBranch: string,
): string[] {
  const byRule = commitOwners(commits, pattern, baseBranch);
  return commits.map((c) => c.sha.toLowerCase()).filter((s) => (byRule.get(s)?.size ?? 0) === 0);
}
