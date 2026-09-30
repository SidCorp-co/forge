/** What a project is serving, read when asked and never stored — a commit on a row is wrong the
 *  moment the next deploy lands (ISS-1286). Declared probes answer first; where none is declared,
 *  what Forge itself deployed through the project's bindings does (ISS-1346). This shares
 *  `readLiveState` with `serving.ts` and neither calls the other, nor is either called from
 *  `collectReleaseBlockers`, which promises no outbound request. */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { longestSpelling } from '../messaging/verdict-identity.js';
import { liveProbeFrom, resolveReleaseChannels } from './channel.js';
import { readForgeDeployments } from './deployed-reading.js';
import type { ReleaseChannel } from './plan.js';
import { invalidProbeUrls, readLiveState, type VerifyConfig, type VerifyProbe } from './verify.js';

export interface ServedAt {
  readonly commit: string;
  readonly where: string;
}

/** One reading. `served` pairs each commit a probe or a Forge deployment answered with where it
 *  runs — a probe's url, a target's deployment — `unread` is a line per source answering none, and
 *  only a project with nothing to ask is an absence: `missing` says why, `route` what opens one. */
export type ServingReading =
  | {
      readonly kind: 'serving';
      readonly served: readonly ServedAt[];
      readonly unread: readonly string[];
      readonly readAt: string;
    }
  | { readonly kind: 'undeclared'; readonly missing: string; readonly route: string }
  | {
      readonly kind: 'unreadable';
      readonly why: string;
      readonly hosts: readonly string[];
      readonly readAt: string;
    };

export function servedCommits(serving: ServingReading): string[] {
  if (serving.kind !== 'serving') return [];
  return [...new Set(serving.served.map((s) => s.commit))];
}

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

/** The probes the live channels declare, and how many declared a block `parseVerifyConfig` refused
 *  — which decides anything only where `cfg` is null. */
export interface DeclaredProbes {
  readonly cfg: VerifyConfig | null;
  readonly refused: number;
}

function probeKey(probe: VerifyProbe): string {
  return `${probe.url}\u0000${probe.commitPath ?? ''}`;
}

export function declaredProbesOf(channels: readonly ReleaseChannel[]): DeclaredProbes {
  const probes: VerifyProbe[] = [];
  const seen = new Set<string>();
  let refused = 0;
  for (const channel of channels) {
    if (channel.verifySource === 'declared-unusable') refused += 1;
    for (const probe of channel.verify?.probes ?? []) {
      if (seen.has(probeKey(probe))) continue;
      seen.add(probeKey(probe));
      probes.push(probe);
    }
  }
  return { cfg: probes.length === 0 ? null : { probes }, refused };
}

/** `resolveReleaseChannels` reads no project row with no live binding, so a commit url declared
 *  there with no binding is not undeclared. */
async function liveEnvironmentProbe(projectId: string): Promise<VerifyConfig | null> {
  const [row] = await db
    .select({ environments: projects.environments })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return liveProbeFrom(row?.environments);
}

const REFUSED_DECLARATION =
  'every declared verification probe was refused as a declaration: a `verify` block is there and ' +
  'nothing in it names a url to ask. Correct the declaration on the live deploy binding.';

function invalidUrlLines(invalid: readonly string[]): string[] {
  const why = 'is not a url, so no request could be made to it — correct it, scheme included';
  return invalid.map((url) => `${url} ${why}`);
}

export function whyUncorroborated(serving: ServingReading): string {
  if (serving.kind === 'undeclared') {
    return `nothing here can read what this project is serving: ${serving.missing}, and no live binding declares \`verify.probes\`.`;
  }
  if (serving.kind === 'unreadable') {
    return `nothing could be read from what this project answers through — ${serving.why}`;
  }
  return 'a reading answered, so nothing was uncorroborated.';
}

/** Where no probe is declared, the latest deployment Forge saw finish through each bound target. */
async function fromDeployments(projectId: string, now: () => Date): Promise<ServingReading> {
  const deployed = await readForgeDeployments(projectId);
  if (deployed.kind === 'unrouted') {
    return { kind: 'undeclared', missing: deployed.missing, route: deployed.route };
  }
  const readAt = now().toISOString();
  if (deployed.kind === 'unanswered') {
    return {
      kind: 'unreadable',
      why: deployed.unread.join('; '),
      hosts: deployed.readFrom,
      readAt,
    };
  }
  return { kind: 'serving', served: deployed.served, unread: deployed.unread, readAt };
}

/** What this project is serving, now. The read is the server's: a caller's claim about what is
 *  deployed is not admissible here, for the reason it is not admissible in a release. */
export async function readServingNow(
  projectId: string,
  now: () => Date = () => new Date(),
): Promise<ServingReading> {
  const channels = await resolveReleaseChannels(projectId);
  const declared =
    channels.length > 0
      ? declaredProbesOf(channels)
      : { cfg: await liveEnvironmentProbe(projectId), refused: 0 };

  if (declared.cfg === null) {
    if (declared.refused === 0) return fromDeployments(projectId, now);
    return { kind: 'unreadable', why: REFUSED_DECLARATION, hosts: [], readAt: now().toISOString() };
  }

  const hosts = declared.cfg.probes.map((probe) => probe.url);
  // A probe nobody can ask does not silence one somebody can: the defect travels in `unread`.
  const defects = invalidUrlLines(invalidProbeUrls(declared.cfg));
  const usable = declared.cfg.probes.filter((probe) => URL.canParse(probe.url));
  if (usable.length === 0) {
    return { kind: 'unreadable', why: defects.join('; '), hosts, readAt: now().toISOString() };
  }

  const state = await readLiveState({ ...declared.cfg, probes: usable });
  const readAt = now().toISOString();
  const unread = [...defects, ...state.unhealthy, ...state.unidentified];
  if (state.answeredBy.length === 0) {
    return { kind: 'unreadable', why: [...defects, ...state.readings].join('; '), hosts, readAt };
  }
  const served = state.answeredBy.map((a) => ({ commit: a.commit, where: a.url }));
  return { kind: 'serving', served, unread, readAt };
}
