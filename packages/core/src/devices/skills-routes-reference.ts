import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';

export const projectQuerySchema = z.object({
  projectId: z.uuid(),
  includeFiles: z.string().optional(),
});

export const contentQuerySchema = z.object({ projectId: z.uuid() });

export const contentParamSchema = z.object({ skillId: z.uuid() });

export const reportBodySchema = z
  .object({
    skills: z
      .array(
        z
          .object({
            skillId: z.uuid(),
            installedHash: z.string().min(1).max(128),
            installedVersion: z.number().int().nonnegative().optional(),
            observedSha: z.string().min(1).max(128).optional(),
            shadowedBy: z.string().max(1024).optional(),
          })
          .strict(),
      )
      .max(500),
    pruned: z.array(z.string().min(1).max(128)).max(500).optional(),
  })
  .strict();

export const syncFailedBodySchema = z.object({ error: z.string().min(1).max(2000) }).strict();

export const statusParamSchema = z.object({ projectId: z.uuid(), deviceId: z.uuid() });

const skillFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']),
});

const manifestEntrySchema = z.object({
  skillId: z.string(),
  name: z.string(),
  version: z.number(),
  effectiveHash: z.string(),
});

/** `skillMd` and `files` are present only when the request asked for `includeFiles`. */
export const skillManifestSchema = z.object({
  skills: z.array(
    manifestEntrySchema.extend({
      skillMd: z.string().optional(),
      files: z.array(skillFileSchema).optional(),
    }),
  ),
});

export const skillContentSchema = manifestEntrySchema.extend({
  skillMd: z.string(),
  files: z.array(skillFileSchema),
});

export const skillStatusSchema = z.object({
  skills: z.array(
    z.object({
      skillId: z.string(),
      name: z.string(),
      effectiveHash: z.string(),
      installedHash: z.string().nullable(),
      installedVersion: z.number().nullable(),
      syncedAt: z.string().nullable(),
      observedSha: z.string().nullable(),
      shadowedBy: z.string().nullable(),
      status: z.enum(['synced', 'outdated', 'missing', 'unknown', 'shadowed', 'stale']),
    }),
  ),
});

export const okSchema = z.object({ ok: z.literal(true) });

export const skillReportSchema = z.object({ upserted: z.number(), pruned: z.number() });

const deviceRefusals = {
  401: fail('UNAUTHENTICATED', 'the device is revoked'),
  403: fail('FORBIDDEN', 'the device is not bound to the project'),
} as const;

export const readSkillManifest = describeOperation({
  summary: "Read a project's effective skills with the hash each should have on this device",
  responses: { 200: json(skillManifestSchema), ...deviceRefusals },
});

export const readSkillContent = describeOperation({
  summary: 'Read the full body of one skill registered to a project',
  responses: {
    200: json(skillContentSchema),
    ...deviceRefusals,
    404: fail('NOT_FOUND', 'the skill is not registered to the project'),
  },
});

export const reportInstalledSkills = describeOperation({
  summary: 'Report the skill hashes the device installed, and the skills it pruned by name',
  responses: { 200: json(skillReportSchema), ...deviceRefusals },
});

export const reportSkillSyncFailed = describeOperation({
  summary:
    'Report that a skill sync failed on this device; repeating the same reason records nothing new',
  responses: { 200: json(okSchema), ...deviceRefusals },
});

export const readDeviceSkillStatus = describeOperation({
  summary:
    'Read, per registered skill, whether one device has it synced, outdated, missing, shadowed or stale',
  responses: {
    200: json(skillStatusSchema),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
  },
});
