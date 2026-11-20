// Two verdicts the door used to answer 201 for nothing (ISS-1355, adminhub-api FB-767):
//
//   rule                                                                         code
//   at a shipped release's build carrying the issue, an identity that release    VERDICT_IDENTITY_NOT_COUNTED
//   never counts (`release-page.ts:countedForClass`): a runtime where the
//   project names no testing environment, a commit where it names one
//   a skip where the criterion stands on a counted pass at that same build       VERDICT_SKIP_OVER_PASS
//
// The first reads the one rule every count of a release's proof reads, so the door and the release
// never disagree; a verdict at a landing, before any release ships at its commit, is never asked. The
// second is refused rather than kept beside the pass: every count of proof reads a criterion by its
// newest judge's verdict (`verified-rule.ts:judgesVerdict`), so a skip kept there would take the pass
// away from the release page, the requirement's coverage and the owed-verdict nudge alike, and a skip
// carries no evidence that the criterion does not hold.

import { judgedOnOf } from '@forge/contracts/delivery-policy';
import type { CriterionClass } from '@forge/contracts/issue-design';
import { countedForClass } from '@forge/contracts/release-page';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { criterionVerdicts } from '../../db/schema-issue-criteria.js';
import { readProjectDocument, releasesCarryingAt } from '../ports.js';
import { countingOf } from './verdict-counting.js';
import type { VerdictRefusal } from './verdict-input.js';

type Identity = Partial<
  Pick<
    typeof criterionVerdicts.$inferInsert,
    'identityKind' | 'commitSha' | 'runtimeRef' | 'releaseVersion' | 'acceptedOn'
  >
>;

const WHOLE = /^[0-9a-f]{40}$/;

/** The build a commit or runtime identity names, lower case; null on any other identity. */
function buildOf(identity: Identity): string | null {
  const named =
    identity.identityKind === 'commit'
      ? identity.commitSha
      : identity.identityKind === 'runtime'
        ? identity.runtimeRef
        : null;
  const sha = named?.trim().toLowerCase() ?? '';
  return WHOLE.test(sha) ? sha : null;
}

/**
 * Why a verdict judged at the build of a shipped release carrying the issue is one that release never
 * counts, naming the identity it does count; null where it counts, or where no shipped release
 * carrying the issue was built at that commit.
 */
export async function uncountedOnReleaseFault(
  issue: { id: string; projectId: string },
  criterion: number,
  identity: Identity,
  criterionClass: CriterionClass | null,
): Promise<VerdictRefusal | null> {
  const build = buildOf(identity);
  if (build === null) return null;
  const versions = await releasesCarryingAt(issue, build);
  if (versions.length === 0) return null;
  const judgedOn = judgedOnOf((await readProjectDocument(issue.projectId))?.document.delivery);
  const reading = {
    identityKind: identity.identityKind ?? null,
    commitSha: identity.commitSha ?? null,
    runtimeRef: identity.runtimeRef ?? null,
    acceptedOn: identity.acceptedOn ?? null,
    at: new Date().toISOString(),
  };
  if (countedForClass(reading, criterionClass, build, judgedOn)) return null;
  const releases = `release${versions.length === 1 ? '' : 's'} ${versions.join(', ')}`;
  const sent = `\`{ kind: '${identity.identityKind}', ${identity.identityKind === 'commit' ? 'sha' : 'ref'}: '${build}' }\``;
  const counts =
    judgedOn === null
      ? `\`{ kind: 'commit', sha: '${build}' }\`: this project names no testing environment (\`delivery.judgedOn\`), so its releases count a verdict whose identity is the commit they were built at, and never a runtime one`
      : `\`{ kind: 'runtime', ref: '${build}' }\`: this project's releases are judged on \`${judgedOn}\` (\`delivery.judgedOn\`), so they count a verdict judged on the build it serves, and a commit verdict gates the merge only`;
  return {
    code: 'VERDICT_IDENTITY_NOT_COUNTED',
    criterion,
    path: '/identity',
    detail: `criterion ${criterion}'s verdict names ${sent}, the build ${releases} shipped carrying this issue, and ${versions.length === 1 ? 'it' : 'they'} would never count it. Send the same verdict with identity ${counts}. Nothing was written.`,
  };
}

/** The rows at the same build as `identity`, as a where clause; null on an identity naming no build. */
function sameBuild(identity: Identity): SQL | null {
  const kind = identity.identityKind;
  const at =
    kind === 'commit' && identity.commitSha
      ? eq(criterionVerdicts.commitSha, identity.commitSha)
      : kind === 'runtime' && identity.runtimeRef
        ? eq(criterionVerdicts.runtimeRef, identity.runtimeRef)
        : kind === 'release' && identity.releaseVersion
          ? eq(criterionVerdicts.releaseVersion, identity.releaseVersion)
          : null;
  return kind && at ? (and(eq(criterionVerdicts.identityKind, kind), at) ?? null) : null;
}

/**
 * Why a `skipped` verdict may not be kept: the criterion stands on a pass at the same build that
 * counts (the newest verdict there a builder's barred pass does not hide, as `judgesVerdict` reads
 * it), so the skip would take that pass away. Null for any other verdict or standing.
 */
export async function skipOverPassFault(
  tx: Tx,
  issue: { id: string; projectId: string },
  args: { criterionId: string; criterion: number; verdict: string; identity: Identity },
): Promise<VerdictRefusal | null> {
  if (args.verdict !== 'skipped') return null;
  const at = sameBuild(args.identity);
  if (at === null) return null;
  const rows = await tx
    .select({
      id: criterionVerdicts.id,
      verdict: criterionVerdicts.verdict,
      at: criterionVerdicts.createdAt,
    })
    .from(criterionVerdicts)
    .where(and(eq(criterionVerdicts.criterionId, args.criterionId), at))
    .orderBy(desc(criterionVerdicts.createdAt), desc(criterionVerdicts.id));
  const counting = await countingOf(tx, issue.projectId, rows);
  const stands = rows.find((r) => counting.get(r.id)?.notCounted == null);
  if (stands?.verdict !== 'pass') return null;
  return {
    code: 'VERDICT_SKIP_OVER_PASS',
    criterion: args.criterion,
    path: '/verdict',
    detail: `criterion ${args.criterion} stands on a pass at this same build (verdict \`${stands.id}\`, ${stands.at.toISOString()}), and a skip names only what this judge could not reach: kept, it would take that pass away from every count of proof. The criterion stays earned; send nothing, or a \`fail\` naming what you saw where it no longer holds. Nothing was written.`,
  };
}
