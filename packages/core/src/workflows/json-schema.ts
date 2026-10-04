import {
  projectWorkflowTemplateSchema,
  WORKFLOW_TEMPLATE_SCHEMA_ID,
} from '@forge/contracts/workflow-templates';
import { emitJsonSchema } from '../project-config/index.js';
import {
  WORKFLOW_SCHEMA_ID,
  WORKFLOW_V2_SCHEMA_ID,
  workflowDocumentSchema,
  workflowDocumentV2Schema,
} from './schema.js';

export const workflowJsonSchemas: Readonly<Record<string, object>> = {
  'workflow-v1.json': emitJsonSchema(workflowDocumentSchema, WORKFLOW_SCHEMA_ID),
  'workflow-v2.json': emitJsonSchema(workflowDocumentV2Schema, WORKFLOW_V2_SCHEMA_ID),
  'workflow-template-v1.json': emitJsonSchema(
    projectWorkflowTemplateSchema,
    WORKFLOW_TEMPLATE_SCHEMA_ID,
  ),
};
