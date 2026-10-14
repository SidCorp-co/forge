/**
 * ISS-1168 — what each sweep detector is, said once.
 *
 * A sweep raises one record per issue it matched, and all of them are told to a reader as one
 * delivery. The sentence that explains the finding and says what to do is the same on every one
 * of them, so it belongs to the detector, not to the record: a record carries what is specific to
 * its issue, and the list route returns this text once beside the delivery.
 *
 * The detector is named by the group key the sweep wrote (`sweep:<detector>:<minute>`), which every
 * delivery already carries, so a delivery written before this registry existed is explained too and
 * no stored row had to change.
 */

export const SWEEP_DETECTORS = {
  'owed-close': {
    groupTitle: 'Issues whose code shipped and whose close was never written',
    explanation:
      'The step that owed the close did not write it. Read the branch, then close the issue — or, if it never landed, clear the mark with `unmark` and move the issue to `dropped`.',
  },
  stranded: {
    groupTitle: 'Issues are parked with nothing coming for them',
    explanation:
      'Nothing will move a parked issue forward until you decide. Open it and read the last comment: a step that could not finish its checks leaves the decision there.',
  },
  'idle-issues': {
    groupTitle: 'Issues in a live status with no live work behind them',
    explanation:
      'Nothing was moved: the finding is on each issue itself, under `strand`, and says who owes the next move.',
  },
  'orphan-assertion': {
    groupTitle: 'Issues asserting work in progress with no run behind them',
    explanation:
      'Nothing has been moved: whether the issue or the run record is the wrong half is not decidable from here.',
  },
} as const;

export type SweepDetector = keyof typeof SWEEP_DETECTORS;

const GROUP_KEY_SHAPE = /^sweep:([a-z-]+):\d+$/;

/**
 * The grouping key of one evaluation of one detector (Alertmanager's `group_by`).
 *
 * Every record a sweep tick raises shares it, so a reader is told once about the sweep rather than
 * once per issue it named. The tick is truncated to the evaluation interval so the passes inside one
 * `runPipelineSweep` agree on it without passing a value between them.
 */
export function sweepGroupKey(detector: SweepDetector, now: Date): string {
  return `sweep:${detector}:${Math.floor(now.getTime() / 60_000)}`;
}

/** The group key and the title a delivery of this detector's findings is founded with. */
export function sweepGroup(
  detector: SweepDetector,
  now: Date,
): { groupKey: string; groupTitle: string } {
  return {
    groupKey: sweepGroupKey(detector, now),
    groupTitle: SWEEP_DETECTORS[detector].groupTitle,
  };
}

/** The detector a group key names, or null for a key no sweep wrote. */
export function detectorOfGroupKey(groupKey: string | null): SweepDetector | null {
  const named = groupKey === null ? undefined : GROUP_KEY_SHAPE.exec(groupKey)?.[1];
  return named !== undefined && named in SWEEP_DETECTORS ? (named as SweepDetector) : null;
}

/** The shared explanation of the sweep that wrote this group key, or null where it names none. */
export function explanationOfGroupKey(groupKey: string | null): string | null {
  const detector = detectorOfGroupKey(groupKey);
  return detector === null ? null : SWEEP_DETECTORS[detector].explanation;
}
