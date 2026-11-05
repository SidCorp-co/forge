// What a release page may claim, under its one truth rule (REQ-40 BC-13): every criterion the
// release carries, as its release record weighed it (`release-batch/release-facts.ts:criterionReadingsAt`,
// read once by `release-read-views.ts:weighedOf`), the weighing its header counts. The page never
// weighs a criterion again (ISS-1001: adminhub-api 0.10.0 read 110/111 in its header while the page,
// re-reading every verdict at the exact build, listed 62 of them not judged). Only a pass on the build
// is claimed: a claimed criterion proves its requirement criterion live (BC-5) and lends its kept
// clip or picture to a highlight (BC-3); every criterion the record does not count proven is a known
// issue as its verdict on the build reads (BC-8). Pure: the loaders hand it rows.

import {
  citesAttachment,
  RELEASE_CLIP_MAX_BYTES,
  type ReleaseClaim,
  type ReleaseKnownIssue,
  type ReleaseMediaRef,
  type ReleasePageCriteria,
  type ReleasePageProven,
  type ReleasePageRequirement,
  releaseMediaKindOf,
} from '@forge/contracts/release-page';
import type { CarriedVerdict, CriterionReading, WeighedIssue } from '../release-batch/index.js';

export type { CarriedVerdict };

/** One criterion of an issue the release counts, as a reader names it. */
export interface CarriedCriterion {
  issueId: string;
  issueKey: string;
  requirementKey: string | null;
  n: number;
  statement: string;
  bc: string | null;
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
  /** Whether the release record counts it proven: the one count its header and list read. */
  proven: boolean;
  /** Where the record does not count it proven though it was passed or not judged there, why; else null. */
  unverified: string | null;
  /** The verdict on the build the claim reads: the pass it claims, or the short, fail, skip or uncounted pass it is held by. */
  onBuild: CarriedVerdict | null;
  /** Proven by the building run's own pass, counted only under the builder-pass cutover. */
  underCutover: boolean;
}

/**
 * Whether the page may claim a criterion, off its reading: a pass on the build the record counts
 * proven is claimed; a short, a fail or a skip there is a known issue as itself; an uncounted pass
 * there, or no verdict on it, is `not_judged`, naming its newest verdict elsewhere.
 */
function claimOf({ view, onBuild, newest }: CriterionReading): ReleaseClaim {
  if (onBuild?.verdict === 'pass' && view.proven) return { claimed: true, at: onBuild.at };
  if (onBuild && onBuild.verdict !== 'pass')
    return { claimed: false, standing: onBuild.verdict, elsewhere: null };
  const elsewhere =
    onBuild === null && newest ? { verdict: newest.verdict, commitSha: newest.commitSha } : null;
  return { claimed: false, standing: 'not_judged', elsewhere };
}

/** Every criterion the release counts, as its record weighed it, in the order it counts them. */
export function claimsOf(weighed: readonly WeighedIssue[]): ClaimReading[] {
  return weighed.flatMap(({ issue, requirementKey, readings }) =>
    readings.map((reading) => ({
      criterion: {
        issueId: issue.id,
        issueKey: issue.key,
        requirementKey,
        n: reading.view.n,
        statement: reading.view.statement,
        bc: reading.view.bc,
      },
      claim: claimOf(reading),
      proven: reading.view.proven,
      unverified: reading.view.unverified,
      onBuild: reading.onBuild,
      underCutover: reading.underCutover,
    })),
  );
}

/**
 * Every carried criterion the page does not claim, with its standing on the build and where it was
 * judged instead. One the record counts proven (`proven`, the standing the header counts by) is never
 * also a known issue: on a draft, which has no build to claim on, or where its issue earned it at its
 * landing (FB-515), it reads as proven once, not as proven and "not yet judged" both. A pass on the
 * build the verified rule does not count reads as not judged, saying why.
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
            reason: claim.standing === 'not_judged' ? unverified : (onBuild?.reason ?? null),
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
    .map(({ criterion, underCutover }) => ({
      code: criterion.bc,
      statement: criterion.statement,
      short: false,
      issueKey: criterion.issueKey,
      n: criterion.n,
      countedUnderCutover: underCutover,
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

const stem = (name: string) => name.replace(/\.[^.]+$/u, '').replace(/\.poster$/u, '');

/**
 * The still a clip opens on: a picture the same verdict cites beside it on the same issue, the one
 * named after the clip (`<clip>.png` or `<clip>.poster.png`, as the recorder writes it) first.
 */
function posterOf(clip: IssueFile, cited: readonly IssueFile[]): ReleaseMediaRef['poster'] {
  const pictures = cited.filter((f) => releaseMediaKindOf(f.mime) === 'picture' && f.bytes > 0);
  const still = pictures.find((f) => stem(f.name) === stem(clip.name)) ?? pictures[0];
  return still
    ? {
        attachmentId: still.id,
        name: still.name,
        mime: still.mime as NonNullable<ReleaseMediaRef['poster']>['mime'],
      }
    : null;
}

/** What a claimed pass judged, as its media names it: its release, else the build; null with neither. */
function judgedOf(
  v: CarriedVerdict,
  build: string | null,
): { releaseVersion: string } | { commitSha: string } | null {
  if (v.identityKind === 'release' && v.releaseVersion) return { releaseVersion: v.releaseVersion };
  return build === null ? null : { commitSha: build };
}

/**
 * The clips and pictures a highlight may show: each file a claimed pass on the build cites in its
 * evidence by its name, its id or its download URL (contracts `citesAttachment`), on that criterion's own issue, of a kind a page shows and within the clip
 * ceiling, a clip with the still it opens on. Clips first, so a highlight that can show one does.
 * Each names what its pass judged: the build, or the release a pass judged on a release names
 * (ISS-900), so a release that names no build shows its media by version.
 */
export function mediaOf(
  claims: readonly ClaimReading[],
  files: readonly IssueFile[],
  build: string | null,
): ReleaseMediaRef[] {
  const out: ReleaseMediaRef[] = [];
  const seen = new Set<string>();
  for (const { criterion, claim, onBuild } of claims) {
    if (!claim.claimed || !onBuild || criterion.bc === null) continue;
    const judged = judgedOf(onBuild, build);
    if (!judged) continue;
    const ofVerdict = onBuild.evidence.flatMap((cited) => {
      const file = files.find((f) => f.issueId === criterion.issueId && citesAttachment(cited, f));
      return file ? [file] : [];
    });
    for (const cited of onBuild.evidence) {
      const file = files.find((f) => f.issueId === criterion.issueId && citesAttachment(cited, f));
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
        ...judged,
        ...(kind === 'clip' ? { poster: posterOf(file, ofVerdict) } : {}),
      });
    }
  }
  return [...out.filter((m) => m.kind === 'clip'), ...out.filter((m) => m.kind === 'picture')];
}
