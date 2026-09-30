import { emitJsonSchema } from '../project-config/json-schema.js';
import { SCHEMA_BASE } from '../project-config/schema.js';
import {
  ecosystemDocumentSchema,
  interfaceDocumentSchema,
  membershipDocumentSchema,
} from './schema.js';

export const ecosystemJsonSchemas: Readonly<Record<string, object>> = {
  'ecosystem-v1.json': emitJsonSchema(ecosystemDocumentSchema, `${SCHEMA_BASE}/ecosystem-v1.json`),
  'membership-v1.json': emitJsonSchema(
    membershipDocumentSchema,
    `${SCHEMA_BASE}/membership-v1.json`,
  ),
  'interface-v1.json': emitJsonSchema(interfaceDocumentSchema, `${SCHEMA_BASE}/interface-v1.json`),
};
