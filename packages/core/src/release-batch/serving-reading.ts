/** What a project's declared probes answer about the commit it is serving, read when asked and
 *  never stored — a commit on a row is wrong the moment the next deploy lands (ISS-1286). This
 *  shares `readLiveState` with `serving.ts` and neither calls the other, nor is either called from
 *  `collectReleaseBlockers`, which promises no outbound request. */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { liveProbeFrom, resolveReleaseChannels } from './channel.js';
import type { ReleaseChannel } from './plan.js';
import { invalidProbeUrls, readLiveState, type VerifyConfig, type VerifyProbe } from './verify.js';

/** One reading. `commits` is every distinct commit a probe answered (one settled fleet, more a
 *  rollout), `unread` a line per probe answering none, and only no answer at all is an absence. */
export type ServingReading =
  | {
      readonly kind: 'serving';
      readonly commits: readonly string[];
      readonly unread: readonly string[];
      readonly hosts: readonly string[];
      readonly readAt: string;
    }
  | { readonly kind: 'undeclared' }
  | {
      readonly kind: 'unreadable';
      readonly why: string;
      readonly hosts: readonly string[];
      readonly readAt: string;
    };

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
    return 'this project declares no way to ask a host what it is serving.';
  }
  if (serving.kind === 'unreadable') {
    return `nothing could be read from the probes it declares — ${serving.why}`;
  }
  return 'a reading answered, so nothing was uncorroborated.';
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
    if (declared.refused === 0) return { kind: 'undeclared' };
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
  if (state.answeredCommits.length === 0) {
    return { kind: 'unreadable', why: [...defects, ...state.readings].join('; '), hosts, readAt };
  }
  return { kind: 'serving', commits: state.answeredCommits, unread, hosts, readAt };
}
