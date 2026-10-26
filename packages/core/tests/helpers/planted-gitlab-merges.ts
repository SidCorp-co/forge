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
/** Each stored request's branch, as the planted host merges it. */
export const heads = new Map<number, string>();
/** Requests the planted host answers as already merged, at the commit that landed them. */
export const alreadyMerged = new Map<number, string>();
/**
 * How the planted merge call fails, by request: `after` merges and then loses the answer, as the
 * relay did for adminhub-fe !1994; `before` loses it without merging; `unreadable` also fails the
 * read back.
 */
export const callFails = new Map<number, 'after' | 'before' | 'unreadable'>();

export const mergeMessage = (number: number, headRef: string) =>
  `Merge branch '${headRef}' into 'release/stg'\n\nMR ${number}\n\nSee merge request acme/canawan-api!${number}`;

export function resetPlanted(): void {
  merged.clear();
  merges.length = 0;
  trees.same = true;
  messages.clear();
  heads.clear();
  alreadyMerged.clear();
  callFails.clear();
}

const TIMEOUT = 'The operation was aborted due to timeout';

/** The repository read every stamp's identity is judged from (`issues/merge-identity.ts`). */
export const plantedRepository = () => ({
  provider: 'gitlab',
  fullName: 'acme/canawan-api',
  readCommit: async (sha: string) => {
    const message = messages.get(sha.toLowerCase());
    return message
      ? { sha: sha.toLowerCase(), message, committedAt: '2026-10-23T09:00:00Z' }
      : null;
  },
  branchContains: async () => true,
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
    if (done) {
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
    if (fails === 'before' || fails === 'unreadable')
      throw new DOMException(TIMEOUT, 'TimeoutError');
    merges.push(number);
    const commitSha = `${String(number).padStart(4, '0')}${'c'.repeat(36)}`;
    merged.set(number, commitSha);
    const headRef = heads.get(number) ?? `mr-${number}`;
    if (!messages.has(commitSha)) messages.set(commitSha, mergeMessage(number, headRef));
    if (fails === 'after') {
      callFails.delete(number);
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
    if (callFails.get(number) === 'unreadable') throw new Error('relay answered 502');
    const landed = merged.get(number) ?? alreadyMerged.get(number) ?? null;
    return {
      number,
      url: null,
      title: `MR ${number}`,
      state: landed ? 'merged' : 'open',
      draft: false,
      headRef: heads.get(number) ?? `mr-${number}`,
      headSha: `${String(number).padStart(4, '0')}${'a'.repeat(36)}`,
      baseRef: 'release/stg',
      baseSha: null,
      updatedAt: null,
      body: null,
      mergedAt: landed ? new Date(Date.UTC(2026, 9, 23, 9, number)).toISOString() : null,
      mergeCommitSha: landed,
    };
  },
  sameTree: async () => {
    if (trees.same instanceof Error) throw trees.same;
    return trees.same;
  },
});
