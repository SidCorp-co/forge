// What `forge_describe` tells of the design door's writes beyond their guide (REQ-78 BC-3): each
// action's own field texts, the schema its document is written at by a URL that resolves, and one
// call it accepts as written, so a client calls design_create from describe alone.

import { CREATE_SUGGESTION_SHAPE } from '@forge/contracts/suggestions';
import { WORKFLOW_V2_SCHEMA_ID } from '@forge/contracts/workflows';
import { servedSchemaUrl } from '../lib/served-schema.js';
import type { ActionDescribe } from '../lib/tool.js';

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
