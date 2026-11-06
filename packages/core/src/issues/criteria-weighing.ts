// What each criterion's verdict is worth to the gate that will decide its issue, as the criteria read
// shows it (forge-core-61), and as the steward's facts state it (ISS-1035). A project with no
// production weighs at the build it delivers; a promotion project at the landing; any other at what is served:
// the judged-on environment until the issue is released, production after (`runtime-standing.ts:
// weighedOn`). The weighing is the release's (`release-batch/criteria-weighing.ts`), reached here
// through a port; this module only places its answer on each criterion.

import type { VerdictStanding } from './verdict-standing.js';

/** Where a criterion was weighed. */
export type CriterionWeighedOn =
  /** At the issue's landing commit, the release crossing a promotion from `landsOn` to `deploysFrom`. */
  | {
      readonly basis: 'landing';
      /** The landing commit, or null where the issue's merge names none. */
      readonly landing: string | null;
      readonly landsOn: string;
      readonly deploysFrom: string;
    }
  /** At the build a project with no production delivers (`release-batch/landed-build.ts:deliveredBuildsOf`):
   *  its landing on its working branch, a later head holding it, or a change request's head or merge.
   *  `said` names that build as its reading does. */
  | {
      readonly basis: 'delivered';
      readonly delivery: 'landing' | 'change-request';
      readonly build: string;
      readonly from: 'record' | 'merge' | 'mark' | 'ahead' | 'change-request' | 'landed';
      readonly said: string;
    }
  /** At what is served: `environment` is the judged-on environment read in production's place, or
   *  null where production's reading was weighed; `runtime` the declared release runtime that
   *  decided, or null for the deployment. */
  | {
      readonly basis: 'served';
      readonly environment: string | null;
      readonly runtime: string | null;
    }
  /** Nowhere: `reason` on the criterion says why no basis could be computed. */
  | { readonly basis: 'none' };

export interface CriterionWeighing {
  /** Whether the gate counts this criterion earned; null where nothing was weighed, or where only
   *  whether what is served carries its verdict is unknown (`standing: 'unread'`), which a release
   *  pass decides by asking the source host and a read never asks. */
  readonly earned: boolean | null;
  /**
   * How the verdict's identity resolved on a served basis — `carried` where a served commit other
   * than the judged one carries it — or `stands` / `carried` at a landing for a verdict that counts
   * there (at the landing itself / at a later build holding it). Null where no verdict was weighed,
   * or a landing does not count it.
   */
  readonly standing: VerdictStanding | 'carried' | null;
  readonly reason: string;
  readonly weighedOn: CriterionWeighedOn;
  /**
   * Where an unearned criterion only the running product shows is judged, never at a commit
   * (`release-batch/landed-weighing.ts:weighLiveOnly`): on the live release now, or after the release
   * that carries the issue ships, when it holds nothing until then.
   */
  readonly owedOn?: 'live-release' | 'after-release';
}

/** One issue's weighing: per criterion number, or why there is none for any of them. */
export type IssueCriteriaWeighing =
  | { readonly kind: 'weighed'; readonly criteria: ReadonlyMap<number, CriterionWeighing> }
  | { readonly kind: 'none'; readonly why: string };

const NOT_NAMED =
  'the weighing named no standing for this criterion, so nothing says whether it counts';

/** The weighing a criterion carries on the criteria read; a criterion the weighing missed says so. */
export function weighingOf(read: IssueCriteriaWeighing, n: number): CriterionWeighing {
  const none = (reason: string): CriterionWeighing => ({
    earned: null,
    standing: null,
    reason,
    weighedOn: { basis: 'none' },
  });
  if (read.kind === 'none') return none(read.why);
  return read.criteria.get(n) ?? none(NOT_NAMED);
}
