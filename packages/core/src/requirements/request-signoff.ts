// A contract request's provenance (requirement-lifecycle `start`, E2): the project it came from, and
// the sign-off it may never give.

import type { RequirementContractRequest } from '@forge/contracts/requirements';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import type { requirements } from '../db/schema-requirements.js';
import type { RequirementRefusal } from './rules.js';

type Row = typeof requirements.$inferSelect;

async function projectOf(id: string): Promise<{ id: string; slug: string } | null> {
  const [p] = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, id));
  return p ?? null;
}

/** The project a contract request came from, or null for a requirement written here. */
export async function requestedByOf(
  row: Pick<Row, 'requestedByProjectId'>,
): Promise<{ id: string; slug: string } | null> {
  return row.requestedByProjectId ? projectOf(row.requestedByProjectId) : null;
}

/** What the detail serves of a contract request: who asked, for which of this project's contracts. */
export async function requestViewOf(
  row: Pick<Row, 'projectId' | 'requestedByProjectId' | 'requestedContractSlug'>,
): Promise<RequirementContractRequest | null> {
  if (!row.requestedContractSlug) return null;
  const [by, provider] = await Promise.all([requestedByOf(row), projectOf(row.projectId)]);
  if (!by) return null;
  return {
    projectId: by.id,
    project: by.slug,
    contract: `${provider?.slug ?? row.projectId}/${row.requestedContractSlug}`,
  };
}

/**
 * A contract request is signed only by this project (E2): a signer refused requirements.approve
 * here who is a member of the requesting project is that project trying to agree its own request,
 * and is refused as such rather than as a stranger.
 */
export function requestSignoffRefusal(input: {
  refusal: RequirementRefusal | null;
  key: string;
  requestedBy: { id: string; slug: string } | null;
  signerInRequestingProject: boolean;
}): RequirementRefusal | null {
  const { refusal, requestedBy } = input;
  if (!refusal || !requestedBy || !input.signerInRequestingProject) return refusal;
  return {
    code: 'REQUIREMENT_SIGNOFF_FORBIDDEN',
    path: '',
    detail: `${input.key} is a contract request from project ${requestedBy.slug}; only a holder of requirements.approve on this project signs it off, and the requesting project never does. ${refusal.detail}`,
  };
}
