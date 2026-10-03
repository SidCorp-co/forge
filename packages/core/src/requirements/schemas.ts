import { z } from 'zod';
import { CRITERION_FORMS } from '../db/schema-requirements.js';

export const specSchema = z.strictObject({
  goal: z.string().max(20_000).optional(),
  personas: z.array(z.string().max(500)).max(50).optional(),
  scopeIn: z.array(z.string().max(2_000)).max(100).optional(),
  scopeOut: z.array(z.string().max(2_000)).max(100).optional(),
});

export const criterionSchema = z.strictObject({
  code: z
    .string()
    .regex(/^BC-[1-9][0-9]*$/, 'a criterion code reads BC-n')
    .optional(),
  body: z.string().trim().min(1).max(10_000),
  form: z.enum(CRITERION_FORMS).optional(),
});
