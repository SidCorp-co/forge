import type { SensitiveDataLevel } from '@forge/contracts/data-policy';
import { FEEDBACK_LIMITS } from '@forge/contracts/feedback';
import type { ActorAgency } from '@forge/contracts/permissions';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { storedText } from '../lib/data-egress.js';
import { insertFeedbackIn, lockFeedback } from './service.js';

interface ContractChangeFiling {
  consumerId: string;
  level: SensitiveDataLevel;
  provider: { id: string; slug: string };
  contractSlug: string;
  version: string;
  breaking: readonly { element: string; text: string }[];
  dueAt: Date;
  filer: { userId: string; agency: ActorAgency };
}

const contractChangeKey = (providerId: string, slug: string, version: string) =>
  `contract-change:${providerId}/${slug}@${version}`;

function bodyOf(f: ContractChangeFiling): string {
  const ref = `${f.provider.slug}/${f.contractSlug}`;
  const lines = f.breaking.map((c) => `- ${c.element}: ${c.text}`);
  const head = `${ref} ${f.version} is approved and breaking. Adapt before ${f.dueAt.toISOString().slice(0, 10)}, the end of ${f.provider.slug}'s commitment window.`;
  return [head, ...(lines.length ? ['', ...lines] : [])].join('\n').slice(0, FEEDBACK_LIMITS.body);
}

export async function fileContractChangeIn(
  tx: Tx,
  f: ContractChangeFiling,
): Promise<{ id: string; created: boolean }> {
  const dedupKey = contractChangeKey(f.provider.id, f.contractSlug, f.version);
  await lockFeedback(tx, f.consumerId);
  const [twin] = await tx
    .select({ id: feedback.id })
    .from(feedback)
    .where(and(eq(feedback.projectId, f.consumerId), eq(feedback.dedupKey, dedupKey)));
  if (twin) return { id: twin.id, created: false };
  const title = storedText(
    f.level,
    `${f.provider.slug}/${f.contractSlug} ${f.version} is breaking`.slice(0, FEEDBACK_LIMITS.title),
  );
  const body = storedText(f.level, bodyOf(f));
  const id = await insertFeedbackIn(tx, {
    projectId: f.consumerId,
    kind: 'contract_change',
    severity: 'high',
    title: title.text,
    body: body.text,
    contractProviderProjectId: f.provider.id,
    contractSlug: f.contractSlug,
    contractVersion: f.version,
    dueAt: f.dueAt,
    reportedBy: f.filer.userId,
    reporterAgency: f.filer.agency,
    scrubbed: title.scrubbed,
    redactions: title.redactions + body.redactions,
    dedupKey,
  });
  return { id, created: true };
}
