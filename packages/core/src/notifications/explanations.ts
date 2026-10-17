import type { StuckIssueKind } from '@forge/contracts/notifications';
import { stuckGroupTitle } from '@forge/contracts/stuck-words';

/**
 * ISS-1168 — what each sweep detector is, said once. A record carries what is specific to its
 * issue and the list route returns the explanation beside the delivery, named by the group key
 * the sweep wrote, so deliveries written before this existed are explained too. A group's title is
 * its stuck kind's sentence from `@forge/contracts/stuck-words`, which the project page reads too
 * (ISS-1229 r14).
 */

export const SWEEP_DETECTORS = {
  'owed-close': {
    kind: 'owed_close',
    groupTitle: stuckGroupTitle('owed_close'),
    explanation:
      'The step that owed the close did not write it. Read the branch, then close the issue — or, if it never landed, clear the mark with `unmark` and move the issue to Dropped.',
  },
  stranded: {
    kind: 'waiting',
    groupTitle: stuckGroupTitle('waiting'),
    explanation:
      'Each one waits for a decision or for something only a person can supply. Open it: its last comment says what is asked.',
  },
  'idle-issues': {
    kind: 'idle',
    groupTitle: stuckGroupTitle('idle'),
    explanation: 'Nothing was moved. Each issue says what it waits for and who owes the next move.',
  },
  'orphan-assertion': {
    kind: 'orphan',
    groupTitle: stuckGroupTitle('orphan'),
    explanation:
      'Nothing has been moved: whether the issue or the run record is the wrong half is not decidable from here.',
  },
} as const satisfies Record<
  string,
  { kind: StuckIssueKind; groupTitle: string; explanation: string }
>;

export type SweepDetector = keyof typeof SWEEP_DETECTORS;

const GROUP_KEY_SHAPE = /^sweep:([a-z-]+):\d+$/;

/** One evaluation of one detector: every record a tick raises shares it, truncated to the minute. */
export function sweepGroupKey(detector: SweepDetector, now: Date): string {
  return `sweep:${detector}:${Math.floor(now.getTime() / 60_000)}`;
}

export function sweepGroup(
  detector: SweepDetector,
  now: Date,
): { groupKey: string; groupTitle: string } {
  return {
    groupKey: sweepGroupKey(detector, now),
    groupTitle: SWEEP_DETECTORS[detector].groupTitle,
  };
}

export function detectorOfGroupKey(groupKey: string | null): SweepDetector | null {
  const named = groupKey === null ? undefined : GROUP_KEY_SHAPE.exec(groupKey)?.[1];
  return named !== undefined && named in SWEEP_DETECTORS ? (named as SweepDetector) : null;
}

export function explanationOfGroupKey(groupKey: string | null): string | null {
  const detector = detectorOfGroupKey(groupKey);
  return detector === null ? null : SWEEP_DETECTORS[detector].explanation;
}
