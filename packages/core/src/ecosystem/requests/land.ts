import type { ActorAgency } from '@forge/contracts/permissions';
import type { Tx } from '../../db/client.js';
import { contractRequests } from '../../db/schema-contract-waits.js';
import { createRequirementIn } from '../../requirements/revision-write.js';
import { lockRequirements } from '../../requirements/service.js';
import { refusedWith } from '../channel-act.js';
import type { ChannelDocument } from '../channel-schema.js';
import { splitContractRef } from '../interface-rules.js';
import { projectsWhere } from '../store.js';

const TITLE_MAX = 500;

type ChangeRequestBody = {
  contract: string;
  need: string;
  rationale: string;
  impactIfDeclined: string;
  urgency: string;
};

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((l) => l.trim()) ?? text).trim();
}

// cm:guard the request lands or the publish does not: a change request whose contract names no other
// project is refused by name inside the publish transaction, so no published CR is left without a home
export async function landChangeRequestIn(
  tx: Tx,
  doc: ChannelDocument,
  input: { documentId: string; by: { userId: string; agency: ActorAgency } },
): Promise<void> {
  if (doc.type !== 'change-request' || doc.state !== 'published') return;
  const body = doc.body as ChangeRequestBody;
  const { provider: providerSlug, contract } = splitContractRef(body.contract);
  const [provider] = await projectsWhere(tx, { slugs: [providerSlug] });
  if (!provider || provider.id === doc.from) {
    throw refusedWith([
      {
        code: 'CONTRACT_REQUEST_PROVIDER_UNKNOWN',
        path: '/body/contract',
        detail: provider
          ? `${body.contract} is this project's own contract; a change request asks another project, and lands as that project's draft requirement.`
          : `${body.contract} names no project; a change request names <provider slug>/<publication slug>, and lands as that provider's draft requirement.`,
      },
    ]);
  }
  const number = doc.number ?? input.documentId;
  await lockRequirements(tx, provider.id);
  // cm:why no owner, since the sender is no member of the provider; it reaches agreed only by the provider's own sign-off, a person's act no agent passes (E2)
  const made = await createRequirementIn(tx, {
    projectId: provider.id,
    actor: input.by,
    ownerId: null,
    title: `${number}: ${firstLine(body.need)}`.slice(0, TITLE_MAX),
    write: {
      reason:
        `Contract request ${number} about ${body.contract} (${body.urgency}): ${body.rationale}`.slice(
          0,
          4000,
        ),
      spec: { goal: body.need },
      tldr: `If declined: ${body.impactIfDeclined}`.slice(0, 4000),
      criteria: [],
    },
  });
  if (made.refusals) {
    throw new Error(
      `contract request ${number}: a draft with no criteria was refused (${made.refusals.map((r) => r.code).join(', ')})`,
    );
  }
  await tx.insert(contractRequests).values({
    projectId: doc.from,
    providerProjectId: provider.id,
    contractSlug: contract,
    channelDocumentId: input.documentId,
    requirementId: made.id,
    requestedBy: input.by.userId,
    requestedAgency: input.by.agency,
  });
}
