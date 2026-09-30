import { z } from 'zod';
import {
  bindingDocumentSchema,
  environmentStateSchema,
  policyDocumentSchema,
  projectDocumentSchema,
  SCHEMA_BASE,
  testingProfileSchema,
} from './schema.js';

export type ProjectConfigSchemaName =
  | 'project'
  | 'policy'
  | 'testing-profile'
  | 'binding'
  | 'environment-state';

const SOURCES: Record<ProjectConfigSchemaName, z.ZodType> = {
  project: projectDocumentSchema,
  policy: policyDocumentSchema,
  'testing-profile': testingProfileSchema,
  binding: bindingDocumentSchema,
  'environment-state': environmentStateSchema,
};

export function schemaId(name: ProjectConfigSchemaName): string {
  return `${SCHEMA_BASE}/${name}-v1.json`;
}

function emit(name: ProjectConfigSchemaName): object {
  return {
    ...z.toJSONSchema(SOURCES[name], {
      target: 'draft-2020-12',
      io: 'input',
      unrepresentable: 'throw',
    }),
    $id: schemaId(name),
  };
}

export const projectConfigJsonSchemas: Record<ProjectConfigSchemaName, object> = {
  project: emit('project'),
  policy: emit('policy'),
  'testing-profile': emit('testing-profile'),
  binding: emit('binding'),
  'environment-state': emit('environment-state'),
};
