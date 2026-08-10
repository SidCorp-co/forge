import {
  type HandoffScope,
  type HandoffStep,
  type StepHandoffPayload,
  isHandoffStep,
} from '../memory/step-handoff-schema.js';
import type { JobType } from '../db/schema.js';
import { resolveHandoffsPolicy } from './handoff-policy.js';
import type { UserPromptPolicyConfig } from './pipeline-config-schema.js';
import type { PriorHandoff } from '../prompt/user.js';
import { getIssueContexts } from './issue-context-store.js';

/**
 * Pre-fetch step-handoff context for a new pipeline job (proposal Y wiring).
 *
 * Orchestrator + PM dispatch call this right before `buildJobPromptString` so
 * the prompt builder can render `## Prior step handoffs` and the
 * `## Termination protocol` block with the correct scope literals. When
 * `policy.handoffs.enabled` is false or unset, returns `null` for both fields
 * — the prompt builder treats null as "no-op".
 *
 * Returned `priorHandoffs` are filtered to `policy.handoffs.injectFromSteps`
 * inside `buildJobPromptString` as a defence-in-depth — we also pass the
 * allow-list to the DB query here so we don't waste bandwidth fetching steps
 * the policy won't use.
 */
export async function fetchHandoffPromptInputs(args: {
  projectId: string;
  issueId: string | null;
  pipelineRunId: string;
  attempt: number;
  jobType: JobType;
  policy: UserPromptPolicyConfig | null | undefined;
}): Promise<{
  priorHandoffs: PriorHandoff[] | null;
  handoffScope: HandoffScope | null;
}> {
  // System-default-on: explicit config wins per-field, otherwise sensible
  // defaults apply (see handoff-policy.ts).
  const handoffs = resolveHandoffsPolicy(args.policy, args.jobType);
  if (!handoffs.enabled || !args.issueId) {
    return { priorHandoffs: null, handoffScope: null };
  }

  const injectSteps = handoffs.injectFromSteps.filter((s): s is HandoffStep =>
    isHandoffStep(s as JobType),
  );

  // Skip the query when no steps are whitelisted — the only reason to load
  // is so we can inject; with an empty allow-list, the result would never be
  // rendered.
  const rows =
    injectSteps.length > 0
      ? await getIssueContexts({
          projectId: args.projectId,
          issueId: args.issueId,
          pipelineRunId: args.pipelineRunId,
          kind: 'handoff',
          steps: injectSteps,
          limit: 50,
          orderDir: 'desc',
        })
      : [];

  const priorHandoffs: PriorHandoff[] = rows
    .filter((r): r is typeof r & { step: string } => typeof r.step === 'string')
    .filter((r) => isHandoffStep(r.step as JobType))
    .map((r) => ({
      step: r.step as HandoffStep,
      payload: r.payload as StepHandoffPayload,
    }));

  const handoffScope: HandoffScope = {
    projectId: args.projectId,
    issueId: args.issueId,
    runId: args.pipelineRunId,
    attempt: args.attempt,
  };

  return { priorHandoffs, handoffScope };
}
