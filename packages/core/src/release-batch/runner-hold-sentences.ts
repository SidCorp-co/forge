/**
 * What an operator is told about each box a release cannot use: the state it was read in, how
 * long, and the act that clears it. `blocker-sentences.ts` re-exports `runnerHoldClause`.
 */

import { AGENT_NAMING_MIN_RUNNER } from '../runners/device-cap.js';
import type { RunnerHold, RunnerHoldReason } from '../runners/ineligible.js';

export const RUNNERS_TAB = 'Settings → Runners';

function durationPhrase(seconds: number | undefined): string {
  if (seconds === undefined) return 'longer than a provision takes';
  const [n, unit] =
    seconds < 3600
      ? [Math.max(1, Math.round(seconds / 60)), 'minute']
      : seconds < 172800
        ? [Math.round(seconds / 3600), 'hour']
        : [Math.round(seconds / 86400), 'day'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * What clears this reading, per reading. Every one of them answers: a reading with no
 * act is correct about the state and silent about what to do with it. Where nobody can
 * act — a rate limit, a quarantine, a provision in flight — the clause says what is
 * being waited out and until when, which is an answer too (ISS-1127).
 */
const RUNNER_HOLD_ACT: Record<RunnerHoldReason, (hold: RunnerHold) => string> = {
  'device-disabled': () =>
    `sits on a device an operator has turned off. Re-enable that device under ${RUNNERS_TAB} before this box can take anything.`,
  retired: (h) =>
    `is \`${h.detail ?? 'draining'}\` and so takes nothing from the pool. Switch "Takes jobs from the pool" back on for it under ${RUNNERS_TAB}.`,
  'never-connected': () =>
    'is registered and has never reported in. Start `forge-runner` on that box.',
  disconnected: () =>
    'reported itself offline. Start `forge-runner` on that box, or wait for it to reconnect.',
  stale: () => 'has stopped reporting. Check `forge-runner` is still running on that box.',
  auth: () =>
    `had its agent credential rejected, so it is taking nothing. Re-authenticate the agent on that box; ${RUNNERS_TAB} shows the detail it reported.`,
  'rate-limited': (h) =>
    `is rate limited until ${h.detail ?? 'it clears'}. Nothing here clears it sooner — wait it out, or bring another box up.`,
  quarantined: (h) =>
    `is quarantined until ${h.detail ?? 'it clears'} after repeated failures. Wait it out, or clear the quarantine under ${RUNNERS_TAB}.`,
  provisioning: (h) =>
    `has not finished provisioning its workspace (\`${h.detail ?? 'in progress'}\`). Watch it under ${RUNNERS_TAB}; a provision that is stuck is re-run from there.`,
  'provision-stalled': (h) =>
    `has stood at \`${h.detail ?? 'provisioning'}\` for ${durationPhrase(h.stalledSeconds)} with no report from the box, so that provision did not finish and is not in progress. The box re-runs it on its next sweep once it is polling again; to re-run it now, use Re-provision under ${RUNNERS_TAB}.`,
  'below-floor': (h) =>
    `runs agent version ${h.detail ?? 'unreported'}, below the ${AGENT_NAMING_MIN_RUNNER} a claim needs. Upgrade \`forge-runner\` on that box.`,
};

/** Readings whose own words already say when the box last reported. */
const HOLD_STATES_ITS_OWN_AGE: ReadonlySet<RunnerHoldReason> = new Set([
  'never-connected',
  'disconnected',
  'stale',
]);

function lastSeenPhrase(hold: RunnerHold): string {
  if (hold.lastSeenSeconds === null) return ' It has never reported.';
  const ago = `${hold.lastSeenSeconds}s ago`;
  return hold.reporting
    ? ` It is up and reporting, last seen ${ago}.`
    : ` It last reported ${ago}.`;
}

export function runnerHoldClause(hold: RunnerHold): string {
  const act = RUNNER_HOLD_ACT[hold.reason](hold);
  const age = HOLD_STATES_ITS_OWN_AGE.has(hold.reason)
    ? hold.lastSeenSeconds === null
      ? ''
      : ` Last seen ${hold.lastSeenSeconds}s ago.`
    : lastSeenPhrase(hold);
  return `\`${hold.deviceName}\` ${act}${age}`;
}
