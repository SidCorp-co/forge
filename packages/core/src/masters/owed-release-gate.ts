// What waits at the release gate on the master's own record (ISS-774, ISS-888, ISS-961): the drafts
// filed for an owed merge, every release hold whose act is the agent's, and every ended release run
// still claiming gate issues, each named with its command; and what a release waits on the master
// for: the routine act its standing names it for (ISS-1058), its approval request and its merges.

import type { ReleaseEndedRunHold } from '@forge/contracts/releases';
import { guideCall } from '../guides/index.js';
import type {
  FilingRecordOwed,
  ReleaseActOwed,
  ReleaseHoldOwed,
  ReleaseMergeOwed,
} from './ports.js';

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

/**
 * ISS-1058: a release act its standing names the master for — a cut, a split over the roster cap, a
 * landing to record — is routine, so it is yours whether or not a master stood when it fell due.
 */
function releaseActsLine(acts: readonly ReleaseActOwed[]): string {
  if (acts.length === 0) return '';
  const named = acts.map((a) => `${a.version}: ${a.act}`).join('; ');
  return ` ${acts.length} release${plural(acts.length, ' waits', 's wait')} on an act that is yours (${named}): read each release's page (\`forge-runner api projects/<projectId>/releases/<version>\`, its \`waitingOn\` and gates name the act and its door) and take it; a release whose changes cannot be undone names a person instead, and is not on this line. ${method('issue-flow')} (Land, mark, move) is how.`;
}

const releaseName = (r: { runId: string; version: string | null }) =>
  r.version ? `${r.version} (run ${r.runId})` : `run ${r.runId}`;

/** The acts a running release owes the master: its approval request, then its merges in order. */
export function releasesLine(
  acts: readonly ReleaseActOwed[],
  releaseApprovals: readonly { runId: string; version: string | null }[],
  releaseMerges: readonly ReleaseMergeOwed[],
): string {
  let line = releaseActsLine(acts);
  if (releaseApprovals.length > 0) {
    line += ` ${releaseApprovals.length} running release${plural(releaseApprovals.length, ' waits', 's wait')} for an approval request, which this project requires before any production act (${releaseApprovals.map(releaseName).join(', ')}): ask for each with \`forge-runner api projects/<projectId>/release-batches/<runId>/approvals -X POST -d '{"evidence":{"environment":"<where the reading was taken, omitted on a release that merges change requests>","commit":"<the full sha read>","reading":"<what was read there>"}}'\`, and a project admin accepts or returns it.`;
  }
  if (releaseMerges.length > 0) {
    const steps = releaseMerges.map(
      (m) =>
        `${releaseName(m)}: ${m.next.label} next, ${m.merged} of ${m.total} merged, through ${m.next.issueKey} ${m.next.issueId}`,
    );
    line += ` ${releaseMerges.length} accepted release${plural(releaseMerges.length, ' waits', 's wait')} for you to merge its requests in their declared order (${steps.join('; ')}): merge each next one with \`forge-runner api issues/<issueId>/merge-pull-request -X POST -d '{"pullRequest":<number>}'\`, one at a time; the release ends at its last merge, and where its owner deploys nothing is deployed for it. A refusal names its fault: \`RELEASE_MERGE_HEAD_MOVED\` means the request's head moved since the owner accepted it, so abort the release and cut it again on the new head.`;
  }
  return line;
}
