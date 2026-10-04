import type {
  ContractWaitAgency,
  ContractWaitView,
  IssueContractWaits,
} from '@forge/contracts/contract-waits';
import { CONTRACT_WAIT_UNSETTLED } from '@forge/contracts/contract-waits';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import { issues, projects } from '../../db/schema.js';
import { contractRequests, issueContractWaits } from '../../db/schema-contract-waits.js';
import { channelDocuments, contractVersions } from '../../db/schema-ecosystem.js';
import { requirements } from '../../db/schema-requirements.js';
import type { ActorAgency } from '../../issues/actor-agency.js';
import { activeIssuePrefix } from '../../issues/issue-prefix-read.js';
import { formatIssueRef } from '../../lib/issue-ref.js';
import { requirementKey } from '../../requirements/read.js';
import { splitContractRef } from '../interface-rules.js';
import { loadInterface } from '../interface-service.js';
import { activeEcosystemIdsOf, projectsWhere } from '../store.js';
import { holdsDispatch, type RequestFacts, unsettledDetail, type WaitTarget } from './rules.js';

export interface WaitActor {
  userId: string;
  agency: ActorAgency;
}

export type WaitRow = typeof issueContractWaits.$inferSelect;

const currentSql = sql<string | null>`(
  SELECT v.version FROM ${contractVersions} v
  WHERE v.provider_project_id = ${issueContractWaits.providerProjectId}
    AND v.contract_slug = ${issueContractWaits.contractSlug}
    AND v.approval = 'approved'
  ORDER BY v.recorded_at DESC LIMIT 1)`;

async function viewRows(tx: Tx, where: ReturnType<typeof and>) {
  return tx
    .select({
      wait: issueContractWaits,
      providerSlug: projects.slug,
      issSeq: issues.issSeq,
      current: currentSql,
      requestNumber: channelDocuments.number,
      reqSeq: requirements.reqSeq,
      reqStatus: requirements.status,
    })
    .from(issueContractWaits)
    .innerJoin(projects, eq(projects.id, issueContractWaits.providerProjectId))
    .innerJoin(issues, eq(issues.id, issueContractWaits.issueId))
    .leftJoin(contractRequests, eq(contractRequests.id, issueContractWaits.contractRequestId))
    .leftJoin(channelDocuments, eq(channelDocuments.id, contractRequests.channelDocumentId))
    .leftJoin(requirements, eq(requirements.id, contractRequests.requirementId))
    .where(where)
    .orderBy(asc(issueContractWaits.createdAt));
}

type ViewRow = Awaited<ReturnType<typeof viewRows>>[number];

function viewOf(r: ViewRow, prefix: string | null): ContractWaitView {
  const w = r.wait;
  return {
    id: w.id,
    issue: formatIssueRef(prefix, r.issSeq),
    contract: `${r.providerSlug}/${w.contractSlug}`,
    provider: { id: w.providerProjectId, slug: r.providerSlug },
    minVersion: w.minVersion,
    reason: w.reason,
    settled: w.settledAt !== null,
    settledBy: w.settledVersion,
    settledAt: w.settledAt?.toISOString() ?? null,
    current: r.current,
    request:
      r.requestNumber && r.reqSeq !== null && r.reqStatus
        ? {
            number: r.requestNumber,
            requirement: requirementKey(r.reqSeq),
            requirementStatus: r.reqStatus,
          }
        : null,
    createdBy: w.createdBy,
    createdAgency: w.createdAgency as ContractWaitAgency,
    createdAt: w.createdAt.toISOString(),
    retractedAt: w.retractedAt?.toISOString() ?? null,
    retractReason: w.retractReason,
  };
}

export async function waitView(tx: Tx, projectId: string, id: string): Promise<ContractWaitView> {
  const [row] = await viewRows(tx, and(eq(issueContractWaits.id, id)));
  if (!row) throw new Error(`contract waits: wait ${id} vanished after its write`);
  return viewOf(row, await activeIssuePrefix(projectId));
}

export async function issueContractWaitsOf(
  issueId: string,
  projectId: string,
  opts: { includeRetracted?: boolean } = {},
): Promise<IssueContractWaits> {
  const rows = await viewRows(
    db,
    and(
      eq(issueContractWaits.issueId, issueId),
      opts.includeRetracted ? undefined : isNull(issueContractWaits.retractedAt),
    ),
  );
  const prefix = await activeIssuePrefix(projectId);
  const views = rows.map((r) => viewOf(r, prefix));
  const holding = rows.filter((r) => holdsDispatch(r.wait)).map((r) => viewOf(r, prefix));
  return {
    waits: views,
    dispatchable: holding.length === 0,
    refusal:
      holding.length === 0
        ? null
        : { code: CONTRACT_WAIT_UNSETTLED, detail: holding.map(unsettledDetail).join(' ') },
  };
}

export async function waitsOnContractsOf(
  issueId: string,
  projectId: string,
): Promise<IssueContractWaits | null> {
  const read = await issueContractWaitsOf(issueId, projectId);
  return read.waits.length === 0 ? null : read;
}

export async function waitRowIn(tx: Tx, issueId: string, id: string): Promise<WaitRow | null> {
  const [row] = await tx
    .select()
    .from(issueContractWaits)
    .where(and(eq(issueContractWaits.id, id), eq(issueContractWaits.issueId, issueId)))
    .for('update');
  return row ?? null;
}

export async function liveWaitOn(
  tx: Tx,
  issueId: string,
  providerId: string,
  contractSlug: string,
): Promise<{ id: string; minVersion: string } | null> {
  const [row] = await tx
    .select({ id: issueContractWaits.id, minVersion: issueContractWaits.minVersion })
    .from(issueContractWaits)
    .where(
      and(
        eq(issueContractWaits.issueId, issueId),
        eq(issueContractWaits.providerProjectId, providerId),
        eq(issueContractWaits.contractSlug, contractSlug),
        isNull(issueContractWaits.retractedAt),
      ),
    );
  return row ?? null;
}

async function requestByNumber(number: string): Promise<(RequestFacts & { id: string }) | null> {
  const [row] = await db
    .select({
      id: contractRequests.id,
      consumerId: contractRequests.projectId,
      providerId: contractRequests.providerProjectId,
      contractSlug: contractRequests.contractSlug,
    })
    .from(contractRequests)
    .innerJoin(channelDocuments, eq(channelDocuments.id, contractRequests.channelDocumentId))
    .where(eq(channelDocuments.number, number));
  return row ? { ...row, number } : null;
}

export async function waitTargetOf(input: {
  consumerId: string;
  issueId: string;
  contract: string;
  minVersion: string;
  request: string | undefined;
}): Promise<{ target: WaitTarget; requestId: string | null }> {
  const { provider: providerSlug, contract: contractSlug } = splitContractRef(input.contract);
  const [provider] = await projectsWhere(db, { slugs: [providerSlug] });
  const [iface, memberships, request] = await Promise.all([
    provider ? loadInterface(provider.id) : Promise.resolve(null),
    activeEcosystemIdsOf(db, [input.consumerId]),
    input.request ? requestByNumber(input.request) : Promise.resolve(null),
  ]);
  const publication = iface?.document.publishes[contractSlug] ?? null;
  return {
    requestId: request?.id ?? null,
    target: {
      consumerId: input.consumerId,
      ref: input.contract,
      contractSlug,
      provider: provider ? { id: provider.id, slug: provider.slug } : null,
      publication,
      consumerEcosystems: memberships.map((m) => m.ecosystemId),
      versioning: iface?.document.commitments.versioning ?? null,
      minVersion: input.minVersion,
      duplicate: provider ? await liveWaitOn(db, input.issueId, provider.id, contractSlug) : null,
      requestNamed: input.request ?? null,
      request,
    },
  };
}

export async function approvedVersions(
  tx: Tx,
  providerId: string,
  contractSlug: string,
): Promise<string[]> {
  const rows = await tx
    .select({ version: contractVersions.version })
    .from(contractVersions)
    .where(
      and(
        eq(contractVersions.providerProjectId, providerId),
        eq(contractVersions.contractSlug, contractSlug),
        eq(contractVersions.approval, 'approved'),
      ),
    )
    .orderBy(sql`${contractVersions.recordedAt} DESC`);
  return rows.map((r) => r.version);
}

/** An issue's id and project, or null. */
export async function issueScopeOf(id: string): Promise<{ id: string; projectId: string } | null> {
  const [issue] = await db
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, id))
    .limit(1);
  return issue ?? null;
}
