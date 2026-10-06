import type { ActorAgency } from '@forge/contracts/permissions';
import type { Tx } from '../../db/client.js';
import { fileContractChangeIn } from '../../feedback/index.js';
import { dataPolicyOf } from '../../lib/data-egress.js';
import { emitEvent } from '../../outbox/index.js';
import { consumersOf } from '../interface-store.js';
import type { StoredVersion } from './store.js';

const DAY_MS = 86_400_000;

export interface Approved {
  provider: { id: string; slug: string };
  version: StoredVersion;
  noticeDays: number;
  filer: { userId: string; agency: ActorAgency };
}

async function consumersOfContract(tx: Tx, providerId: string, slug: string) {
  const edges = await consumersOf(tx, providerId);
  const seen = new Map<string, string>();
  for (const e of edges) {
    if (e.contractSlug === slug && e.consumerId !== providerId)
      seen.set(e.consumerId, e.consumerSlug);
  }
  return [...seen].map(([id, consumerSlug]) => ({ id, slug: consumerSlug }));
}

const isBreaking = (v: StoredVersion) => v.document.diff.classification === 'breaking';

// a breaking approval files its consumers' items inside its own transaction, so no approval
// commits owing an item it did not file; the key makes a retry find the item instead of a twin (E3)
export async function fileBreakingIn(tx: Tx, a: Approved): Promise<string[]> {
  if (!isBreaking(a.version)) return [];
  const decidedAt = a.version.decidedAt ?? new Date();
  const dueAt = new Date(decidedAt.getTime() + a.noticeDays * DAY_MS);
  const breaking = a.version.document.diff.changes
    .filter((c) => c.level === 'breaking')
    .map((c) => ({ element: c.element, text: c.text }));
  const filed: string[] = [];
  for (const consumer of await consumersOfContract(tx, a.provider.id, a.version.contractSlug)) {
    const out = await fileContractChangeIn(tx, {
      consumerId: consumer.id,
      level: await dataPolicyOf(consumer.id),
      provider: a.provider,
      contractSlug: a.version.contractSlug,
      version: a.version.version,
      breaking,
      dueAt,
      filer: a.filer,
    });
    if (out.created) filed.push(out.id);
  }
  return filed;
}

// the consumers are read in the approval's transaction, so the notice names the projects that consumed the contract when it was approved
export async function announceApprovedIn(tx: Tx, a: Approved): Promise<void> {
  const consumers = await consumersOfContract(tx, a.provider.id, a.version.contractSlug);
  await emitEvent(tx, 'contract.versionApproved', {
    projectId: a.provider.id,
    providerSlug: a.provider.slug,
    contractSlug: a.version.contractSlug,
    version: a.version.version,
    classification: a.version.document.diff.classification,
    consumerIds: consumers.map((c) => c.id),
    filer: a.filer,
  });
}
