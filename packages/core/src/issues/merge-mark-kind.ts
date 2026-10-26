/**
 * What an issue's merged mark is, read off its columns, and the sentence saying so: the one reading
 * of the pair (docs/modules/issues/merge-mark.md). Pure: the stamp itself is written only by
 * `merge-record.ts`.
 */

import type { LandingArtifact, MergedHead, ReadPaths } from '@forge/contracts/landing-artifacts';

/** The one name for what the pair of columns means, and the ONLY reading of it:
 *  docs/modules/issues/merge-mark.md. */
export type MergeMarkKind = 'unmarked' | 'asserted' | 'landed' | 'observed';

/** The two columns, as any row carrying them spells them. */
export interface MergeMarkColumns {
  mergedAt: Date | string | null;
  mergedCommitSha: string | null;
  mergedLanding: string | null;
}

export function mergeMarkKindOf(row: MergeMarkColumns): MergeMarkKind {
  if (row.mergedAt == null) return 'unmarked';
  // `''` is representable and is not a commit; the doc says why it reads as a claim.
  if ((row.mergedCommitSha ?? '').trim() !== '') return 'observed';
  return (row.mergedLanding ?? '').trim() === '' ? 'asserted' : 'landed';
}

/** The stamp a design approval alone wrote on a git row (`recordDesignLanding`): no commit, no
 *  landing, no box-read paths, and every artifact a `design` one. A code mark is never shadowed by it. */
export function designOnlyStamp(
  row: MergeMarkColumns & {
    mergedArtifacts: readonly LandingArtifact[] | null;
    mergedPaths: ReadPaths | null;
  },
): string[] | null {
  if (mergeMarkKindOf(row) !== 'asserted' || row.mergedPaths) return null;
  const artifacts = row.mergedArtifacts ?? [];
  if (artifacts.length === 0 || artifacts.some((a) => a.surface !== 'design')) return null;
  return artifacts.map((a) => a.ref);
}

/** The sentence saying which kind this is, written once: the audit comment and the caller's
 *  answer are both built from it. `claimedCommit` is the caller's word, not the column. */
export function describeMergeMark(args: {
  kind: MergeMarkKind;
  commitSha?: string | null;
  claimedCommit?: string | null;
  landing?: string | null;
  /** Where this call read an `observed` commit from the repository rather than a pull request. */
  readFrom?: { repository: string; branch: string } | null;
  /** The branch an `observed` row holds as its target, and the one this call named. */
  target?: string | null;
  claimedTarget?: string | null;
}): string {
  if (args.kind === 'unmarked') {
    return 'this issue carries no merged mark: `merged_at` is empty, so nothing here says the work landed';
  }
  if (args.kind === 'landed') {
    return `this mark names where the work landed outside git: \`merged_landing\` holds ${args.landing ?? 'the landing it was given'}. It is the word of whoever marked it, not a merge Forge observed`;
  }
  if (args.kind === 'observed') {
    // Against the COLUMN, not the row this call selected: docs/modules/issues/merge-mark.md.
    const differs =
      !!args.claimedCommit &&
      args.claimedCommit.toLowerCase() !== (args.commitSha ?? '').toLowerCase();
    const overruled = differs
      ? `. Commit ${args.claimedCommit}, which this call named, is recorded as its claim and is not what the column holds`
      : '';
    const retargeted =
      args.claimedTarget && args.target && args.claimedTarget !== args.target
        ? `. \`merged_target\` holds \`${args.target}\`, the branch that merge landed on as Forge read it; \`${args.claimedTarget}\`, which this call named, is recorded as its claim`
        : '';
    const source = args.readFrom
      ? `read from ${args.readFrom.repository} itself, which resolves it, gives it to this issue by its subject and holds it on ${args.readFrom.branch}`
      : "read by Forge itself, from its record of the pull request or from the project's repository";
    return `this mark is a merge Forge observed: \`merged_commit_sha\` holds ${args.commitSha ?? 'the commit it landed at'}, ${source}, rather than from anybody's word for it${overruled}${retargeted}`;
  }
  const claim = args.claimedCommit
    ? `commit ${args.claimedCommit} is recorded here as this call's claim and is NOT in \`merged_commit_sha\``
    : 'no commit is recorded in `merged_commit_sha`';
  return `this mark is a CLAIM Forge did not observe, not a merge it witnessed: ${claim}, because that column holds only a merge Forge has its own record of. Forge holds no merged pull request for this issue`;
}

/** The flow a design artifact's `<flow>@rev<n>` ref names. */
const flowOfRef = (ref: string) => ref.replace(/@rev\d+$/u, '');

/**
 * The design artifacts a mark carries once `artifact` joins them: where the mark already names design
 * revisions alone, the approved one is added beside them, replacing only the earlier revision of its
 * own flow (FB-140); any other mark is replaced by the approved revision alone.
 */
export function joinedDesignArtifacts(
  held: readonly LandingArtifact[] | null,
  artifact: LandingArtifact,
): LandingArtifact[] {
  const designs = held ?? [];
  if (designs.length === 0 || designs.some((a) => a.surface !== 'design')) return [artifact];
  const flow = flowOfRef(artifact.ref);
  return [...designs.filter((a) => flowOfRef(a.ref) !== flow), artifact];
}

/**
 * The head reading a row keeps when the same merge is observed again: a reading of whether the
 * trees match is never lost to a later observation that names no head, or that could not read the
 * trees of the same head (a transient host failure on a webhook replay); an unread one is upgraded
 * by a reading, and a different head replaces it.
 */
export function keptMergedHead(
  held: MergedHead | null,
  observed: MergedHead | null | undefined,
): MergedHead | null {
  if (!observed) return held;
  const sameHead = held !== null && held.sha.toLowerCase() === observed.sha.toLowerCase();
  if (sameHead && observed.treeIdentical === null && held.treeIdentical !== null) return held;
  return observed;
}
