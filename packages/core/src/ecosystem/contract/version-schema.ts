import { z } from 'zod';
import { SCHEMA_BASE } from '../../project-config/schema.js';
import {
  CHANGE_KINDS,
  CHANGE_LEVELS,
  DIFF_TOOLS,
  MAX_CHANGES,
  MEASURED_CLASSIFICATIONS,
} from './diff.js';

export const CONTRACT_VERSION_SCHEMA_ID = `${SCHEMA_BASE}/contract-version-v1.json`;

const sha256 = () => z.string().regex(/^[0-9a-f]{64}$/);

export const contractVersionSchema = z.strictObject({
  $schema: z.literal(CONTRACT_VERSION_SCHEMA_ID),
  version: z.literal(1),
  contract: z.string().regex(/^[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9-]{0,62}$/),
  contractVersion: z.string().min(1).max(40),
  previous: z.string().max(40).nullable().optional(),
  artifact: z.union([
    z.strictObject({ sha256: sha256(), sourceCommit: z.string().regex(/^[0-9a-f]{40}$/) }),
    z.strictObject({ sha256: sha256(), uploadedBy: z.string().min(1) }),
    z.null(),
  ]),
  observedAt: z.iso.datetime({ offset: true }),
  diff: z.strictObject({
    tool: z.enum(DIFF_TOOLS),
    toolVersion: z.string().max(40).optional(),
    classification: z.enum(MEASURED_CLASSIFICATIONS),
    changes: z
      .array(
        z.strictObject({
          element: z.string().min(1).max(200),
          kind: z.enum(CHANGE_KINDS),
          level: z.enum(CHANGE_LEVELS),
          text: z.string().min(1).max(1000),
          check: z.string().max(120).optional(),
        }),
      )
      .max(MAX_CHANGES),
  }),
});

export type ContractVersionDocument = z.infer<typeof contractVersionSchema>;
