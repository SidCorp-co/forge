/**
 * The two input shapes `issueCreateSchema` and `issuePatchSchema` are built from, split out of
 * `routes.ts` on size grounds. Definitions only — nothing here reads a request or the database.
 */

import { z } from 'zod';
import { workSteps } from '../db/schema-issue-work-state.js';

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

/**
 * ISS-54 — the holder's step (`null` ends it), branch and pushed head. The lease is not written
 * here: it is the holder's claim, and stays with the claim verbs.
 */
export const workStatePatchSchema = z
  .object({
    step: z.enum(workSteps).nullable().optional(),
    branch: z.string().trim().min(1).max(255).nullable().optional(),
    headSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/iu, 'a head is the full 40-hex commit sha')
      .nullable()
      .optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: '`workState` names no field to write' });
