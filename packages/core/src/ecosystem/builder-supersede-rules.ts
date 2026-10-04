/** Who may replace a builder run that cannot finish truly, and what the replaced run reads as afterwards. */

import type { OrgMemberRole } from '../db/schema.js';
import { holdsOrg, type PermissionFacts, permissionRefusal } from '../permissions/index.js';
import { isOpenRun } from './link-rules.js';
import { type BuilderRunWrite, LIMITS } from './link-schema.js';
import type { Checked, EcosystemRefusal } from './refusals.js';

/**
 * Superseding closes a project's own work and opens new work for its master: project.write on the
 * run's project, or org.admin of the ecosystem's steward org.
 */
export function supersederRefusal(
  facts: PermissionFacts,
  stewardRole: OrgMemberRole | null,
): EcosystemRefusal | null {
  if (holdsOrg(stewardRole, 'org.admin')) return null;
  return permissionRefusal(
    facts,
    'project.write',
    "superseding a builder run (or org.admin of the ecosystem's steward org)",
  );
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
