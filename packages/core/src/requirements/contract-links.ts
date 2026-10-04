/**
 * The contracts a requirement is built on (workflow requirement-to-delivery, step `req-head`): a
 * link to a contract this project publishes or consumes, made before any version exists, so the
 * agree or re-pin pins whichever version is current then (step `pins`).
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirementContracts } from '../db/schema-requirements.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { findProjectIdBySlug } from '../projects/index.js';
import { linkedContracts } from './baselines.js';
import { notFound, type RequirementActor, rowIn } from './read.js';
import { contractLinkRefusal } from './rules.js';
import { answer, type RequirementOutcome } from './write-tx.js';

/** The contracts a project's interface publishes and consumes, as `<project>/<contract>` refs; null when it holds none. */
export type InterfaceContracts = (
  projectId: string,
) => Promise<{ publishes: string[]; consumes: string[] } | null>;

let interfaceContracts: InterfaceContracts | null = null;

/**
 * Ecosystem holds a project's interface and sits downstream of design, so the composition root
 * hands its read in at boot rather than this module importing it.
 */
export function provideInterfaceContracts(source: InterfaceContracts): void {
  interfaceContracts = source;
}

async function contractsOfProject(projectId: string) {
  if (!interfaceContracts) {
    throw new Error(
      'requirement contract links: no interface source was provided, so what a project publishes and consumes cannot be read; the process entry calls provideInterfaceContracts(interfaceContractsOf) from ecosystem/index.ts before it serves',
    );
  }
  return (await interfaceContracts(projectId)) ?? { publishes: [], consumes: [] };
}

export async function linkContract(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  contract: string;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const row = await rowIn(db, projectId, input.ref);
  const refusal = contractLinkRefusal({
    contract: input.contract,
    ...(await contractsOfProject(projectId)),
  });
  if (refusal) return { ok: false, refusals: [refusal] };
  const [providerSlug, contractSlug] = input.contract.split('/') as [string, string];
  const providerProjectId = await findProjectIdBySlug(providerSlug);
  if (!providerProjectId) throw notFound(`no project has the slug ${providerSlug}`);
  await db
    .insert(requirementContracts)
    .values({
      requirementId: row.id,
      providerProjectId,
      contractSlug,
      linkedBy: actor.userId,
    })
    .onConflictDoNothing();
  return answer(projectId, row.id, actor, null);
}

export async function unlinkContract(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  contract: string;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const row = await rowIn(db, projectId, input.ref);
  const linked = (await linkedContracts(db, row.id)).find((c) => c.contract === input.contract);
  if (!linked) throw notFound(`${input.ref} links no contract ${input.contract}`);
  await db
    .delete(requirementContracts)
    .where(
      and(
        eq(requirementContracts.requirementId, row.id),
        eq(requirementContracts.providerProjectId, linked.providerProjectId),
        eq(requirementContracts.contractSlug, linked.contractSlug),
      ),
    );
  return answer(projectId, row.id, actor, null);
}
