import type { ActorAgency } from '@forge/contracts/permissions';
import type { Tx } from '../../db/client.js';
import { embedFeedbackLater, fileContractChangeIn } from '../../feedback/index.js';
import { dataPolicyOf } from '../../lib/data-egress.js';
import { logger } from '../../observability/logger.js';
import { tellEachSide } from '../channel-signals.js';
import { consumersOf } from '../interface-store.js';
import { ecosystemSignals } from '../ports.js';
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

// cm:guard a breaking approval files its consumers' items inside its own transaction, so no approval
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

export async function announceApproved(tx: Tx, a: Approved, filed: string[]): Promise<void> {
  for (const id of filed) embedFeedbackLater(id);
  if (isBreaking(a.version)) return;
  const ref = `${a.provider.slug}/${a.version.contractSlug}`;
  try {
    const consumers = await consumersOfContract(tx, a.provider.id, a.version.contractSlug);
    await tellEachSide(
      consumers.map((c) => c.id),
      a.filer.agency === 'human' ? a.filer.userId : null,
      (side, recipients) =>
        ecosystemSignals().notify({
          recipients,
          projectId: side,
          type: 'contract_version_published',
          title: `${ref} ${a.version.version} is published`,
          body: `${a.provider.slug} approved ${a.version.version} of ${ref}, measured ${a.version.document.diff.classification}; nothing this project does is owed.`,
          dedupeKey: `contract-published:${a.provider.id}/${a.version.contractSlug}@${a.version.version}:${side}`,
        }),
    );
  } catch (err) {
    logger.error(
      { err, ref, version: a.version.version },
      'contract: the published notice failed after the approval committed',
    );
  }
}
