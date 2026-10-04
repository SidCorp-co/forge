import { z } from 'zod';
import { assistantWeeklySchema } from './agent-config-schema.js';
import {
  refuseRetiredProjectFields,
  refuseRetiredProjectKeys,
  undeclaredFieldError,
} from './retired-project-keys.js';

const createProjectFields = {
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, or hyphens')
    .min(3)
    .max(64),
  name: z.string().trim().min(1).max(200),
  orgId: z.uuid().optional(),
};

export const createProjectSchema = z.strictObject(createProjectFields, {
  error: undeclaredFieldError('POST /api/projects', Object.keys(createProjectFields)),
});

export const createProjectBodySchema = z
  .unknown()
  .superRefine(refuseRetiredProjectFields)
  .pipe(createProjectSchema);

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

const updateProjectFields = {
  issuePrefix: z.string().trim().max(16).nullable().optional(),
  assistantWeekly: assistantWeeklySchema.nullable().optional(),
  // Move the project to another org. Requires org owner/admin on BOTH the
  // current org (route gate) and the target org (checked in the handler).
  orgId: z.uuid().optional(),
};

const undeclaredProjectField = undeclaredFieldError(
  'PATCH /api/projects/:id',
  Object.keys(updateProjectFields),
);

export const updateProjectSchema = z
  .strictObject(updateProjectFields, {
    error: (issue) => {
      const named = undeclaredProjectField(issue);
      return named === undefined
        ? undefined
        : `${named} Where a project's work lands, its environments, promotions and deployments are its project document: read GET /api/projects/:id/config and write PUT /api/projects/:id/config.`;
    },
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

export const updateProjectPatchSchema = z
  .unknown()
  .superRefine(refuseRetiredProjectKeys)
  .pipe(updateProjectSchema);

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
