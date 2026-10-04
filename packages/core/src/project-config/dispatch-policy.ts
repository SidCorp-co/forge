import {
  type DispatchState,
  POLICY_REFUSAL_CODES,
  type PolicyRefusalCode,
  type PolicyStateSource,
} from '@forge/contracts/project-config';
import { isRefusal, type RefusalError, refuser } from '../lib/refusal.js';
import { AUTONOMOUS_ENTRY_STATUS } from '@forge/contracts/issue-machine';
import { readEffectivePolicy } from './effective.js';
import { POLICY_STATE_STATUSES, type PolicyDocument } from './schema.js';
import type { Held } from './service.js';

const refuse = refuser<PolicyRefusalCode>('POLICY_UNDECLARED');

/** Dispatch refused because the project's policy cannot say how this work runs. */
export function policyRefusal(
  code: PolicyRefusalCode,
  projectId: string,
  status: string | null,
): RefusalError {
  return refuse(
    code,
    code === 'POLICY_UNDECLARED'
      ? `project ${projectId} has no policy, so nothing dispatches there. Write one with PUT /api/projects/${projectId}/policy ({ baseRevision: null, document: <policy-v1> }); the schema is /api/schemas/policy-v1.json.`
      : `the policy of project ${projectId} declares no state "${status}", so work at "${status}" has no model and no deny profile. Add states.${status} to the policy (PUT /api/projects/${projectId}/policy).`,
  );
}

/** A thrown policy refusal, with its code and sentence. */
export function policyRefusalOf(err: unknown): { code: PolicyRefusalCode; detail: string } | null {
  if (!isRefusal(err)) return null;
  const hit = err.refusals.find((r) =>
    (POLICY_REFUSAL_CODES as readonly string[]).includes(r.code),
  );
  return hit ? { code: hit.code as PolicyRefusalCode, detail: hit.detail } : null;
}

export type PolicyStatus = (typeof POLICY_STATE_STATUSES)[number];

export const isPolicyStatus = (status: string): status is PolicyStatus =>
  (POLICY_STATE_STATUSES as readonly string[]).includes(status);

export type { DispatchState, PolicyStateSource };

export async function requirePolicy(projectId: string): Promise<Held<PolicyDocument>> {
  const held = await readEffectivePolicy(projectId);
  if (!held) throw policyRefusal('POLICY_UNDECLARED', projectId, null);
  return held;
}

/**
 * The state one dispatch runs under.
 *
 * `status` is the one the work is for: stamped on the job, else its issue's. A status the policy
 * does not govern (no issue, or a status past the driver's) runs under the entry state, and `from`
 * says so; a governed status the policy leaves out is refused, never given another state's profile.
 */
export function dispatchStateOf(
  projectId: string,
  held: Held<PolicyDocument>,
  wanted: { status: string | null; from: Exclude<PolicyStateSource, 'entry'> },
): DispatchState {
  const governed = wanted.status !== null && isPolicyStatus(wanted.status);
  const status: PolicyStatus = governed ? (wanted.status as PolicyStatus) : AUTONOMOUS_ENTRY_STATUS;
  const state = held.document.states[status];
  if (!state) throw policyRefusal('POLICY_STATE_UNDECLARED', projectId, status);
  const profile = held.document.permissions[state.permissions];
  // cm:guard writePolicy refuses an undefined profile (PERMISSION_PROFILE_UNDEFINED); a stored
  // document that names one anyway is corrupt, and dispatching it would deny nothing.
  if (!profile) {
    throw new Error(
      `project-config: the policy of ${projectId} at revision ${held.revision} names profile "${state.permissions}" at states.${status} and defines none; refusing to dispatch with no deny list.`,
    );
  }
  return {
    revision: held.revision,
    qa: held.document.qa,
    status,
    from: governed ? wanted.from : 'entry',
    model: state.model,
    profile: state.permissions,
    deniedTools: [...profile.deny],
  };
}
