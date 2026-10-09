// What a release page may claim, under its one truth rule (REQ-40 BC-13): every criterion the
// release carries, read through `releaseClaimOf` at the build the page describes. A claimed
// criterion proves its requirement criterion live (BC-5) and lends its kept clip or picture to a
// highlight (BC-3); every other one is a known issue as its verdict on the build reads (BC-8). Pure:
// the loaders in facts.ts hand it rows.

import {
  RELEASE_CLIP_MAX_BYTES,
  type ReleaseClaim,
  type ReleaseKnownIssue,
  type ReleaseMediaRef,
  type ReleasePageRequirement,
  type ReleaseVerdictReading,
  releaseClaimOf,
  releaseMediaKindOf,
} from '@forge/contracts/release-page';

export interface CarriedVerdict extends ReleaseVerdictReading {
  id: string;
  reason: string | null;
  evidence: readonly string[];
}

/** One live criterion of an issue the release carries, with every verdict it earned since its last reopen. */
export interface CarriedCriterion {
  issueId: string;
  issueKey: string;
  requirementKey: string | null;
  n: number;
  statement: string;
  bc: string | null;
  verdicts: readonly CarriedVerdict[];
}

/** A file kept on an issue, as `issue_attachments` holds it. */
export interface IssueFile {
  id: string;
  issueId: string;
  name: string;
  mime: string;
  bytes: number;
}

export interface ClaimReading {
  criterion: CarriedCriterion;
  claim: ReleaseClaim;
  /** The verdict on the build the claim reads: the pass it claims, or the short, fail or skip it is held by. */
  onBuild: CarriedVerdict | null;
}

/** The newest verdict whose identity is `build`: the one `releaseClaimOf` reads. */
function newestOnBuild(
  verdicts: readonly CarriedVerdict[],
  build: string | null,
): CarriedVerdict | null {
  if (build === null) return null;
  return (
    [...verdicts]
      .sort((a, b) => b.at.localeCompare(a.at))
      .find((v) => v.identityKind === 'commit' && v.commitSha === build) ?? null
  );
}

export function readClaims(
  criteria: readonly CarriedCriterion[],
  build: string | null,
): ClaimReading[] {
  return criteria.map((criterion) => ({
    criterion,
    claim: releaseClaimOf(criterion.verdicts, build),
    onBuild: newestOnBuild(criterion.verdicts, build),
  }));
}

/** Every carried criterion the page does not claim, with its standing on the build and where it was judged instead. */
export function knownIssuesOf(claims: readonly ClaimReading[]): ReleaseKnownIssue[] {
  return claims.flatMap(({ criterion, claim, onBuild }) =>
    claim.claimed
      ? []
      : [
          {
            issueKey: criterion.issueKey,
            requirementKey: criterion.requirementKey,
            bc: criterion.bc,
            statement: criterion.statement,
            standing: claim.standing,
            reason: claim.standing === 'not_judged' ? null : (onBuild?.reason ?? null),
            elsewhere: claim.elsewhere,
          },
        ],
  );
}

/** The requirement criteria each requirement proves live on the build: a code is claimable once one carried criterion tracing it is claimed. */
export function claimableByRequirement(claims: readonly ClaimReading[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { criterion, claim } of claims) {
    if (!claim.claimed || !criterion.requirementKey || !criterion.bc) continue;
    const codes = out.get(criterion.requirementKey) ?? new Set<string>();
    codes.add(criterion.bc);
    out.set(criterion.requirementKey, codes);
  }
  return out;
}

export interface CarriedRequirement {
  key: string;
  title: string;
  completes: boolean;
  /** Its live criteria by code: the statement a reader reads. */
  criteria: ReadonlyMap<string, string>;
}

const byCode = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/** Each requirement the release completes or advances, with the criteria it proves live and how many of its carried criteria are known issues (BC-5). */
export function requirementsOf(
  requirements: readonly CarriedRequirement[],
  claims: readonly ClaimReading[],
): ReleasePageRequirement[] {
  const claimable = claimableByRequirement(claims);
  return requirements.map((r) => ({
    key: r.key,
    title: r.title,
    completes: r.completes,
    proven: [...(claimable.get(r.key) ?? [])]
      .sort(byCode)
      .map((code) => ({ code, statement: r.criteria.get(code) ?? '' })),
    unproven: claims.filter((c) => !c.claim.claimed && c.criterion.requirementKey === r.key).length,
  }));
}

/**
 * The clips and pictures a highlight may show: each file a claimed pass on the build cites by name
 * in its evidence, on that criterion's own issue, of a kind a page shows and within the clip
 * ceiling. Clips first, so a highlight that can show one does.
 */
export function mediaOf(
  claims: readonly ClaimReading[],
  files: readonly IssueFile[],
  build: string | null,
): ReleaseMediaRef[] {
  if (build === null) return [];
  const out: ReleaseMediaRef[] = [];
  const seen = new Set<string>();
  for (const { criterion, claim, onBuild } of claims) {
    if (!claim.claimed || !onBuild || criterion.bc === null) continue;
    for (const cited of onBuild.evidence) {
      const file = files.find((f) => f.issueId === criterion.issueId && f.name === cited);
      const kind = file ? releaseMediaKindOf(file.mime) : null;
      if (!file || !kind || seen.has(file.id)) continue;
      if (file.bytes <= 0 || file.bytes > RELEASE_CLIP_MAX_BYTES) continue;
      seen.add(file.id);
      out.push({
        kind,
        attachmentId: file.id,
        name: file.name,
        mime: file.mime as ReleaseMediaRef['mime'],
        bytes: file.bytes,
        verdictId: onBuild.id,
        issueKey: criterion.issueKey,
        criterion: { n: criterion.n, bc: criterion.bc },
        commitSha: build,
      });
    }
  }
  return [...out.filter((m) => m.kind === 'clip'), ...out.filter((m) => m.kind === 'picture')];
}
