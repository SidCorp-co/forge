import type { MergedHead } from '@forge/contracts/landing-artifacts';

/**
 * The merged request's head and whether its tree is the landing's, read from the host at the merge
 * (`issues.merged_head`). A head that is the landing itself (a fast-forward) is its tree. A read that
 * fails is kept as unread with its reason, never as identical or different: a verdict at that head
 * then does not count for the landing, and coverage says why. Null where the host named no head.
 */
export async function readMergedHead(
  sameTree: (a: string, b: string) => Promise<boolean>,
  head: string | null | undefined,
  landing: string,
  now: () => Date = () => new Date(),
): Promise<MergedHead | null> {
  const sha = head?.trim().toLowerCase() ?? '';
  if (sha === '') return null;
  const at = () => now().toISOString();
  if (sha === landing.trim().toLowerCase()) {
    return { sha, treeIdentical: true, why: null, readAt: at() };
  }
  try {
    return { sha, treeIdentical: await sameTree(sha, landing), why: null, readAt: at() };
  } catch (err) {
    return {
      sha,
      treeIdentical: null,
      why: `whether its tree is ${landing.slice(0, 12)}'s could not be read from the host: ${err instanceof Error ? err.message : String(err)}`,
      readAt: at(),
    };
  }
}
