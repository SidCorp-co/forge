/** What a project's declared probes answer about the commit it is serving, read when asked and
 *  never stored — a commit on a row is wrong the moment the next deploy lands (ISS-1286).
 *  `serving.ts:readServingDeployment` reads the same probes for its own route; it cannot be called
 *  here, going through `collectReleaseBlockers`, which `criteria-hold.ts` is a part of. */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { liveProbeFrom, resolveReleaseChannels } from './channel.js';
import type { ReleaseChannel } from './plan.js';
import { invalidProbeUrls, readLiveState, type VerifyConfig, type VerifyProbe } from './verify.js';

/** One reading. `undeclared` and `unreadable` are an absence, which is not a failure; a
 *  `disagreeing` fleet answered, so its answers decide. */
export type ServingReading =
  | { readonly kind: 'serving'; readonly commit: string; readonly hosts: readonly string[]; readonly readAt: string }
  | {
      readonly kind: 'disagreeing';
      readonly commits: readonly string[];
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

/** The probes the live channels declare, and how many declared a block `parseVerifyConfig`
 *  refused — which decides anything only where `cfg` is null. */
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

/** The probe a project's own live environment declares. `resolveReleaseChannels` reads no project
 *  row with no live binding, so without this one declaring a live commit url and no binding would
 *  read as one that declared no way to ask. */
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

function invalidUrlWhy(invalid: readonly string[]): string {
  return (
    `a declared probe url is not a url (${invalid.join(', ')}), so no request could be made to it ` +
    '— a declaration defect rather than a host that is down. Correct the probe, including its scheme.'
  );
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
  const invalid = invalidProbeUrls(declared.cfg);
  if (invalid.length > 0) {
    return { kind: 'unreadable', why: invalidUrlWhy(invalid), hosts, readAt: now().toISOString() };
  }

  const state = await readLiveState(declared.cfg);
  const readAt = now().toISOString();
  if (state.identity !== null) {
    return { kind: 'serving', commit: state.identity, hosts, readAt };
  }
  if (state.disagreement !== null) {
    return { kind: 'disagreeing', commits: state.disagreement, hosts, readAt };
  }
  return { kind: 'unreadable', why: state.readings.join('; '), hosts, readAt };
}
