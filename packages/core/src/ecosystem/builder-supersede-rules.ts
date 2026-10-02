/** Who may replace a builder run that cannot finish truly, and what the replaced run reads as afterwards. */

import type { OrgMemberRole, ProjectMemberRole } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { orgRoleAtLeast, projectRoleAtLeast } from '../lib/authz.js';
import { isOpenRun } from './link-rules.js';
import { type BuilderRunWrite, LIMITS } from './link-schema.js';
import type { Checked, EcosystemRefusal } from './refusals.js';

export interface SupersederFacts {
  userId: string;
  agency: ActorAgency;
  /** The actor's role on the run's own project, through the token's fence. */
  projectRole: ProjectMemberRole | null;
  /** The actor's role in the org that owns the run's project. */
  projectOrgRole: OrgMemberRole | null;
  /** The actor's role in the ecosystem's steward org. */
  stewardRole: OrgMemberRole | null;
}

// cm:why superseding closes a project's own work and opens new work for its master, so it is that project's own agent's, or an org admin's who answers for one side of the ecosystem; another project's agent and a plain member are refused by name
export function supersederRefusal(
  facts: SupersederFacts,
  projectId: string,
): EcosystemRefusal | null {
  if (facts.agency === 'agent' && projectRoleAtLeast(facts.projectRole, 'member')) return null;
  if (orgRoleAtLeast(facts.projectOrgRole, 'admin')) return null;
  if (orgRoleAtLeast(facts.stewardRole, 'admin')) return null;
  const held =
    facts.agency === 'agent'
      ? `agent ${facts.userId} holds ${facts.projectRole ?? 'no role'} on project ${projectId}`
      : `${facts.userId} acts as a person and is no org admin of project ${projectId}'s org or of the steward`;
  return {
    code: 'BUILDER_RUN_SUPERSEDE_NOT_AUTHORISED',
    path: '',
    detail: `${held}; a builder run is superseded by project ${projectId}'s own agent (its master, member or above) or by an owner or admin of the steward org or of the project's org.`,
  };
}

export function supersedeReason(raw: unknown): Checked<string> {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason.length >= 1 && reason.length <= LIMITS.reason) return { ok: true, value: reason };
  return {
    ok: false,
    refusals: [
      {
        code: 'BUILDER_RUN_SUPERSEDE_WITHOUT_REASON',
        path: '/reason',
        detail: `superseding a run says why: the body is { "reason": 1 to ${LIMITS.reason} characters }, and the reason is kept on the closed run.`,
      },
    ],
  };
}

export function notOpenRefusal(runId: string, doc: BuilderRunWrite): EcosystemRefusal | null {
  if (isOpenRun(doc)) return null;
  const how = doc.supersededBy
    ? `was already superseded by run ${doc.supersededBy.run}`
    : 'is finished (every step succeeded, failed or skipped)';
  return {
    code: 'BUILDER_RUN_NOT_OPEN',
    path: '/run',
    detail: `builder run ${runId} ${how}; only an open run is superseded, and a finished one is followed by the next join or push.`,
  };
}

/** The open run closed: every step it never finished reads `superseded`, and the run names its replacement and why. */
export function supersededRun(
  doc: BuilderRunWrite,
  by: { run: string; reason: string },
): BuilderRunWrite {
  return {
    ...doc,
    steps: doc.steps.map((s) =>
      s.status === 'pending' || s.status === 'running'
        ? { ...s, status: 'superseded' as const }
        : s,
    ),
    supersededBy: by,
  };
}
