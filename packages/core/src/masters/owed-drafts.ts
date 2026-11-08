import { type GuideSlug, guideCall } from '../guides/index.js';
import type { UnhandledRoomMessages, WaitingRequest } from './ports.js';

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const method = (slug: GuideSlug) => `\`${guideCall(slug)}\``;

/** The drafts a feedback triage routed an item to (ISS-840): the master takes each on, or drops it. */
export function carriersLine(carriers: { key: string }[]): string {
  if (carriers.length === 0) return '';
  const keys = carriers.map((c) => c.key);
  return ` ${keys.length} draft issue${plural(keys.length, '', 's')} ${plural(keys.length, 'carries', 'carry')} triaged feedback and ${plural(keys.length, 'waits', 'wait')} to be taken on (${keys.join(', ')}): nothing takes a draft on by itself, so admit each to open (\`forge-runner api issues/<id>/transition -X POST -d '{"toStatus":"open","reason":"<why>"}'\`) and work it, or drop it saying why; ${method('issue-flow')} (Take it) is how.`;
}

/** Member messages a room could not take in the last day, per room and cause (ISS-1046). */
export function unhandledRoomLine(unhandled: readonly UnhandledRoomMessages[] | undefined): string {
  if (!unhandled || unhandled.length === 0) return '';
  const causes = unhandled.map((u) => `${u.count} in room ${u.rid}, ${u.code}`);
  return ` A room of this project could not take member messages in the last day (${causes.join('; ')}): nothing answered them. Read each room's refused message_unhandled actions (\`forge-runner api projects/<projectId>/support/rooms/<roomId>/actions\`), fix or route the cause, and answer the people they came from in their threads.`;
}

/** Draft requirements the intake assistant could not draft (ISS-772): the master drafts each, or drops it. */
export function intakeFailuresLine(failed: readonly { key: string; code: string }[]): string {
  if (failed.length === 0) return '';
  const keys = failed.map((f) => `${f.key} ${f.code}`);
  return ` ${failed.length} draft requirement${plural(failed.length, '', 's')} ${plural(failed.length, 'was', 'were')} not drafted by the intake assistant and will not be tried again (${keys.join(', ')}): read each (\`forge-runner api projects/<projectId>/requirements/<key>\`), then write its draft revision and propose it, or drop it saying why; ${method('requirement-lifecycle')} is how.`;
}

/**
 * The requests a profile with `master_admitted_only` off hands the master (REQ-76 BC-9): it takes
 * each on itself, the person's word being the agreement such a profile asks for.
 */
export function requestsLine(requests: WaitingRequest[]): string {
  if (requests.length === 0) return '';
  const issues = requests.filter((r) => r.kind === 'issue').map((r) => r.key);
  const reqs = requests.filter((r) => r.kind === 'requirement').map((r) => r.key);
  let line = ` This project's gate profile places you for requests a person left waiting (gate master_admitted_only off).`;
  if (issues.length > 0) {
    line += ` ${issues.length} draft issue${plural(issues.length, '', 's')} a person filed ${plural(issues.length, 'waits', 'wait')} to be taken on (${issues.join(', ')}): admit each to open (\`forge-runner api issues/<id>/transition -X POST -d '{"toStatus":"open"}'\`) and work it, or drop it saying why.`;
  }
  if (reqs.length > 0) {
    line += ` ${reqs.length} draft requirement${plural(reqs.length, '', 's')} ${plural(reqs.length, 'has', 'have')} a proposed revision waiting (${reqs.join(', ')}): read each (\`forge-runner api projects/<projectId>/requirements/<key>\`), agree it where it says what to build, and break it down; ${method('requirement-lifecycle')} is how.`;
  }
  return line;
}
