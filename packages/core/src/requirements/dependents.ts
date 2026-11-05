import type { ReleaseLeg } from '@forge/contracts/forecast';
import type { ActorAgency } from '@forge/contracts/permissions';
import type { RequirementFeedbackItem } from '@forge/contracts/requirements';
import type { Tx } from '../db/client.js';
import type { ReadDoor } from '../feedback/index.js';
import { portSlot } from '../lib/port-slot.js';
import type { ProposeDuplicate } from './near-duplicate.js';
import type { LiveBuildHolds } from './standing.js';
import type { LandedHolds, ReleasedLine } from './standing-identity.js';

/**
 * What feedback and suggestions answer for, and file on, a requirement, what the release owes the
 * issues it has landed, and what the live build holds of the commits verdicts were judged at. Each
 * builds on requirements or sits in a later context, so the composition root hands them in at boot
 * rather than this module importing them.
 */
export interface RequirementDependents {
  /** Every feedback item about the requirement, as its detail shows them. */
  feedbackOf(
    viewer: { userId: string; agency: ActorAgency },
    projectId: string,
    requirementId: string,
    door?: ReadDoor,
  ): Promise<RequirementFeedbackItem[]>;
  /** A newer revision is the head: every proposed suggestion on another base goes stale, in `tx`. */
  revised(tx: Tx, requirementId: string, head: number): Promise<unknown>;
  /** Files a duplicate suggestion on the requirement, as its agree meets an undecided near-duplicate. */
  proposeDuplicate: ProposeDuplicate;
  /** What follows a landing on the project as `userId` reads it (`forecast/release.ts:releaseLegFor`): the release on its own, or the act a person owes. */
  releaseLeg(projectId: string, userId: string | null): Promise<ReleaseLeg>;
  /** What the project's live build holds of verdict commits, and the commit each verdict runtime served (`release-batch/judged-build.ts:liveBuildHolds`); null where nothing was asked. */
  liveBuildHolds(
    projectId: string,
    asked: { commits: readonly string[]; runtimes: readonly string[] },
  ): Promise<LiveBuildHolds | null>;
  /**
   * Each issue's landed build, which its verdicts are weighed on, and whether each later commit
   * `judged` names for an issue holds it, where the release weighs the issue's criteria at its
   * landing: a project with no production environment, or one whose production a promotion reaches
   * (`release-batch/criteria-basis.ts:coverageLandingHolds`, ISS-849); null where it weighs at what
   * is served.
   */
  landingHolds(
    projectId: string,
    issueIds: readonly string[],
    judged: ReadonlyMap<string, readonly { kind: string; value: string }[]>,
  ): Promise<LiveBuildHolds | null>;
  /**
   * Where the release weighs at what is served, each issue's landing as the landing weighing reads it,
   * with what the commits `judged` names for an issue hold of it
   * (`release-batch/criteria-basis.ts:servedLandingHolds`, ISS-1018): where a verdict the live build
   * does not hold is weighed.
   */
  servedLandings(
    projectId: string,
    issueIds: readonly string[],
    judged: ReadonlyMap<string, readonly { kind: string; value: string }[]>,
  ): Promise<ReadonlyMap<string, LandedHolds>>;
  /**
   * On a project whose production names no commit it serves (no source probe), its shipped releases
   * and the one its record says is live, which a verdict naming a release is weighed on
   * (`release-batch/released-line.ts:releasedLineOf`, ISS-900); null on any other project.
   */
  releasedLine(projectId: string): Promise<ReleasedLine | null>;
  /** A release version as the record stores it (`v0.76.0` → `0.76.0`); null where the text is none. */
  releaseVersionOf(text: string): string | null;
  /**
   * The questions holding the requirement's value check, each unanswered and blocking (REQ-65 BC-4,
   * `intake/value-held.ts`): an agree waits for them as for any blocking question.
   */
  valueCheckHeld(tx: Tx, requirementId: string): Promise<string[]>;
  /** The landing record that closed each issue standing closed (`release-batch/landing-records.ts`). */
  landedRecordsOf(
    issueIds: readonly string[],
  ): Promise<ReadonlyMap<string, { branch: string; commit: string | null; at: string }>>;
}

const slot = portSlot<RequirementDependents>('requirements', 'provideRequirementDependents');
export const provideRequirementDependents = slot.provide;
export const requirementDependents = slot.get;
