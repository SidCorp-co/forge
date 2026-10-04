/** Who writes a provider's own interface and contract versions, and who set the commitments it makes. */

import { isDeepStrictEqual } from 'node:util';
import type { ProjectMemberRole } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import type { EcosystemRefusal } from './refusals.js';
import { holds } from '../permissions/index.js';

export interface ProviderWriterFacts {
  userId: string;
  agency: ActorAgency;
  /** The writer's role on the project, through the token's fence. */
  role: ProjectMemberRole | null;
}

export type ProviderWriterCode = 'INTERFACE_WRITER_NOT_PROJECT' | 'CONTRACT_WRITER_NOT_PROVIDER';

// cm:why the ecosystem is built by the agents that live in it: a project's own agent (member or above, through a token that reaches the project) writes the interface and contracts it publishes, a person needs admin, and another project's agent holds no role here and is refused by name
export function providerWriterRefusal(
  facts: ProviderWriterFacts,
  projectId: string,
  code: ProviderWriterCode,
): EcosystemRefusal | null {
  if (facts.agency === 'agent' && holds(facts, 'project.write')) return null;
  if (facts.agency === 'human' && holds(facts, 'project.admin')) return null;
  const held =
    facts.agency === 'agent'
      ? `agent ${facts.userId} holds ${facts.role ?? 'no role'} on project ${projectId}, so it is not this project's own agent`
      : `${facts.userId} acts as a person holding ${facts.role ?? 'no role'} on project ${projectId}`;
  const what = code === 'INTERFACE_WRITER_NOT_PROJECT' ? 'interface' : 'contract versions';
  return {
    code,
    path: '',
    detail: `${held}; project ${projectId}'s ${what} is written by its own agent (its master or a run it dispatched, member or above) or by a person holding admin or above on it.`,
  };
}

export interface RevisionBy {
  revision: number;
  document: unknown;
  writtenBy: string;
  writtenAt: Date;
  agency: ActorAgency;
}

export interface CommitmentsSetter {
  userId: string;
  agency: ActorAgency;
  revision: number;
  at: string;
}

const commitmentsOf = (doc: unknown): unknown =>
  typeof doc === 'object' && doc !== null
    ? (doc as { commitments?: unknown }).commitments
    : undefined;

/** The revision that last changed the commitments: the oldest of the unbroken run, newest first, that holds them as they are now. */
export function commitmentsSetterOf(newestFirst: readonly RevisionBy[]): CommitmentsSetter | null {
  const [head] = newestFirst;
  if (!head) return null;
  const now = commitmentsOf(head.document);
  let setter = head;
  for (const r of newestFirst.slice(1)) {
    if (!isDeepStrictEqual(commitmentsOf(r.document), now)) break;
    setter = r;
  }
  return {
    userId: setter.writtenBy,
    agency: setter.agency,
    revision: setter.revision,
    at: setter.writtenAt.toISOString(),
  };
}

// cm:why an agent proposes the commitment windows and a person may overrule them; once a person has set them, an agent's write that moves them would silently undo that person's decision, so it is refused and the person's numbers stand
export function commitmentsRefusal(
  writer: { agency: ActorAgency },
  setter: CommitmentsSetter | null,
  current: unknown,
  next: unknown,
): EcosystemRefusal | null {
  if (writer.agency !== 'agent' || setter?.agency !== 'human') return null;
  if (isDeepStrictEqual(commitmentsOf(current), commitmentsOf(next))) return null;
  return {
    code: 'COMMITMENTS_SET_BY_PERSON',
    path: '/commitments',
    detail: `the commitments were set by a person (${setter.userId}, revision ${setter.revision}); an agent writes the interface with them as they stand, and only a person holding admin changes them.`,
  };
}
