/**
 * `forge_workflows` — the master's face of its project's workflows: draw them, propose a design,
 * read the approver's decision, and name the issues that build one. The REST routes in
 * `workflows/routes.ts` are the same services; this face only carries the principal across.
 */

import { z } from 'zod';
import type { NamedRefusal } from '../../project-config/respond.js';
import { DESIGN_DECISIONS, DESIGN_REASON_MAX } from '../../workflows/design.js';
import {
  decideDesignAs,
  linkBuildAs,
  proposeDesign,
  readDesignAs,
  unlinkBuildAs,
} from '../../workflows/design-service.js';
import {
  createWorkflow,
  listWorkflowsAs,
  readWorkflowAs,
  updateWorkflow,
  type WorkflowWriter,
  workflowView,
} from '../../workflows/service.js';
import { listProjectTemplatesAs, readProjectTemplateAs } from '../../workflows/template-service.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  principalAgency,
  refusedAnswer,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.enum([
      'list',
      'get',
      'design',
      'write',
      'propose',
      'decide',
      'link',
      'unlink',
      'templates',
      'template',
    ]),
    projectId: z.uuid().optional(),
    workflowId: z.uuid().optional(),
    /** write: the revision the document is based on; null creates a workflow. */
    baseRevision: z.number().int().min(1).nullable().optional(),
    document: z.unknown().optional(),
    /** propose / decide: the revision proposed, or the one being decided. */
    revision: z.number().int().min(1).optional(),
    decision: z.enum(DESIGN_DECISIONS).optional(),
    reason: z.string().max(DESIGN_REASON_MAX).optional(),
    /** link / unlink: the issue that builds the workflow; propose: the issue the design is drawn under. By key (ISS-12) or uuid. */
    issue: z.string().trim().min(1).max(200).optional(),
    /** template: the diagram template to read, by id and version. */
    templateId: z.string().trim().min(1).max(64).optional(),
    templateVersion: z.number().int().min(1).optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

const GRANTS = {
  byAction: {
    list: 'projects:read',
    get: 'projects:read',
    design: 'projects:read',
    write: 'projects:write',
    propose: 'projects:write',
    decide: 'projects:write',
    link: 'projects:write',
    unlink: 'projects:write',
    templates: 'projects:read',
    template: 'projects:read',
  },
} as const;

const DESCRIPTION =
  "Draw this project's workflows and take a design to its approver before anything is built from " +
  'it. Actions: list | get | design | write | propose | decide | link | unlink | templates | template. ' +
  'templates: the diagram templates this project may draw in (the built-ins operational-flow, ' +
  'service-blueprint, ux-flow, state-machine, integration-sequence, decision-model, data-flow, ' +
  'system-context and their presets, then its own); ' +
  'template: { templateId, templateVersion } — one template with its bands, node types (and the ' +
  'fields each requires), edge kinds and rules, plus a tiny example design that passes. ' +
  'Every workflow-v2 document names its template, `template: { id, version }`, and is checked ' +
  'against it: WORKFLOW_TEMPLATE_UNKNOWN, WORKFLOW_NODE_TYPE_NOT_IN_TEMPLATE, WORKFLOW_BAND_MISMATCH, ' +
  'WORKFLOW_NODE_FIELD_MISSING, WORKFLOW_EDGE_KIND_NOT_IN_TEMPLATE, WORKFLOW_EDGE_FIELD_MISSING, ' +
  'WORKFLOW_EDGE_ENDPOINT_NOT_IN_KIND, WORKFLOW_EDGE_KIND_NONE, WORKFLOW_NODE_LINES, WORKFLOW_REF_DANGLING, ' +
  'WORKFLOW_TEMPLATE_RULE and the rest each name the fix. ' +
  'write: { workflowId?, baseRevision, document } — no workflowId and baseRevision null creates; ' +
  'the document is workflow-v1 (a flow the code already has) or workflow-v2 (a design: steps may be ' +
  '`designed` with no evidence and carry `node` { type, label, band, purpose, inputs, outputs, owner, ' +
  'sla, conditions, refs, … } whose type and required fields come from the template, and whose ' +
  "`refs` [{ template, flow, step }] link steps of the project's other designs; `edges` carry " +
  'the contract of a line — a forward kind is a line `after` draws (its kind read from its endpoint ' +
  'types unless named), a return kind (operational-flow `feeds-back`, state-machine `back`) goes back to an earlier step, is never drawn in `after` ' +
  '(WORKFLOW_AFTER_CYCLE) and carries what its kind requires). ' +
  'Schemas: GET /api/schemas/workflow-v1.json, workflow-v2.json and workflow-template-v1.json. A v2 workflow starts as a draft. ' +
  'Evidence matches the project source: a storefront project cites { kind: "storefront", provider, ' +
  'ref: workflow|route|node, id }, a repository project { kind: "repo", file, coverage } — the other ' +
  'is WORKFLOW_EVIDENCE_KIND_MISMATCH. ' +
  'propose: { workflowId, revision, issue } puts a draft in front of its approver; `issue` names the issue ' +
  "the design is drawn under (later revisions inherit it), and a decision wakes this project's master — a " +
  'return reopens that issue with the reason on it, shown by forge_issues get under `proposesWorkflow`. A write that changes the ' +
  'design (its template, steps, order, nodes, edge contracts, return edges) of a proposed, approved or returned workflow ' +
  'proposes that revision again; a write that only refreshes status or evidence does not. ' +
  'design: { workflowId } — the status (draft | proposed | approved | returned), every proposed ' +
  'revision with its decision and reason, the approved revision, and the issues that build it. ' +
  'decide: { workflowId, revision, decision: approve|return, reason } — only the approver the ' +
  "project's `workflows.designApprover` names: `owner` (default) is an org admin person, and an " +
  "agent is refused WORKFLOW_DESIGN_APPROVER_NOT_PERSON; `master` lets this project's own master " +
  'decide too. A return carries its reason. ' +
  'link: { workflowId, issue } names the issue that builds the workflow; dispatching that issue is ' +
  'then refused WORKFLOW_DESIGN_NOT_APPROVED until the design is approved, and forge_issues get ' +
  'shows why under `buildsWorkflow`. unlink lifts the gate, so only the approver may. ' +
  'Guides: forge_guide get workflow-templates (which template to pick) and workflow-design.';

function need<K extends keyof Input>(input: Input, key: K): NonNullable<Input[K]> {
  const value = input[key];
  if (value === undefined || value === null) {
    throw new Error(`BAD_REQUEST: ${input.action} needs \`${String(key)}\``);
  }
  return value as NonNullable<Input[K]>;
}

const refusedBy = (refusals: readonly NamedRefusal[]) =>
  refusedAnswer(refusals, 'WORKFLOW_REFUSED');

async function run(args: unknown, ctx: McpContext): Promise<unknown> {
  const input = inputSchema.parse(args);
  const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
  const actor: WorkflowWriter = {
    userId: ctx.principal.userId,
    agency: principalAgency(ctx.principal),
  };
  switch (input.action) {
    case 'list':
      return { workflows: await listWorkflowsAs(actor.userId, projectId) };
    case 'get':
      return readWorkflowAs(actor.userId, projectId, need(input, 'workflowId'));
    case 'design':
      return readDesignAs(actor, projectId, need(input, 'workflowId'));
    case 'write': {
      const baseRevision = input.baseRevision ?? null;
      const outcome = input.workflowId
        ? await updateWorkflow({
            projectId,
            id: input.workflowId,
            writer: actor,
            baseRevision,
            raw: input.document,
          })
        : await createWorkflow({ projectId, writer: actor, baseRevision, raw: input.document });
      if (!outcome.ok) return refusedBy(outcome.refusals);
      return { ...workflowView(outcome.row, outcome.document), created: outcome.created };
    }
    case 'propose': {
      const outcome = await proposeDesign({
        projectId,
        id: need(input, 'workflowId'),
        writer: actor,
        revision: need(input, 'revision'),
        issue: input.issue,
      });
      return outcome.ok ? outcome.design : refusedBy(outcome.refusals);
    }
    case 'decide': {
      const outcome = await decideDesignAs({
        projectId,
        id: need(input, 'workflowId'),
        decider: actor,
        revision: need(input, 'revision'),
        decision: need(input, 'decision'),
        reason: input.reason ?? null,
      });
      return outcome.ok ? outcome.design : refusedBy(outcome.refusals);
    }
    case 'templates':
      return { templates: await listProjectTemplatesAs(actor.userId, projectId) };
    case 'template':
      return readProjectTemplateAs(
        actor.userId,
        projectId,
        need(input, 'templateId'),
        String(need(input, 'templateVersion')),
      );
    case 'link':
    case 'unlink': {
      const call = input.action === 'link' ? linkBuildAs : unlinkBuildAs;
      const outcome = await call({
        projectId,
        id: need(input, 'workflowId'),
        actor,
        issue: need(input, 'issue'),
      });
      return outcome.ok ? outcome.design : refusedBy(outcome.refusals);
    }
  }
}

export const forgeWorkflowsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_workflows',
  reach: 'project',
  grant: GRANTS,
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: (args) => run(args, ctx),
});
