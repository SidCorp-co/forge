// The lead of a release blocker raised by the declared validation gate (ISS-809, REQ-71 BC-9): what
// the check read at the commit about to reach an environment. The remedy follows it, from
// `blocker-sentences.ts`.

import type { ReleaseBlockerCode } from '@forge/contracts/releases';
import { atUtcMinute } from './utc-minute.js';

/** What the declared gate check read at the commit, and the minute its wait began — never a running age. */
export function gateCheckLead(
  code: ReleaseBlockerCode,
  d: Record<string, unknown> | undefined,
): string {
  const check = typeof d?.check === 'string' ? d.check : '?';
  const commit = typeof d?.commit === 'string' ? d.commit.slice(0, 12) : 'the commit';
  const since = typeof d?.since === 'string' ? atUtcMinute(d.since) : null;
  const window = typeof d?.windowMinutes === 'number' ? d.windowMinutes : null;
  const declared = `The \`${check}\` check, which \`validation.gate\` declares as the gate this project's changes pass,`;
  if (code === 'RELEASE_GATE_CHECK_RED') {
    const how = typeof d?.conclusion === 'string' ? ` (${d.conclusion})` : '';
    return `${declared} is red${how} on commit ${commit}, which is about to reach an environment.`;
  }
  if (code === 'RELEASE_GATE_CHECK_UNREAD') {
    const where = typeof d?.where === 'string' ? d.where : 'the commit';
    const why = typeof d?.reason === 'string' ? `: ${d.reason}` : '';
    return `${declared} could not be read at ${where}${why}.`;
  }
  if (code === 'RELEASE_GATE_CHECK_SILENT') {
    const waited =
      since === null || window === null
        ? 'the host gave no commit time, so the wait cannot be measured'
        : `none reported in the ${window} minutes allowed after the commit was made at ${since}`;
    return `${declared} has not reported on commit ${commit}: ${waited}.`;
  }
  if (d?.status === 'unreported') {
    const wait =
      since === null ? '' : ` (made at ${since}, waited for up to ${window ?? '?'} minutes)`;
    return `${declared} has not reported on commit ${commit} yet${wait}.`;
  }
  const state = d?.status === 'queued' ? 'queued' : 'still running';
  return `${declared} is ${state} on commit ${commit}${since === null ? '' : `, started at ${since}`}.`;
}
