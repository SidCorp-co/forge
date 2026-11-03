// Who reads an issue standing and what they may take on it: project.write, and what the admit gate
// asks for a draft (`transition-guards.ts`, `approvals.admit`), with the names holding it (ISS-926).

import { effectiveApprovals, personGatePermission } from '@forge/contracts/person-gates';
import { effectiveProjectRole } from '../lib/authz.js';
import { peopleOf } from '../lib/people.js';
import { holderNames, holds } from '../permissions/index.js';
import { readProjectDocument } from './ports.js';
import type { IssueStandingInput } from './standing.js';

/** What taking a draft on asks on this project (`transition-guards.ts`, `approvals.admit`), and who holds it. */
export async function admitOf(projectId: string): Promise<IssueStandingInput['admit']> {
  const document = (await readProjectDocument(projectId))?.document;
  const permission = personGatePermission(effectiveApprovals(document), 'admit');
  return { permission, holders: await holderNames(permission, projectId) };
}

export async function viewerOf(
  viewer: { userId: string } | null,
  projectId: string,
  admit: Promise<IssueStandingInput['admit']>,
) {
  if (!viewer) return null;
  const [access, people, gate] = await Promise.all([
    effectiveProjectRole(viewer.userId, projectId),
    peopleOf([viewer.userId]),
    admit,
  ]);
  // A person's wait addresses its viewer as "You" only when the viewer is a person.
  const person = people.get(viewer.userId)?.kind !== 'agent';
  return {
    userId: viewer.userId,
    canWrite: person && access !== null && holds(access, 'project.write'),
    canAdmit: person && access !== null && holds(access, gate.permission),
  };
}
