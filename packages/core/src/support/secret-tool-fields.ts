// The one secret door's fields in `forge_support`'s flat input (ISS-1328, ISS-1348), beside the
// fields other acts share with it: a promise's environment (ISS-1012) and an issue's key take the
// same names, so each is widened to what both take, and each act's own request judges its shape.

import {
  supportPromiseRequestSchema,
  supportSecretLinkRequestSchema,
} from '@forge/contracts/support';
import { operationsIssuesRequestSchema } from '@forge/contracts/support-operations';
import { z } from 'zod';

export const SECRET_LINK_TOOL_FIELDS = {
  ...supportSecretLinkRequestSchema
    .omit({ thread: true, kind: true, project: true, environment: true, key: true, why: true })
    .partial().shape,
  environment: supportPromiseRequestSchema.shape.environment
    .nullable()
    .optional()
    .describe(
      "promise: the environment by the project's own name for it; secret_link (kind variable): the environment the variable is scoped to, null for every environment",
    ),
  key: z
    .union([
      operationsIssuesRequestSchema.shape.key.unwrap(),
      supportSecretLinkRequestSchema.shape.key.unwrap(),
    ])
    .optional()
    .describe('issues: one issue, by its key; secret_link (kind variable): the variable’s key'),
};
