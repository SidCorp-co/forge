import { z } from 'zod';

// cm:why read by `release-batch/approvals.ts` (approval) and `release-batch/version.ts` (prerelease)
export const releaseRuleSchema = z.strictObject({
  approval: z.strictObject({ required: z.boolean() }),
  prerelease: z
    .strictObject({
      of: z.string().regex(/^\d{1,9}\.\d{1,9}\.\d{1,9}$/, 'MAJOR.MINOR.PATCH, e.g. 0.4.0'),
      label: z
        .string()
        .regex(/^[a-z][a-z0-9]{0,15}$/, 'a lower-case word of at most 16 characters, e.g. dev'),
    })
    .optional(),
});
