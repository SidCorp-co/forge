import type { ActorAgency } from '@forge/contracts/permissions';
import type { Tx } from '../../db/client.js';
import { fileContractChangeIn } from '../../feedback/index.js';
import { dataPolicyOf } from '../../lib/data-egress.js';
import { emitEvent } from '../../outbox/index.js';
import { consumersOf } from '../interface-store.js';
import { impactLink } from '../link-service.js';
import { linksWhere } from '../link-store.js';
import { upgradeOwed, upgradeWords } from './impact.js';
import type { Versioning } from './naming.js';
import type { StoredVersion } from './store.js';

const DAY_MS = 86_400_000;

export interface Approved {
  provider: { id: string; slug: string };
  version: StoredVersion;
  /** How the provider numbers its versions, which says whether a link is pinned at or past this one. */
  versioning: Versioning;
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

/** The consumer's links to the approved contract, as the impact check reads them. */
async function linksOfConsumer(tx: Tx, consumerId: string, a: Approved) {
  const rows = await linksWhere(tx, { consumerId });
  return rows
    .filter(
      (l) => l.providerProjectId === a.provider.id && l.contractSlug === a.version.contractSlug,
    )
    .map(impactLink);
}

// a breaking approval files its consumers' items inside its own transaction, so no approval
// commits owing an item it did not file; the key makes a retry find the item instead of a twin (E3).
// Each consumer is weighed first against what its links record (ISS-1135): one no breaking entry
// reaches is filed nothing
export async function fileBreakingIn(tx: Tx, a: Approved): Promise<string[]> {
  if (!isBreaking(a.version)) return [];
  const decidedAt = a.version.decidedAt ?? new Date();
  const dueAt = new Date(decidedAt.getTime() + a.noticeDays * DAY_MS);
  const breaking = a.version.document.diff.changes
    .filter((c) => c.level === 'breaking')
    .map((c) => ({ element: c.element, text: c.text }));
  const filed: string[] = [];
  for (const consumer of await consumersOfContract(tx, a.provider.id, a.version.contractSlug)) {
    const owed = upgradeOwed(
      a.versioning,
      a.version.version,
      a.version.document.diff,
      await linksOfConsumer(tx, consumer.id, a),
    );
    if (!owed.owed) continue;
    const out = await fileContractChangeIn(tx, {
      consumerId: consumer.id,
      level: await dataPolicyOf(consumer.id),
      provider: a.provider,
      contractSlug: a.version.contractSlug,
      version: a.version.version,
      weighed: upgradeWords(owed, breaking),
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

// a decision no `contract.versionApproved` reports settles its approver's Needs you row, which the
// workspace's Activity hears (ISS-1053); an announced approval is told by that event alone (ISS-1181)
export async function announceDecidedIn(
  tx: Tx,
  d: { projectId: string; contract: string; version: string },
): Promise<void> {
  await emitEvent(tx, 'decision.settled', {
    projectId: d.projectId,
    act: 'contract.decide',
    subject: `${d.contract}@${d.version}`,
  });
}
