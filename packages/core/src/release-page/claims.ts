// What a release page may claim, under its one truth rule (REQ-40 BC-13): every criterion the
// release carries, read at the build the page describes by the rule a requirement's coverage counts
// by (`requirements:unverifiedWhy`, REQ-35 decision 7b261fca): the verdict it stands on is the
// judge's (`requirements:judgesVerdict`), and only a pass that rule counts as verified proves it, so
// a short, or under an independent judge the builder's own pass, is never listed or counted as
// proven. A claimed criterion proves its requirement criterion live (BC-5) and lends its kept clip or
// picture to a highlight (BC-3); every other one is a known issue as its verdict on the build reads
// (BC-8). Pure: the loaders in facts.ts hand it rows.

import type { PolicyQaMode } from '@forge/contracts/project-config';
import {
  RELEASE_CLIP_MAX_BYTES,
  type ReleaseClaim,
  type ReleaseKnownIssue,
  type ReleaseMediaRef,
  type ReleasePageCriteria,
  type ReleasePageProven,
  type ReleasePageRequirement,
  type ReleaseVerdictReading,
  releaseClaimOf,
  releaseMediaKindOf,
} from '@forge/contracts/release-page';
import { judgesVerdict, unverifiedWhy } from '../requirements/index.js';

export interface CarriedVerdict extends ReleaseVerdictReading {
  id: string;
  reason: string | null;
  evidence: readonly string[];
  /** Recorded by the issue's builder; the verified rule reads it. */
  byBuilder: boolean;
  /** Names who recorded it. */
  authored: boolean;
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
  /**
   * Whether it counts as proven on the build: the verdict it stands on there is a pass the verified
   * rule counts (`requirements:unverifiedWhy`); on a draft, which has no build, its newest verdict.
   */
  proven: boolean;
  /** Where its verdict on the build is a pass the verified rule does not count, why; else null. */
  unverified: string | null;
  /** The verdict on the build the claim reads: the pass it claims, or the short, fail, skip or uncounted pass it is held by. */
  onBuild: CarriedVerdict | null;
}

/** The verdicts a release reads a criterion by, newest first: those on `build`, or every one on a draft. */
function readAt(verdicts: readonly CarriedVerdict[], build: string | null): CarriedVerdict[] {
  const newestFirst = [...verdicts].sort((a, b) => b.at.localeCompare(a.at));
  return build === null
    ? newestFirst
    : newestFirst.filter((v) => v.identityKind === 'commit' && v.commitSha === build);
}

export function readClaims(
  criteria: readonly CarriedCriterion[],
  build: string | null,
  judge: PolicyQaMode | null,
): ClaimReading[] {
  return criteria.map((criterion) => {
    const stands = judgesVerdict(readAt(criterion.verdicts, build), judge) ?? null;
    const why = stands ? unverifiedWhy(stands, judge) : null;
    const proven =
      stands !== null && stands.identityKind !== 'commit_unresolved' && stands.verdict === 'pass' && why === null;
    const onBuild = build === null ? null : stands;
    let claim: ReleaseClaim;
    if (build === null || onBuild === null) claim = releaseClaimOf(criterion.verdicts, build);
    else if (proven) claim = { claimed: true, at: onBuild.at };
    else if (onBuild.verdict === 'pass') claim = { claimed: false, standing: 'not_judged', elsewhere: null };
    else claim = { claimed: false, standing: onBuild.verdict, elsewhere: null };
    return { criterion, claim, proven, unverified: stands?.verdict === 'pass' ? why : null, onBuild };
  });
}

/**
 * Every carried criterion the page does not claim, with its standing on the build and where it was
 * judged instead. One the page lists as proven (`proven`, the standing the header counts by) is never
 * also a known issue: on a draft, which has no build to claim on, a criterion whose newest verdict is
 * a counted pass reads as proven once, not as proven and "not yet judged" both. A pass on the build
 * the verified rule does not count reads as not judged, saying why.
 */
export function knownIssuesOf(claims: readonly ClaimReading[]): ReleaseKnownIssue[] {
  return claims.flatMap(({ criterion, claim, onBuild, proven, unverified }) =>
    claim.claimed || proven
      ? []
      : [
          {
            issueKey: criterion.issueKey,
            requirementKey: criterion.requirementKey,
            bc: criterion.bc,
            statement: criterion.statement,
            standing: claim.standing,
            reason:
              claim.standing === 'not_judged' ? unverified : (onBuild?.reason ?? null),
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

const byCode = (a: string | null, b: string | null) =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : a.localeCompare(b, 'en', { numeric: true });

const byKeyThenN = (a: ReleasePageProven, b: ReleasePageProven) =>
  (a.issueKey ?? '').localeCompare(b.issueKey ?? '', 'en', { numeric: true }) ||
  (a.n ?? 0) - (b.n ?? 0);

/**
 * One group's carried criteria, each row one issue criterion as the header counts it (BC-5), in its
 * own wording so rows tracing one code read apart: the proven ones listed, the traced ones in code
 * order, then those that trace no code; the rest, a short among them, counted as not proven on the
 * build. A proven row is never short now: only a pass is verified.
 */
function criteriaOf(claims: readonly ClaimReading[]): ReleasePageCriteria {
  const proven: ReleasePageProven[] = claims
    .filter((c) => c.proven)
    .map(({ criterion }) => ({
      code: criterion.bc,
      statement: criterion.statement,
      short: false,
      issueKey: criterion.issueKey,
      n: criterion.n,
    }))
    .sort((a, b) => byCode(a.code, b.code) || byKeyThenN(a, b));
  return { proven, unproven: claims.length - proven.length };
}

/**
 * Each requirement the release completes or advances (BC-5): every carried criterion it proves live
 * and how many it does not, and its own live criteria counted in them, each one a proven row traces
 * said once in its words.
 */
export function requirementsOf(
  requirements: readonly CarriedRequirement[],
  claims: readonly ClaimReading[],
): ReleasePageRequirement[] {
  return requirements.map((r) => {
    const group = criteriaOf(claims.filter((c) => c.criterion.requirementKey === r.key));
    const traced = new Set(group.proven.map((p) => p.code));
    return {
      key: r.key,
      title: r.title,
      completes: r.completes,
      ...group,
      business: {
        total: r.criteria.size,
        proven: [...r.criteria]
          .filter(([code]) => traced.has(code))
          .map(([code, statement]) => ({ code, statement }))
          .sort((a, b) => byCode(a.code, b.code)),
      },
    };
  });
}

/**
 * The carried criteria under no requirement the page lists: of issues tracing none, or one the
 * release record does not carry. Null where there are none, so the list sums to the header's total.
 */
export function untracedOf(
  requirements: readonly CarriedRequirement[],
  claims: readonly ClaimReading[],
): ReleasePageCriteria | null {
  const listed = new Set(requirements.map((r) => r.key));
  const rest = claims.filter(
    (c) => c.criterion.requirementKey === null || !listed.has(c.criterion.requirementKey),
  );
  return rest.length === 0 ? null : criteriaOf(rest);
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
