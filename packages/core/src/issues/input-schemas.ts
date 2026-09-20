/**
 * The two input shapes `issueCreateSchema` and `issuePatchSchema` are built from, split out of
 * `routes.ts` on size grounds. Definitions only — nothing here reads a request or the database.
 */

import { z } from 'zod';

export const attachmentInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    mime: z.string().min(1).max(255),
    dataBase64: z.string().min(1),
  })
  .strict();

export const labelAttachItemSchema = z.union([
  z.string().trim().min(1),
  z
    .object({
      labelId: z.string().trim().min(1),
      isPrimary: z.boolean().optional(),
    })
    .strict(),
]);
