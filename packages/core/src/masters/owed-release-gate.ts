// What waits at the release gate on the master's own record (ISS-774, ISS-888, ISS-961): the drafts
// filed for an owed merge, every release hold whose act is the agent's, and every ended release run
// still claiming gate issues, each named with its command.

import type { ReleaseEndedRunHold } from '@forge/contracts/releases';
import { guideCall } from '../guides/index.js';
import type { FilingRecordOwed, ReleaseHoldOwed } from './ports.js';

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** A line names the guide that holds its method by slug, never restates it (REQ-23 BC-2). */
const method = (slug: Parameters<typeof guideCall>[0]) => `\`${guideCall(slug)}\``;

/**
 * ISS-774: a draft filed for an owed merge and marked at it closes only on a shipped release whose
 * commit holds the merge; no cut claims a draft. Named while it waits for one, and with the record to
 * make once one has shipped.
 */
export function recordingsLine(recordings: FilingRecordOwed[]): string {
  const ready = recordings.filter((r) => r.release !== null);
  const waiting = recordings.filter((r) => r.release === null);
  let line = '';
  if (ready.length > 0) {
    const keys = ready.map(
      (r) => `${r.key} ${r.issueId}: !${r.number} at ${r.commit}, ${r.release}`,
    );
    line += ` ${ready.length} draft${plural(ready.length, '', 's')} filed for an owed merge and marked at it ${plural(ready.length, 'waits', 'wait')} on ${plural(ready.length, 'its', 'their')} record on a release that shipped the merge, and a release cut after it landed has shipped (${keys.join('; ')}): record each on that release (\`forge-runner api projects/<projectId>/shipped-in-records -X POST -d '{"issueId":"<id>","version":"<version>","evidence":"<git>"}'\`), which checks the release's commit contains the merge and closes the draft there; where it does not, name the shipped release whose commit does, as ${method('issue-flow')} (Land, mark, move) says.`;
  }
  if (waiting.length > 0) {
    const keys = waiting.map((r) => `${r.key} ${r.issueId}: !${r.number} at ${r.commit}`);
    line += ` ${waiting.length} draft${plural(waiting.length, '', 's')} filed for an owed merge ${plural(waiting.length, 'is', 'are')} marked, awaiting a release that contains the merge (${keys.join('; ')}): no cut claims a draft, so nothing is owed until one ships; this line then names the record to make.`;
  }
  return line;
}

/** The hold whose act is a shipped-in record (`release-batch/shipped-in.ts`). */
const SHIPPED_IN_OWED = 'RELEASE_SHIPPED_IN_OWED';

/**
 * ISS-888: a release hold names an act, and the one it names for the agent is the master's to take,
 * so every such hold is said here with its command; a hold written and never read is the defect.
 * The ended runs still claiming gate issues are said first, each once with its own act (ISS-961).
 */
export function releaseHoldsLine(
  holds: ReleaseHoldOwed[],
  ended: ReleaseEndedRunHold[] = [],
): string {
  if (holds.length === 0) return endedRunHoldsLine(ended);
  const named = (list: ReleaseHoldOwed[]) =>
    list.map((h) => `${h.key} ${h.issueId}: ${h.code}, waiting for ${h.waitingFor}`).join('; ');
  const shippedIn = holds.filter((h) => h.code === SHIPPED_IN_OWED);
  const other = holds.filter((h) => h.code !== SHIPPED_IN_OWED);
  let line = '';
  if (shippedIn.length > 0) {
    line += ` ${shippedIn.length} issue${plural(shippedIn.length, ' waits', 's wait')} at the release gate on the record of the release that shipped ${plural(shippedIn.length, 'it', 'them')}, which you owe (${named(shippedIn)}): read each hold (\`forge-runner api issues/<id>\`, its \`releaseHold\` names the releases and the landing), check with git which shipped release contains the landing, and record it (\`forge-runner api projects/<projectId>/shipped-in-records -X POST -d '{"issueId":"<id>","version":"<the shipped release holding it>","evidence":"<the git command and its answer>"}'\`), which closes the issue into it; send \`"version":null\` where none holds it, and the next release takes it.`;
  }
  if (other.length > 0) {
    line += ` ${other.length} issue${plural(other.length, ' waits', 's wait')} at the release gate on a hold whose act is yours (${named(other)}): read each hold (\`forge-runner api issues/<id>\`, its \`releaseHold.reason\` names the act and its door) and take that act, or move the issue out of \`awaiting_release\` if it is not to ship, saying why.`;
  }
  return endedRunHoldsLine(ended) + line;
}

/**
 * ISS-961: a release run that ended still claiming gate issues keeps them out of every roster, and a
 * cut is refused until no ended run does. The abort it owes is the master's act; a claim the sweep
 * lets go of within a minute is named too, so the master is not left reading a refusal it cannot place.
 */
function endedRunHoldsLine(holds: ReleaseEndedRunHold[]): string {
  if (holds.length === 0) return '';
  const owed = holds.filter((h) => h.act === 'abort');
  const passing = holds.filter((h) => h.act === 'sweep');
  let line = '';
  if (owed.length > 0) {
    line += ` ${owed.length} release run${plural(owed.length, ' that ended still claims', 's that ended still claim')} issues at the release gate and ${plural(owed.length, 'owes its', 'owe their')} abort, which you owe; no cut is taken until then: ${owed.map((h) => h.sentence).join(' ')}`;
  }
  if (passing.length > 0) {
    line += ` ${passing.map((h) => h.sentence).join(' ')}`;
  }
  return line;
}

/** One digest line per held issue, so the master's work moves when a run's act or its issues do. */
export function endedRunHoldsWork(holds: ReleaseEndedRunHold[]): string[] {
  return holds.flatMap((h) =>
    h.issues.map((i) => `ended-run-hold:${h.runId}|${h.act}|${i.issueId}`),
  );
}
