/** The production environment's state (`project-config/environment-state.ts`), read when asked and
 *  never stored: a commit on a row is wrong the moment the next deploy lands (ISS-1286). Neither
 *  this nor `collectReleaseBlockers`, which promises no outbound request, calls the other. */

import type { ServedAt, ServingReading } from '@forge/contracts/releases';
import { longestSpelling } from '../messaging/verdict-identity.js';
import type { EnvironmentState } from '../project-config/index.js';
import { readEnvironmentState, readReleasePath } from '../project-config/index.js';

export type { ServedAt, ServingReading } from '@forge/contracts/releases';
export { servedCommits } from '@forge/contracts/releases';

/** Each served commit beside everywhere it runs — `3c38c68` at A; `ea69715` at B and C — one
 *  commit answered whole by one source and abbreviated by another named once, whole. */
export function servedClause(served: readonly ServedAt[]): string {
  const spelled = longestSpelling(served.map((s) => s.commit));
  const byCommit = new Map<string, string[]>();
  for (const s of served) {
    const commit = spelled(s.commit);
    byCommit.set(commit, [...(byCommit.get(commit) ?? []), s.where]);
  }
  return [...byCommit]
    .map(([commit, where]) => `\`${commit}\` at ${where.join(' and ')}`)
    .join('; ');
}

/** A reading that answered, whole: what is served where, when it was read, and what answered
 *  nothing. The one way every sentence about such a reading says it. */
export function servingClause(serving: Extract<ServingReading, { kind: 'serving' }>): string {
  const unread = serving.unread.length === 0 ? '' : ` (unread: ${serving.unread.join('; ')})`;
  return `${servedClause(serving.served)}, read at ${serving.readAt}${unread}`;
}

export function whyUncorroborated(serving: ServingReading): string {
  if (serving.kind === 'undeclared') {
    return `nothing here can read what this project is serving: ${serving.missing}.`;
  }
  if (serving.kind === 'unreadable') {
    return `nothing could be read from what this project answers through — ${serving.why}`;
  }
  return 'a reading answered, so nothing was uncorroborated.';
}

const NO_ROUTE =
  'declare a runtime probe on the production environment (`verification.runtime`, `"identifies": "source"`), or deploy it through a binding whose platform records the commit it built';

/** A recorded state, read into what it says is served: each probe that answered an identity, and
 *  the record's own commit once the deployment has finished. */
function fromState(
  state: Exclude<EnvironmentState, { state: 'unknown' }>,
  readAt: string,
): ServingReading {
  const served: ServedAt[] = [];
  const unread: string[] = [];
  for (const probe of state.probes ?? []) {
    if (probe.status === 'unreachable') unread.push(probe.error);
    else served.push({ commit: probe.observed, where: probe.url });
  }
  const record = `${state.deployment.provider} deployment ${state.deployment.id} of environment \`${state.environment}\` (${state.deployment.status}, ${state.deployment.at})`;
  if (state.state === 'deployed' && state.source.kind === 'revision') {
    served.push({ commit: state.source.revision, where: record });
  } else if (state.state !== 'deployed') {
    unread.push(`${record} is not a finished deployment, so it names nothing served`);
  } else {
    unread.push(`${record} records no commit`);
  }
  if (served.length === 0) {
    return { kind: 'unreadable', why: unread.join('; '), hosts: [record], readAt };
  }
  return { kind: 'serving', served, unread, readAt };
}

/** The read is the server's: a caller's claim about what is deployed is not admissible here, for
 *  the reason it is not admissible in a release. */
export async function readServingNow(
  projectId: string,
  now: () => Date = () => new Date(),
): Promise<ServingReading> {
  const read = await readReleasePath(projectId);
  if (!read.ok) return { kind: 'undeclared', missing: read.reason, route: NO_ROUTE };
  const { production, document } = read.path;
  if (!production) {
    return {
      kind: 'undeclared',
      missing: 'the project document declares no production environment',
      route: 'declare an environment with `tier: "production"`',
    };
  }
  const state = await readEnvironmentState(projectId, document, production);
  const readAt = now().toISOString();
  if (state.state !== 'unknown') return fromState(state, readAt);
  if (state.reason.cause === 'adapter-error' || state.reason.cause === 'no-record') {
    return { kind: 'unreadable', why: state.reason.message, hosts: [], readAt };
  }
  return { kind: 'undeclared', missing: state.reason.message, route: NO_ROUTE };
}
