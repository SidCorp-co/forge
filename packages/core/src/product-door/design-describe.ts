// What `forge_describe` tells of the design door's writes beyond their guide (REQ-78 BC-3): each
// action's own field texts, the schema its document is written at by a URL that resolves, and one
// call it accepts as written, so a client calls design_create from describe alone.

import { COMMENT_MOCKUP_SHAPE, PROPOSE_MOCKUP_SHAPE } from '@forge/contracts/mockups';
import { CREATE_SUGGESTION_SHAPE, SUGGESTION_STATUSES } from '@forge/contracts/suggestions';
import { WORKFLOW_V2_SCHEMA_ID } from '@forge/contracts/workflows';
import { servedSchemaUrl } from '../lib/served-schema.js';
import type { ActionDescribe } from '../lib/tool.js';
import { DESIGN_DECISIONS } from '../workflows/index.js';

/** The smallest design every built-in check accepts: a state machine with one move. */
export const DESIGN_EXAMPLE_DOCUMENT = {
  $schema: WORKFLOW_V2_SCHEMA_ID,
  version: 2,
  project: '<project uuid>',
  flow: 'order-reorder',
  kind: 'state',
  title: 'Reorder a past order',
  summary: 'A past order becomes a filled cart in one tap.',
  template: { id: 'state-machine', version: 1 },
  steps: [
    { id: 'start', does: 'A past order is shown.', after: [], node: { type: 'INITIAL' } },
    {
      id: 'filled',
      does: 'The cart holds the past order’s items.',
      after: ['start'],
      node: { type: 'FINAL', label: 'Cart filled' },
    },
  ],
  edges: [{ kind: 'transition', from: 'start', to: 'filled', label: 'Reorder tapped' }],
} as const;

/** design_create's and design_revise's own describe, with the schema URL of the core serving it. */
export function designDescribe(): Record<string, ActionDescribe> {
  const schema = servedSchemaUrl('workflow-v2.json');
  const document = `document is a workflow-v2 document (its JSON schema: ${schema}), its $schema exactly "${WORKFLOW_V2_SCHEMA_ID}", an identifier and not where it is read`;
  return {
    design_create: {
      documentSchema: schema,
      fields: {
        body: `{ baseRevision: null, document }: ${document}. project is this project's id; template is one template_list answers, which decides the node types and edge kinds each step and edge takes. Leave id, createdAt, updatedAt and writtenBy out: the server fills them`,
      },
      example: {
        projectId: '<project uuid>',
        body: { baseRevision: null, document: DESIGN_EXAMPLE_DOCUMENT },
      },
    },
    design_revise: {
      documentSchema: schema,
      fields: {
        workflowId: 'the design to write the next revision of',
        body: `{ baseRevision, document, issue? }: the whole document, as design_get { view: full } read it, with the revision you read as baseRevision; ${document}. Its id, createdAt and updatedAt are the server's, dropped and listed in the answer's ignored; issue names the issue the revision is drawn under`,
      },
      example: {
        projectId: '<project uuid>',
        workflowId: '<workflow uuid>',
        body: {
          baseRevision: 1,
          document: { ...DESIGN_EXAMPLE_DOCUMENT, summary: 'A past order becomes a cart.' },
        },
      },
    },
    design_propose: {
      example: {
        projectId: '<project uuid>',
        workflowId: '<workflow uuid>',
        revision: 2,
        issue: 'ISS-12',
      },
    },
    template_list: {
      example: { projectId: '<project uuid>' },
    },
    suggestion_create: {
      fields: { body: CREATE_SUGGESTION_SHAPE },
      example: {
        projectId: '<project uuid>',
        body: {
          kind: 'duplicate',
          requirement: 'REQ-2',
          baseRevision: null,
          payload: { duplicateOf: 'REQ-1' },
          rationale: 'Both ask for reordering a past order.',
        },
      },
    },
  };
}

/** The design door's guide: every action, its input and what it answers. */
export const DESIGN_DESCRIPTION = `What the product is designed as, and the decisions on it: workflow designs, suggestions and mockups. Reading is open to anyone on the project; a decision (approve, return, accept, reject) is the act of whoever holds its permission — workflow-designs.approve, suggestions.approve, mockups — and the service refuses anyone else by name. Decide only what the person asked you to.
Workflow designs:
- design_list { projectId, view? }: every workflow with its design status, revision, approved revision and health.
- design_get { projectId, workflowId, view?: summary | steps | full, revision?, stepFrom?, stepTo? }: one design, whom it waits on, and \`progress\`: each issue building it, whether an agent works on it now, and when it is likely done. It reads the design as it stands, a draft never proposed included: \`current\` is the working document at its revision (full carries it whole), and steps reads it unless revision names a proposed one.
- template_list { projectId }: the diagram templates a design may be drawn in, the built-ins and the project's own: each one's id, version, what it is for, its node types and its edge kinds.
- design_create { projectId, body: { baseRevision: null, document } }: a new workflow design at revision 1, as a draft; its document is workflow-v2, drawn in a template template_list names.
- design_revise { projectId, workflowId, body: { baseRevision, document, issue? } }: the next revision of a design, written whole on the revision you read.
- design_propose { projectId, workflowId, revision, issue? }: propose a revision for approval.
- design_decide { projectId, workflowId, revision, decision: ${DESIGN_DECISIONS.join(' | ')}, reason? }: a return says why.
- design_withdraw { projectId, workflowId, reason? }: take back a design no revision of which was approved; it leaves the list and Needs you. An approved design is refused DESIGN_WITHDRAW_APPROVED, one another live design names in basedOn DESIGN_WITHDRAW_PINNED.
Suggestions (on a requirement, issue, feedback item or workflow):
- suggestion_list { projectId, requirement? | issue? | feedback? | workflow?, status?: [${SUGGESTION_STATUSES.join(', ')}], view? }: summaries; view full reads each payload, a breakdown's slices among them.
- suggestion_create { projectId, body: ${CREATE_SUGGESTION_SHAPE} }.
- suggestion_accept { projectId, suggestionId, reason? }: accepting writes what it suggests. Accepting a breakdown files its issues at draft: that is how a requirement becomes delivery work, so read every slice before you accept.
- suggestion_reject { projectId, suggestionId, reason }, suggestion_revise { projectId, suggestionId, payload, reason } (rejects the original, proposes yours), suggestion_withdraw { projectId, suggestionId } (its producer only).
Mockups (MK-n): a screen or call proposed on the requirement, feedback item or issue it shapes, for a person to try, comment on and accept or return; never a local file. Method: GET /api/guides/mockups.md.
- mockup_list { projectId, requirement | feedback | issue }, mockup_get { projectId, mockup }, mockup_comments { projectId, mockup }: every comment on it and its earlier revisions, with where each points.
- mockup_propose { projectId, body: ${PROPOSE_MOCKUP_SHAPE} }. An HTML page is one self-contained file (inline CSS, scripts, data: images; only Google Fonts and cdnjs, jsdelivr or unpkg libraries load): it runs sandboxed and calls nothing. A returned one is answered by proposing it again with revises, settling each comment you addressed.
- mockup_comment { projectId, mockup, body: ${COMMENT_MOCKUP_SHAPE} }.
- mockup_accept { projectId, mockup, reason? } (an accepted requirement mockup is pinned by the next agree or re-pin), mockup_return { projectId, mockup, reason }, mockup_withdraw { projectId, mockup }.`;
