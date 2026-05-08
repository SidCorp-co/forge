export type JobFailureKind = 'runner-skipped' | 'watchdog-stalled' | 'agent-errored';

export interface ClassifiedFailure {
  kind: JobFailureKind;
  label: string;
  tooltip: string;
}

const RUNNER_SKIPPED_PATTERNS = [/^unsupported job type/i, /^no runner available/i];
const WATCHDOG_PATTERNS = [
  /^stuck dispatched/i,
  /^queued > .* without dispatch/i,
  /queued-watchdog/i,
];

const RUNNER_SKIPPED_TOOLTIP =
  "This job type isn't supported on the assigned runner. The pipeline tried, the runner declined, no work was lost.";
const WATCHDOG_TOOLTIP =
  'Job timed out before the runner started it. Usually a transient runner restart; the next retry usually succeeds.';
const AGENT_FALLBACK_TOOLTIP = 'Agent reported an error. See job event log for details.';

export function classifyJobFailure(
  error: string | null | undefined,
  failureKind: 'transient' | 'permanent' | 'unknown' | null | undefined,
): ClassifiedFailure {
  if (error) {
    if (RUNNER_SKIPPED_PATTERNS.some((p) => p.test(error))) {
      return {
        kind: 'runner-skipped',
        label: 'Runner skipped',
        tooltip: RUNNER_SKIPPED_TOOLTIP,
      };
    }
    if (WATCHDOG_PATTERNS.some((p) => p.test(error))) {
      return {
        kind: 'watchdog-stalled',
        label: 'Watchdog stalled',
        tooltip: WATCHDOG_TOOLTIP,
      };
    }
    return {
      kind: 'agent-errored',
      label: 'Agent errored',
      tooltip: error,
    };
  }
  if (failureKind === 'transient') {
    return {
      kind: 'watchdog-stalled',
      label: 'Watchdog stalled',
      tooltip: WATCHDOG_TOOLTIP,
    };
  }
  return {
    kind: 'agent-errored',
    label: 'Agent errored',
    tooltip: AGENT_FALLBACK_TOOLTIP,
  };
}
