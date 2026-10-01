import { emitJsonSchema } from '../project-config/json-schema.js';
import { WORKFLOW_SCHEMA_ID, workflowDocumentSchema } from './schema.js';

export const workflowJsonSchemas: Readonly<Record<string, object>> = {
  'workflow-v1.json': emitJsonSchema(workflowDocumentSchema, WORKFLOW_SCHEMA_ID),
};
