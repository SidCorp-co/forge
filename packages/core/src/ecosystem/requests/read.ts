import type {
  ContractRequestDirection,
  ContractRequestView,
  ContractWaitAgency,
} from '@forge/contracts/contract-waits';
import { requirementKey } from '@forge/contracts/requirements';
import { desc, eq, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../db/client.js';
import { projects } from '../../db/schema.js';
import { contractRequests } from '../../db/schema-contract-waits.js';
import { channelDocuments } from '../../db/schema-ecosystem.js';
import { requirements } from '../../db/schema-requirements.js';

const consumer = alias(projects, 'consumer');
const provider = alias(projects, 'provider');

export async function listContractRequests(projectId: string): Promise<ContractRequestView[]> {
  const rows = await db
    .select({
      request: contractRequests,
      number: channelDocuments.number,
      consumerSlug: consumer.slug,
      providerSlug: provider.slug,
      reqSeq: requirements.reqSeq,
      reqTitle: requirements.title,
      reqStatus: requirements.status,
    })
    .from(contractRequests)
    .innerJoin(channelDocuments, eq(channelDocuments.id, contractRequests.channelDocumentId))
    .innerJoin(consumer, eq(consumer.id, contractRequests.projectId))
    .innerJoin(provider, eq(provider.id, contractRequests.providerProjectId))
    .innerJoin(requirements, eq(requirements.id, contractRequests.requirementId))
    .where(
      or(
        eq(contractRequests.projectId, projectId),
        eq(contractRequests.providerProjectId, projectId),
      ),
    )
    .orderBy(desc(contractRequests.createdAt));
  return rows.map((r) => {
    const q = r.request;
    const direction: ContractRequestDirection = q.projectId === projectId ? 'outgoing' : 'incoming';
    return {
      id: q.id,
      number: r.number ?? q.channelDocumentId,
      direction,
      contract: `${r.providerSlug}/${q.contractSlug}`,
      consumer: { id: q.projectId, slug: r.consumerSlug },
      provider: { id: q.providerProjectId, slug: r.providerSlug },
      requirement: { key: requirementKey(r.reqSeq), title: r.reqTitle, status: r.reqStatus },
      requestedBy: q.requestedBy,
      requestedAgency: q.requestedAgency as ContractWaitAgency,
      createdAt: q.createdAt.toISOString(),
    };
  });
}
