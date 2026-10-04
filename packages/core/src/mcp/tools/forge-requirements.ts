/**
 * `forge_requirements` — the agent's face of this project's requirements (REQ-n). An agent drafts
 * and proposes revisions and links issues and designs; accepting a revision, returning one and
 * agreeing a requirement are a person's acts and refuse an agent (REQUIREMENT_SIGNOFF_FORBIDDEN).
 * The REST routes in `requirements/routes.ts` are the same services.
 */

import type { RequirementAct } from '@forge/contracts/requirements';
import { z } from 'zod';
import { egressShown } from '../../lib/data-egress.js';
import type { NamedRefusal } from '../../project-config/respond.js';
import { deferRequirement, undeferRequirement } from '../../requirements/deferral.js';
import {
  linkIssue,
  linkWorkflow,
  unlinkIssue,
  unlinkWorkflow,
} from '../../requirements/issue-links.js';
import { requirementActAnswerOf, requirementSummaryOf } from '../../requirements/projection.js';
import {
  listRequirementsAs,
  type RequirementActor,
  readRequirementAs,
} from '../../requirements/read.js';
import { repinRequirement } from '../../requirements/repin.js';
import { criterionSchema, specSchema } from '../../requirements/schemas.js';
import {
  acceptRevision,
  agreeRequirement,
  createRequirement,
  proposeRevision,
  type RequirementOutcome,
  returnRevision,
  writeRevision,
} from '../../requirements/service.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  principalAgency,
  refusedAnswer,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';
import { projectMany, projectOne, summaryNotice, VIEW_RULE, viewInput } from './projection.js';

const ACTIONS = [
  'list',
  'get',
  'create',
  'revise',
  'edit',
  'propose',
  'accept',
  'return',
  'agree',
  'repin',
  'defer',
  'undefer',
  'link_issue',
  'unlink_issue',
  'link_workflow',
  'unlink_workflow',
] as const;

const inputSchema = z
  .object({
    action: z.enum(ACTIONS),
    projectId: z.uuid().optional(),
    /** The requirement, by uuid or key (REQ-12). */
    requirement: z.string().trim().min(1).max(64).optional(),
    title: z.string().trim().min(1).max(500).optional(),
    reason: z.string().max(4_000).optional(),
    spec: specSchema.optional(),
    tldr: z.string().max(4_000).nullable().optional(),
    changeSummary: z.string().max(4_000).nullable().optional(),
    criteria: z.array(criterionSchema).max(200).optional(),
    /** revise: the head revision the new one is written against (null when none is current). */
    baseRevision: z.number().int().min(1).nullable().optional(),
    /** edit / propose / accept / return / agree: the revision acted on. */
    revision: z.number().int().min(1).optional(),
    issue: z.string().trim().min(1).max(200).optional(),
    adoptPlan: z.boolean().optional(),
    workflowId: z.uuid().optional(),
    targetPhase: z.string().trim().min(1).max(200).optional(),
    view: viewInput,
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

const write = 'projects:write';
const GRANTS = {
  byAction: {
    list: 'projects:read',
    get: 'projects:read',
    create: write,
    revise: write,
    edit: write,
    propose: write,
    accept: write,
    return: write,
    agree: write,
    repin: write,
    defer: write,
    undefer: write,
    link_issue: write,
    unlink_issue: write,
    link_workflow: write,
    unlink_workflow: write,
  },
} as const;

const DESCRIPTION =
  "This project's requirements (REQ-n): the business intent issues deliver, in immutable revisions " +
  'with stable business criteria (BC-n). Workflow requirement-lifecycle. Actions: ' +
  `${ACTIONS.join(' | ')}. ` +
  'create: { title, reason, spec?, tldr?, criteria: [{ body, form? }] } writes REQ-n at revision 1 (draft). ' +
  'revise: { requirement, baseRevision, reason, criteria: [{ code?, body, form? }], … } writes a new draft ' +
  'revision on the head you read (REQUIREMENT_REVISION_STALE otherwise); a criterion naming a live code keeps ' +
  'it, one naming none takes the next code, one left out is retired. edit: { requirement, revision, … } ' +
  'rewrites a draft. propose: { requirement, revision } puts the draft in front of the BA or owner. ' +
  'Statement form is the default; form "scenario" must read Given / When / Then (CRITERION_SCENARIO_UNPARSEABLE). ' +
  'accept: { requirement, revision, reason? } makes a proposed revision current (the head) and supersedes the previous ' +
  'one (reason is the re-baseline sign-off on an agreed requirement); return: { requirement, revision, reason } sends it back to draft; agree: { requirement, revision } ' +
  'signs the head off and writes a baseline pinning every linked design, refused REQUIREMENT_DESIGN_UNAPPROVED ' +
  'naming each unapproved design and REQUIREMENT_REVISION_NOT_CURRENT unless the head is current. accept, return ' +
  'and agree are a person’s acts: an agent is refused REQUIREMENT_SIGNOFF_FORBIDDEN. ' +
  'repin: { requirement, revision, reason? } writes a new baseline of the head pinning each linked design’s approved ' +
  'revision, with no text revision, once a design is approved past what the agreed baseline pins (the standing waits on ' +
  '"re-pin"); REQUIREMENT_PINS_CURRENT when nothing moved, and the agree’s own guards otherwise. Issues planned before it ' +
  'read changedSincePlan. A person’s act. ' +
  'defer: { requirement, reason, targetPhase? } takes a draft or agreed requirement out of the current release ' +
  '(REQUIREMENT_DEFER_REASON_REQUIRED, REQUIREMENT_NOT_DEFERRABLE, REQUIREMENT_HAS_LIVE_ISSUES naming each linked issue past draft); ' +
  'a deferred requirement waits on nobody and is not broken down, and accept, agree and link_issue on it are REQUIREMENT_DEFERRED. ' +
  'undefer: { requirement, reason? } puts back the status it was deferred from (REQUIREMENT_NOT_DEFERRED otherwise). Both are a person’s acts. ' +
  'link_issue: { requirement, issue } once the requirement is agreed (REQUIREMENT_NOT_AGREED); the issue’s plan ' +
  'then records the revision it was written against, and forge_issues get shows `requirement.changedSincePlan`. ' +
  'A plan written before the link reads changed-since-plan unless a person passes adoptPlan: true, attesting it ' +
  'already satisfies the current revision (REQUIREMENT_NO_PLAN_TO_ADOPT when the issue has no plan). ' +
  'link_workflow: { requirement, workflowId } names a design the next agree pins. ' +
  'get: revisions with their criteria, baselines with pins, linked designs and issues, and the delivery phase ' +
  '(agreed | in_delivery | delivered), computed on read. ' +
  'list answers each requirement as { id, key, title, status, state, currentRevision, latestRevision, counts, ' +
  'waitingOn, updatedAt }, no bodies. A write answers { act, requirement: { id, key, title, status, ' +
  'currentRevision, latestRevision, updatedAt } } and what it changed: create / revise / edit the written ' +
  'revision with its criteria codes, propose / accept / return / agree the decided revision (agree also the ' +
  'baseline), repin the latest baseline, link_issue / unlink_issue the linked issues, link_workflow / ' +
  'unlink_workflow the linked designs; defer and undefer answer the requirement alone. ' +
  VIEW_RULE;

function need<K extends keyof Input>(input: Input, key: K): NonNullable<Input[K]> {
  const value = input[key];
  if (value === undefined || value === null) {
    throw new Error(`BAD_REQUEST: ${input.action} needs \`${String(key)}\``);
  }
  return value as NonNullable<Input[K]>;
}

const refusedBy = (refusals: readonly NamedRefusal[]) =>
  refusedAnswer(refusals, 'REQUIREMENT_REFUSED');

async function settle(
  projectId: string,
  input: Input,
  outcome: RequirementOutcome,
  revision?: number,
) {
  if (!outcome.ok) return refusedBy(outcome.refusals);
  const shown = await egressShown(
    projectId,
    'requirement',
    outcome.requirement,
    outcome.requirement.key,
  );
  return projectOne(input.view, shown, (detail) =>
    requirementActAnswerOf(detail, input.action as RequirementAct, revision),
  );
}

const revisionWrite = (input: Input) => ({
  reason: need(input, 'reason'),
  spec: input.spec,
  tldr: input.tldr,
  changeSummary: input.changeSummary,
  criteria: input.criteria ?? [],
});

async function run(args: unknown, ctx: McpContext): Promise<unknown> {
  const input = inputSchema.parse(args);
  const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
  const actor: RequirementActor = {
    userId: ctx.principal.userId,
    agency: principalAgency(ctx.principal),
  };
  const on = () => ({ projectId, ref: need(input, 'requirement'), actor });
  switch (input.action) {
    case 'list':
      return {
        requirements: projectMany(
          input.view,
          await egressShown(
            projectId,
            'requirement',
            await listRequirementsAs(actor, projectId),
            'the requirement list',
          ),
          requirementSummaryOf,
        ),
        ...summaryNotice(
          input.view,
          "get { requirement } for one requirement whole, or view: 'full'",
        ),
      };
    case 'get': {
      const detail = await egressShown(
        projectId,
        'requirement',
        await readRequirementAs(actor, projectId, need(input, 'requirement')),
        need(input, 'requirement'),
      );
      return input.view === 'summary' ? requirementSummaryOf(detail) : detail;
    }
    case 'create':
      return settle(
        projectId,
        input,
        await createRequirement({
          projectId,
          actor,
          title: need(input, 'title'),
          write: revisionWrite(input),
        }),
      );
    case 'revise':
      return settle(
        projectId,
        input,
        await writeRevision({
          ...on(),
          baseRevision: input.baseRevision ?? null,
          write: revisionWrite(input),
        }),
      );
    case 'edit':
      return settle(
        projectId,
        input,
        await writeRevision({
          ...on(),
          revision: need(input, 'revision'),
          write: revisionWrite(input),
        }),
        input.revision,
      );
    case 'propose':
      return settle(
        projectId,
        input,
        await proposeRevision({ ...on(), revision: need(input, 'revision') }),
        input.revision,
      );
    case 'accept':
      return settle(
        projectId,
        input,
        await acceptRevision({
          ...on(),
          revision: need(input, 'revision'),
          reason: input.reason,
        }),
        input.revision,
      );
    case 'return':
      return settle(
        projectId,
        input,
        await returnRevision({
          ...on(),
          revision: need(input, 'revision'),
          reason: need(input, 'reason'),
        }),
        input.revision,
      );
    case 'agree':
      return settle(
        projectId,
        input,
        await agreeRequirement({
          ...on(),
          revision: need(input, 'revision'),
          reason: input.reason,
        }),
        input.revision,
      );
    case 'repin':
      return settle(
        projectId,
        input,
        await repinRequirement({
          ...on(),
          revision: need(input, 'revision'),
          reason: input.reason,
        }),
      );
    case 'defer':
      return settle(
        projectId,
        input,
        await deferRequirement({
          ...on(),
          reason: need(input, 'reason'),
          targetPhase: input.targetPhase,
        }),
      );
    case 'undefer':
      return settle(projectId, input, await undeferRequirement({ ...on(), reason: input.reason }));
    case 'link_issue':
      return settle(
        projectId,
        input,
        await linkIssue({
          ...on(),
          issue: need(input, 'issue'),
          adoptPlan: input.adoptPlan === true,
        }),
      );
    case 'unlink_issue':
      return settle(projectId, input, await unlinkIssue({ ...on(), issue: need(input, 'issue') }));
    case 'link_workflow':
      return settle(
        projectId,
        input,
        await linkWorkflow({ ...on(), workflowId: need(input, 'workflowId') }),
      );
    case 'unlink_workflow':
      return settle(
        projectId,
        input,
        await unlinkWorkflow({ ...on(), workflowId: need(input, 'workflowId') }),
      );
  }
}

export const forgeRequirementsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_requirements',
  reach: 'project',
  route: '/api/projects',
  grant: GRANTS,
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: (args) => run(args, ctx),
});
