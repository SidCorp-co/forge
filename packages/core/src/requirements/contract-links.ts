/**
 * The contracts a requirement is built on (workflow requirement-to-delivery, step `req-head`): a
 * link to a contract this project publishes or consumes, made before any version exists, so the
 * agree or re-pin pins whichever version is current then (step `pins`).
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirementContracts } from '../db/schema-requirements.js';
import { heldInterface } from '../ecosystem/interface-service.js';
import { projectsWhere, readInterfaces } from '../ecosystem/store.js';
import { linkedContracts } from './baselines.js';
import { notFound, type RequirementActor, rowIn } from './read.js';
import { contractLinkRefusal } from './rules.js';
import { answer, type RequirementOutcome } from './service.js';
import { requireCan } from '../permissions/index.js';

/** The contracts `projectId`'s interface publishes and consumes, as `<project>/<contract>` refs. */
async function contractsOfProject(projectId: string) {
  const [own] = await projectsWhere(db, { ids: [projectId] });
  const held = (await readInterfaces(db, [projectId])).get(projectId);
  if (!own || !held) return { publishes: [], consumes: [] };
  const doc = heldInterface(held, projectId).document;
  return {
    publishes: Object.keys(doc.publishes).map((slug) => `${own.slug}/${slug}`),
    consumes: doc.consumes.map((c) => c.contract),
  };
}

export async function linkContract(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  contract: string;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  await requireCan({ userId: actor.userId }, 'project.write', projectId);
  const row = await rowIn(db, projectId, input.ref);
  const refusal = contractLinkRefusal({
    contract: input.contract,
    ...(await contractsOfProject(projectId)),
  });
  if (refusal) return { ok: false, refusals: [refusal] };
  const [providerSlug, contractSlug] = input.contract.split('/') as [string, string];
  const [provider] = await projectsWhere(db, { slugs: [providerSlug] });
  if (!provider) throw notFound(`no project has the slug ${providerSlug}`);
  await db
    .insert(requirementContracts)
    .values({
      requirementId: row.id,
      providerProjectId: provider.id,
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
  await requireCan({ userId: actor.userId }, 'project.write', projectId);
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
