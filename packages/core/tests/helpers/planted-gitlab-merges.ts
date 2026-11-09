/**
 * A planted GitLab for the merge-stamp suites: it merges what it is asked to, answers each merge
 * commit's message as GitLab writes one, and answers a request whose commits landed through another
 * as already merged. State only, no Forge module, so a `vi.mock` factory may import it.
 */

export const merged = new Map<number, string>();
export const merges: number[] = [];
/** What the planted host answers: whether a head's tree is its merge commit's, or a read failure. */
export const trees: { same: boolean | Error } = { same: true };
/** Each merge commit's message, as GitLab writes one: the branch it merged and the request it was. */
export const messages = new Map<string, string>();
/** Which commits each commit contains, besides itself: what `compare(base, head)` answers. */
export const contains = new Map<string, Set<string>>();
/** Each stored request's branch, as the planted host merges it. */
export const heads = new Map<number, string>();
/** Each stored request's head commit where the suite planted one; else `headOf`'s. */
export const headShas = new Map<number, string>();
/** Requests the planted host answers as already merged, at the commit that landed them. */
export const alreadyMerged = new Map<number, string>();
/**
 * How the planted merge call fails, by request: `after` merges and then loses the answer, as the
 * relay did for adminhub-fe !1994; `before` loses it without merging; `unreadable` also fails the
 * read back; `host-error` is GitLab's 5xx refusal, which leaves the merge unknown; `after-closed`
 * merges, loses the answer, and from then on reads the request `closed` and merges it again when
 * asked, as GitLab did for adminhub-api !5197 (346580aa, then 5077e8ae over the same head).
 */
export const callFails = new Map<
  number,
  'after' | 'before' | 'unreadable' | 'host-error' | 'after-closed'
>();
/** Requests GitLab reads back `closed` although it merged them, and merges again when asked. */
export const readsClosed = new Set<number>();
/** Requests whose merge call was sent and lost: an `unreadable` one fails its read back from then. */
const asked = new Set<number>();
/** Every commit `release/stg` holds by a merge the planted host made: heads and merge commits. */
export const onTarget = new Set<string>();
/** Each merge commit the planted host made, with its parents: what a range past a head lists. */
export const mergeCommits: Array<{ sha: string; parents: string[]; message: string }> = [];
/** Whether the target's containment read fails, with what, and from which read on (1 = every read). */
export const containment: { fails: Error | null; from: number; reads: number } = {
  fails: null,
  from: 1,
  reads: 0,
};

export const mergeMessage = (number: number, headRef: string) =>
  `Merge branch '${headRef}' into 'release/stg'\n\nMR ${number}\n\nSee merge request acme/canawan-api!${number}`;

export function resetPlanted(): void {
  merged.clear();
  merges.length = 0;
  trees.same = true;
  messages.clear();
  contains.clear();
  heads.clear();
  headShas.clear();
  alreadyMerged.clear();
  callFails.clear();
  readsClosed.clear();
  asked.clear();
  onTarget.clear();
  mergeCommits.length = 0;
  containment.fails = null;
  containment.from = 1;
  containment.reads = 0;
}

/** The head the planted host carries for request `number`. */
export const headOf = (number: number) =>
  headShas.get(number) ?? `${String(number).padStart(4, '0')}${'a'.repeat(36)}`;

const TIMEOUT = 'The operation was aborted due to timeout';

/** The repository read every stamp's identity is judged from (`issues/merge-identity.ts`). */
export const plantedRepository = () => ({
  provider: 'gitlab',
  fullName: 'acme/canawan-api',
  sameTree: async () => {
    if (trees.same instanceof Error) throw trees.same;
    return trees.same;
  },
  readCommit: async (sha: string) => {
    const message = messages.get(sha.toLowerCase());
    return message
      ? { sha: sha.toLowerCase(), message, committedAt: '2026-10-23T09:00:00Z' }
      : null;
  },
  branchContains: async () => true,
  compare: async (base: string, head: string) =>
    base.toLowerCase() === head.toLowerCase()
      ? 'identical'
      : contains.get(head.toLowerCase())?.has(base.toLowerCase())
        ? 'ahead'
        : 'diverged',
});

export const plantedSourceHost = () => ({
  ...plantedRepository(),
  words: { mergeMethods: ['merge', 'squash'], changeRequest: 'merge request', sigil: '!' },
  merge: async ({ number }: { number: number }) => {
    const landed = alreadyMerged.get(number);
    if (landed) {
      // GitLab's answer for a request whose commits landed through another one
      return {
        kind: 'already-merged',
        commitSha: landed,
        mergedAt: new Date(Date.UTC(2026, 9, 23, 12, 0)),
        target: 'release/stg',
        head: null,
      };
    }
    const done = merged.get(number);
    if (done && !readsClosed.has(number)) {
      // GitLab reads the request before merging, and answers one it already merged as that
      return {
        kind: 'already-merged',
        commitSha: done,
        mergedAt: new Date(Date.UTC(2026, 9, 23, 9, number)),
        target: 'release/stg',
        head: `${String(number).padStart(4, '0')}${'a'.repeat(36)}`,
      };
    }
    const fails = callFails.get(number);
    if (fails === 'before' || fails === 'unreadable') {
      asked.add(number);
      throw new DOMException(TIMEOUT, 'TimeoutError');
    }
    if (fails === 'host-error') {
      return {
        kind: 'refused',
        reason: 'host-error',
        detail: `GitLab answered HTTP 502 merging merge request !${number}.`,
      };
    }
    merges.push(number);
    // a second merge of one head (GitLab reading it closed) is a second merge commit
    const commitSha = done
      ? `${String(number).padStart(4, '0')}${'d'.repeat(36)}`
      : `${String(number).padStart(4, '0')}${'c'.repeat(36)}`;
    merged.set(number, commitSha);
    const headRef = heads.get(number) ?? `mr-${number}`;
    if (!messages.has(commitSha)) messages.set(commitSha, mergeMessage(number, headRef));
    onTarget.add(headOf(number));
    onTarget.add(commitSha);
    mergeCommits.push({
      sha: commitSha,
      parents: ['f'.repeat(40), headOf(number)],
      message: mergeMessage(number, headRef),
    });
    if (fails === 'after' || fails === 'after-closed') {
      callFails.delete(number);
      if (fails === 'after-closed') readsClosed.add(number);
      throw new DOMException(TIMEOUT, 'TimeoutError');
    }
    // each request merges a minute after the one numbered below it, into release/stg, at its head
    return {
      kind: 'merged',
      commitSha,
      mergedAt: new Date(Date.UTC(2026, 9, 23, 9, number)),
      target: 'release/stg',
      head: `${String(number).padStart(4, '0')}${'a'.repeat(36)}`,
    };
  },
  readChangeRequest: async (number: number) => {
    // the read before the merge answers; only the read back after the lost answer fails
    if (callFails.get(number) === 'unreadable' && asked.has(number)) {
      throw new Error('relay answered 502');
    }
    const landed = readsClosed.has(number)
      ? null
      : (merged.get(number) ?? alreadyMerged.get(number) ?? null);
    return {
      number,
      url: null,
      title: `MR ${number}`,
      state: readsClosed.has(number) ? 'closed' : landed ? 'merged' : 'open',
      draft: false,
      headRef: heads.get(number) ?? `mr-${number}`,
      headSha: headOf(number),
      baseRef: 'release/stg',
      baseSha: null,
      updatedAt: null,
      body: null,
      mergedAt: landed ? new Date(Date.UTC(2026, 9, 23, 9, number)).toISOString() : null,
      mergeCommitSha: landed,
    };
  },
  // the target holds what the planted host merged into it, and nothing else
  branchContains: async (_branch: string, sha: string) => {
    containment.reads += 1;
    if (containment.fails && containment.reads >= containment.from) throw containment.fails;
    return onTarget.has(sha.toLowerCase());
  },
  readRange: async (base: string) => ({
    ok: true,
    commits: mergeCommits.filter((c) => c.parents.includes(base.toLowerCase())),
    complete: true,
  }),
});
