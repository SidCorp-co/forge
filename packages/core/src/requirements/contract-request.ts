/**
 * A contract request (requirement-lifecycle `start`, E2): a consumer project asks a provider for a
 * contract it consumes, or one the provider publishes, and the ask lands as a draft requirement in
 * the provider project, naming the requesting project and the contract and linking it. Only the
 * provider agrees it (`requestSignoffRefusal`); the requester reads it back by key.
 */

import { requirementKey } from '@forge/contracts/requirements';
import { eq } from 'drizzle-orm';
import { requirementContracts, requirements } from '../db/schema-requirements.js';
import { emitEvent } from '../outbox/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { findProjectIdBySlug } from '../projects/index.js';
import { contractsOfProject } from './contract-links.js';
import { notFound, type RequirementActor } from './read.js';
import type { RevisionWrite } from './revision-write.js';
import { createRequirementIn } from './revision-write.js';
import { type RequirementRefusal, reasonRefusal } from './rules.js';
import { inTx, lockRequirements } from './write-tx.js';

export interface ContractRequestAnswer {
  id: string;
  key: string;
  /** The provider project the draft was written in. */
  projectId: string;
  requestedByProjectId: string;
  contract: string;
}

/** Why a consumer may not ask for `contract`, or null. */
export function contractRequestRefusal(input: {
  contract: string;
  requesterId: string;
  providerId: string;
  consumes: readonly string[];
  providerPublishes: readonly string[];
}): RequirementRefusal | null {
  if (input.providerId === input.requesterId) {
    return {
      code: 'REQUIREMENT_REQUEST_OWN_PROJECT',
      path: '/contract',
      detail: `${input.contract} is published by this project; a contract request asks another project, and a change to your own contract is a requirement written here.`,
    };
  }
  if (input.consumes.includes(input.contract) || input.providerPublishes.includes(input.contract)) {
    return null;
  }
  return {
    code: 'REQUIREMENT_CONTRACT_UNKNOWN',
    path: '/contract',
    detail: `${input.contract} is neither consumed by this project's interface nor published by its provider (this project consumes ${input.consumes.join(', ') || 'no contract'}); a request names a contract its provider publishes.`,
  };
}

export async function requestContract(input: {
  /** The requesting (consumer) project. */
  projectId: string;
  actor: RequirementActor;
  /** `<provider-slug>/<contract-slug>`. */
  contract: string;
  title: string;
  write: RevisionWrite;
}): Promise<
  { ok: true; request: ContractRequestAnswer } | { ok: false; refusals: RequirementRefusal[] }
> {
  const { projectId, actor, write } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const early = reasonRefusal(write.reason);
  if (early) return { ok: false, refusals: [early] };
  const [providerSlug = '', contractSlug = ''] = input.contract.split('/');
  const providerId = await findProjectIdBySlug(providerSlug);
  if (!providerId) throw notFound(`no project has the slug ${providerSlug}`);
  const [mine, theirs] = await Promise.all([
    contractsOfProject(projectId),
    contractsOfProject(providerId),
  ]);
  const refusal = contractRequestRefusal({
    contract: input.contract,
    requesterId: projectId,
    providerId,
    consumes: mine.consumes,
    providerPublishes: theirs.publishes,
  });
  if (refusal) return { ok: false, refusals: [refusal] };
  let made: { id: string; reqSeq: number } | null = null;
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, providerId);
    const written = await createRequirementIn(tx, {
      projectId: providerId,
      actor,
      title: input.title,
      write,
      ownerId: null,
    });
    if (written.refusals) return written.refusals;
    const [row] = await tx
      .update(requirements)
      .set({ requestedByProjectId: projectId, requestedContractSlug: contractSlug })
      .where(eq(requirements.id, written.id))
      .returning({ id: requirements.id, reqSeq: requirements.reqSeq });
    if (!row) throw new Error(`requirements: contract request ${written.id} vanished in its write`);
    await tx
      .insert(requirementContracts)
      .values({
        requirementId: row.id,
        providerProjectId: providerId,
        contractSlug,
        linkedBy: actor.userId,
      })
      .onConflictDoNothing();
    await emitEvent(tx, 'contract.requested', {
      projectId: providerId,
      requirementId: row.id,
      key: requirementKey(row.reqSeq),
      revision: 1,
      requestedByProjectId: projectId,
      contract: input.contract,
    });
    made = row;
    return null;
  });
  if (refusals) return { ok: false, refusals };
  const row = made as { id: string; reqSeq: number } | null;
  if (!row) throw new Error('requirements: a contract request wrote no row');
  return {
    ok: true,
    request: {
      id: row.id,
      key: requirementKey(row.reqSeq),
      projectId: providerId,
      requestedByProjectId: projectId,
      contract: input.contract,
    },
  };
}
