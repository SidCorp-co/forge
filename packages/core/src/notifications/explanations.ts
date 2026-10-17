/**
 * ISS-1168 — what each sweep detector is, said once. A record carries what is specific to its
 * issue and the list route returns the explanation beside the delivery, named by the group key
 * the sweep wrote, so deliveries written before this existed are explained too.
 */

export const SWEEP_DETECTORS = {
  'owed-close': {
    groupTitle: 'Issues whose code shipped and whose close was never written',
    explanation:
      'The step that owed the close did not write it. Read the branch, then close the issue — or, if it never landed, clear the mark with `unmark` and move the issue to Dropped.',
  },
  stranded: {
    groupTitle: 'Issues waiting for you',
    explanation:
      'Each one waits for a decision or for something only a person can supply. Open it: its last comment says what is asked.',
  },
  'idle-issues': {
    groupTitle: 'Issues in a live status with no live work behind them',
    explanation: 'Nothing was moved. Each issue says what it waits for and who owes the next move.',
  },
  'orphan-assertion': {
    groupTitle: 'Issues asserting work in progress with no run behind them',
    explanation:
      'Nothing has been moved: whether the issue or the run record is the wrong half is not decidable from here.',
  },
} as const;

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
