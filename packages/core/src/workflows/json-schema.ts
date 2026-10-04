import {
  projectWorkflowTemplateSchema,
  WORKFLOW_TEMPLATE_SCHEMA_ID,
} from '@forge/contracts/workflow-templates';
import { emitJsonSchema } from '../project-config/index.js';
import { WORKFLOW_V2_SCHEMA_ID, workflowDocumentV2Schema } from './schema.js';

export const workflowJsonSchemas: Readonly<Record<string, object>> = {
  'workflow-v2.json': emitJsonSchema(workflowDocumentV2Schema, WORKFLOW_V2_SCHEMA_ID),
  'workflow-template-v1.json': emitJsonSchema(
    projectWorkflowTemplateSchema,
    WORKFLOW_TEMPLATE_SCHEMA_ID,
  ),
};
