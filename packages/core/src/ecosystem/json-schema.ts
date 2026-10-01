import { emitJsonSchema } from '../project-config/json-schema.js';
import { SCHEMA_BASE } from '../project-config/schema.js';
import {
  DOCUMENT_SCHEMA_ID,
  documentSchema,
  HOLD_SCHEMA_ID,
  holdSchema,
} from './channel-schema.js';
import { CONTRACT_VERSION_SCHEMA_ID, contractVersionSchema } from './contract/version-schema.js';
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
  'document-v1.json': emitJsonSchema(documentSchema, DOCUMENT_SCHEMA_ID),
  'hold-v1.json': emitJsonSchema(holdSchema, HOLD_SCHEMA_ID),
  'contract-version-v1.json': emitJsonSchema(contractVersionSchema, CONTRACT_VERSION_SCHEMA_ID),
};
