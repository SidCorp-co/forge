/**
 * `forge_workflows` — the master's face of its project's workflows: draw them, propose a design,
 * read the approver's decision, and name the issues that build one. The REST routes in
 * `workflows/routes.ts` are the same services; this face only carries the principal across.
 */

import { DESIGN_VIEWS } from '@forge/contracts/workflows';
import { z } from 'zod';
import { guideRef } from '../../guides/guide-ref.js';
import { egressShown } from '../../lib/data-egress.js';
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
  designActAnswerOf,
  designStepsOf,
  designSummaryOf,
  workflowSummaryOf,
  workflowWriteAnswerOf,
} from '../../workflows/projection.js';
import {
  createWorkflow,
  listWorkflowsAs,
  readWorkflowAs,
  updateWorkflow,
  type WorkflowWriter,
  workflowView,
} from '../../workflows/service.js';
import { readSystemGraphAs } from '../../workflows/system-graph-read.js';
import { listProjectTemplatesAs, readProjectTemplateAs } from '../../workflows/template-service.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  principalAgency,
  refusedAnswer,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';
import { projectMany, projectOne, summaryNotice, VIEW_RULE } from './projection.js';

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
      'system_graph',
    ]),
    projectId: z.uuid().optional(),
    workflowId: z.uuid().optional(),
    /** write: the revision the document is based on; null creates a workflow. */
    baseRevision: z.number().int().min(1).nullable().optional(),
    document: z.unknown().optional(),
    /** propose / decide: the revision proposed, or the one being decided; system_graph: the one read. */
    revision: z.number().int().min(1).optional(),
    /** system_graph: a revision whose removed steps are drawn too. */
    against: z.number().int().min(1).optional(),
    decision: z.enum(DESIGN_DECISIONS).optional(),
    reason: z.string().max(DESIGN_REASON_MAX).optional(),
    /** link / unlink: the issue that builds the workflow; propose: the issue the design is drawn under. By key (ISS-12) or uuid. */
    issue: z.string().trim().min(1).max(200).optional(),
    /** template: the diagram template to read, by id and version. */
    templateId: z.string().trim().min(1).max(64).optional(),
    templateVersion: z.number().int().min(1).optional(),
    view: z.enum(DESIGN_VIEWS).optional(),
    stepFrom: z.number().int().min(1).optional(),
    stepTo: z.number().int().min(1).optional(),
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
    system_graph: 'projects:read',
  },
} as const;

const DESCRIPTION =
  "Draw this project's workflows and take a design to its approver before anything is built from " +
  'it. Actions: list | get | design | write | propose | decide | link | unlink | templates | template | system_graph. ' +
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
  "`refs` [{ template, flow, step }] link steps of the project's other designs; `basedOn` " +
  '[{ workflow, revision }] names the designs it builds on, each a flow this project holds at a revision it held ' +
  '(WORKFLOW_BASE_SELF, WORKFLOW_BASE_UNKNOWN, WORKFLOW_BASE_DUPLICATE); `edges` carry ' +
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
  'revision with its decision, reason and step count (no document), the approved revision, and the issues ' +
  "that build it; view: 'steps' adds one revision's steps ({ revision? (the newest by default), stepFrom?, " +
  "stepTo? } numbered from 1, with the edges that touch them); view: 'full' answers every revision with its whole document. " +
  'system_graph: { workflowId, revision?, against? } — a system-context design read as its C4 graph: nodes ' +
  '(person, system, container, external, with the integration state an external label states), relationships ' +
  'with their own label and technology, boundaries per lane and side, and the header facts; `against` draws the ' +
  'steps that revision held and this one removed, marked removed (SYSTEM_GRAPH_NOT_SYSTEM_CONTEXT, ' +
  'SYSTEM_GRAPH_REVISION_UNKNOWN). ' +
  'list answers each workflow as { workflowId, flow, title, kind, template, status, revision, approvedRevision, ' +
  'stepCount, edgeCount, returnReason, writerName, updatedAt }; get answers the whole current document. ' +
  'write answers { workflowId, flow, revision, created, status, approvedRevision, stepCount, edgeCount, ' +
  'updatedAt }; propose and decide answer the design head and the revision acted on, link and unlink the ' +
  'head and the issues that build it. ' +
  VIEW_RULE +
  ' ' +
  'decide: { workflowId, revision, decision: approve|return, reason } — only the approver the ' +
  "project's `workflows.designApprover` names: `owner` (default) is an org admin person, and an " +
  "agent is refused WORKFLOW_DESIGN_APPROVER_NOT_PERSON; `master` lets this project's own master " +
  'decide too. A return carries its reason. Approving is refused WORKFLOW_DESIGN_BASE_UNAPPROVED while a ' +
  'design the revision declares in `basedOn` is not approved at the revision it names, naming each base and its state. ' +
  'link: { workflowId, issue } names the issue that builds the workflow; dispatching that issue is ' +
  'then refused WORKFLOW_DESIGN_NOT_APPROVED until the design is approved, and forge_issues get ' +
  'shows why under `buildsWorkflow`. unlink lifts the gate, so only the approver may. ' +
  `Guides: ${guideRef('workflow-templates')} (which template to pick) and ${guideRef('workflow-design')}.`;

function answerView(input: Input) {
  if (input.view === 'steps' && input.action !== 'design') {
    throw new Error(
      `BAD_REQUEST: view 'steps' reads a design; ${input.action} takes view summary or full`,
    );
  }
  if ((input.stepFrom !== undefined || input.stepTo !== undefined) && input.view !== 'steps') {
    throw new Error(
      "BAD_REQUEST: stepFrom and stepTo bound view 'steps'; send view: 'steps' with them",
    );
  }
  return input.view === 'steps' ? undefined : input.view;
}

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
  const view = answerView(input);
  const what = input.workflowId ? `workflow ${input.workflowId}` : 'the workflows';
  const shown = <T>(value: T) => egressShown(projectId, 'design', value, what);
  switch (input.action) {
    case 'list':
      return {
        workflows: projectMany(
          view,
          await shown(await listWorkflowsAs(actor.userId, projectId)),
          workflowSummaryOf,
        ),
        ...summaryNotice(
          view,
          "get { workflowId } for one workflow's whole document, or view: 'full'",
        ),
      };
    case 'get': {
      const read = await shown(
        await readWorkflowAs(actor.userId, projectId, need(input, 'workflowId')),
      );
      return input.view === 'summary' ? workflowSummaryOf(read) : read;
    }
    case 'design': {
      const design = await shown(await readDesignAs(actor, projectId, need(input, 'workflowId')));
      if (input.view === 'full') return design;
      if (input.view === 'steps') {
        return designStepsOf(design, {
          revision: input.revision,
          from: input.stepFrom,
          to: input.stepTo,
        });
      }
      return {
        ...designSummaryOf(design),
        ...summaryNotice(
          view,
          "view: 'steps' with revision and stepFrom / stepTo for a revision's steps, or view: 'full'",
        ),
      };
    }
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
      return projectOne(
        view,
        await shown({ ...workflowView(outcome.row, outcome.document), created: outcome.created }),
        (full) => workflowWriteAnswerOf(full, full.created),
      );
    }
    case 'propose': {
      const outcome = await proposeDesign({
        projectId,
        id: need(input, 'workflowId'),
        writer: actor,
        revision: need(input, 'revision'),
        issue: input.issue,
      });
      if (!outcome.ok) return refusedBy(outcome.refusals);
      return projectOne(view, await shown(outcome.design), (d) =>
        designActAnswerOf(d, 'propose', input.revision),
      );
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
      if (!outcome.ok) return refusedBy(outcome.refusals);
      return projectOne(view, await shown(outcome.design), (d) =>
        designActAnswerOf(d, 'decide', input.revision),
      );
    }
    case 'templates':
      return { templates: await listProjectTemplatesAs(actor.userId, projectId) };
    case 'system_graph': {
      const outcome = await readSystemGraphAs({
        userId: actor.userId,
        projectId,
        workflowId: need(input, 'workflowId'),
        revision: input.revision,
        against: input.against,
      });
      if (!outcome.ok) return refusedBy(outcome.refusals);
      return shown(outcome.graph);
    }
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
      if (!outcome.ok) return refusedBy(outcome.refusals);
      return projectOne(view, await shown(outcome.design), (d) =>
        designActAnswerOf(d, input.action as 'link' | 'unlink'),
      );
    }
  }
}

export const forgeWorkflowsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_workflows',
  reach: 'project',
  route: '/api/projects',
  grant: GRANTS,
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: (args) => run(args, ctx),
});
