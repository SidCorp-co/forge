/**
 * The provider's live contract (requirement-to-delivery `provider-live`, E1 and E4): for each version
 * a consumer waits on, the version its provider's production serves now, and whether the ecosystem
 * turned the release gate off. A version is live where the commit production answers carries the
 * commit the version was recorded at; a version uploaded with no commit, or a reading that cannot be
 * taken, places none, and none is a refusal, never a guess.
 */

import type {
  ProviderLiveGate,
  ProviderLiveMode,
  ProviderLiveView,
} from '@forge/contracts/contract-waits';
import { db } from '../../db/client.js';
import {
  type ContractWaitRow,
  contractWaitsOfIssues,
  issueDisplayIds,
} from '../../issues/index.js';
import { servedCarries, servedProductionCommit } from '../../release-batch/index.js';
import { heldEcosystem } from '../ecosystem-service.js';
import { heldInterface } from '../interface-service.js';
import { readInterfaces } from '../interface-store.js';
import { activeEcosystemIdsOf } from '../membership-store.js';
import { projectsWhere, readEcosystems } from '../store.js';
import { compareVersions } from './naming.js';
import { versionsOf } from './store.js';

/** Off only where every ecosystem the contract is shared through, with the consumer in it, turned it off. */
export function providerLiveMode(
  modes: readonly (ProviderLiveMode | undefined)[],
): ProviderLiveMode {
  return modes.length > 0 && modes.every((m) => m === 'off') ? 'off' : 'required';
}

async function gateOf(w: ContractWaitRow, published: readonly string[]): Promise<ProviderLiveMode> {
  const active = (await activeEcosystemIdsOf(db, [w.projectId])).map((m) => m.ecosystemId);
  const shared = published.filter((e) => active.includes(e));
  const ecos = await readEcosystems(db, shared);
  return providerLiveMode(ecos.map((e) => heldEcosystem(e).document.releases?.providerLive));
}

async function liveVersionOf(
  providerId: string,
  contractSlug: string,
): Promise<{ live: string | null; unread: string | null }> {
  const served = await servedProductionCommit(providerId);
  if (!served.ok) return { live: null, unread: served.why };
  const approved = (await versionsOf(db, [providerId], contractSlug)).filter(
    (v) => v.approval === 'approved',
  );
  for (const v of approved) {
    const artifact = v.document.artifact;
    if (!artifact || !('sourceCommit' in artifact)) continue;
    const carried = await servedCarries(providerId, artifact.sourceCommit, served.value);
    if (!carried.ok) return { live: null, unread: carried.why };
    if (carried.value) return { live: v.version, unread: null };
  }
  return {
    live: null,
    unread: `production serves ${served.value.slice(0, 12)}, which carries no approved version recorded at a commit`,
  };
}

export async function providerLiveOf(w: ContractWaitRow): Promise<ProviderLiveView> {
  const row = (await readInterfaces(db, [w.providerProjectId])).get(w.providerProjectId);
  const iface = row ? heldInterface(row, w.providerProjectId).document : null;
  const gate = await gateOf(w, iface?.publishes[w.contractSlug]?.ecosystems ?? []);
  const { live, unread } = await liveVersionOf(w.providerProjectId, w.contractSlug);
  return { needed: w.minVersion, live, unread, gate };
}

/** What the gate makes of one wait: served, short of the version, or let through because the gate is off. */
export function gateReading(
  view: Pick<ProviderLiveView, 'gate' | 'live' | 'needed'>,
  versioning: 'dated' | 'semver' | null,
): 'served' | 'short' | 'gate_off' {
  if (view.live && versioning && compareVersions(versioning, view.live, view.needed) >= 0) {
    return 'served';
  }
  return view.gate === 'off' ? 'gate_off' : 'short';
}

/**
 * The roster's issues whose cross-project waits their providers' production does not serve, and
 * those the ecosystem's off switch lets through, which the release records as gate off. An
 * in-project wait ships in the same release as its provider, so the gate does not read it.
 */
export async function contractProviderGate(issueIds: readonly string[]): Promise<ProviderLiveGate> {
  const out: ProviderLiveGate = { shortfalls: [], gateOff: [] };
  const waits = (await contractWaitsOfIssues(issueIds)).filter(
    (w) => !w.retractedAt && w.providerProjectId !== w.projectId,
  );
  if (waits.length === 0) return out;
  const [shown, providers] = await Promise.all([
    issueDisplayIds(waits.map((w) => w.issueId)),
    projectsWhere(db, { ids: [...new Set(waits.map((w) => w.providerProjectId))] }),
  ]);
  const ifaces = await readInterfaces(
    db,
    providers.map((p) => p.id),
  );
  for (const w of waits) {
    const row = ifaces.get(w.providerProjectId);
    const versioning = row
      ? heldInterface(row, w.providerProjectId).document.commitments.versioning
      : null;
    const view = await providerLiveOf(w);
    const reading = gateReading(view, versioning);
    if (reading === 'served') continue;
    const slug = providers.find((p) => p.id === w.providerProjectId)?.slug ?? w.providerProjectId;
    (reading === 'gate_off' ? out.gateOff : out.shortfalls).push({
      issueId: w.issueId,
      issue: shown.get(w.issueId) ?? w.issueId,
      contract: `${slug}/${w.contractSlug}`,
      needed: w.minVersion,
      live: view.live,
      unread: view.unread,
    });
  }
  return out;
}
