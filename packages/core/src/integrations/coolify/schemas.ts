/**
 * The shapes a Coolify connection and binding are allowed to hold.
 *
 * ISS-1071 moved them out of `provider-schemas.ts` and beside the provider's client, confirm and
 * health-gate modules, the way `google/schemas.ts` already sat. Nothing outside this directory
 * names `coolify` any more: the adapter's declaration carries these, and the generic create and
 * PATCH paths resolve them from the registry.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from '../release-channel-schema.js';

const coolifyTargetSchema = z
  .object({
    id: z.string().min(1).max(64).optional(),
    label: z.string().min(1).max(100),
    resourceUuid: z.string().min(1).max(200),
    healthUrl: z.string().url().max(500).optional(),
  })
  .transform((t) => ({
    id: t.id ?? randomUUID(),
    label: t.label,
    resourceUuid: t.resourceUuid,
    ...(t.healthUrl ? { healthUrl: t.healthUrl } : {}),
  }));

export const COOLIFY_ROLLBACK_MODE = 'coolify-image' as const;

const COOLIFY_ROLLBACK_PROSE_REFUSAL =
  'rollback on a Coolify binding is an action, not a paragraph: Coolify exposes `GET /applications/{uuid}/rollback-images` and `POST /applications/{uuid}/rollback`, and Forge performs them. Send {"mode":"coolify-image"}. Free text is kept only for channels whose API cannot express a rollback (ISS-925).';

/**
 * The Coolify override of `releaseChannelFields.rollback`. Written as a hand rolled refinement
 * rather than a zod object so the refusal of the OLD prose value is a sentence naming the
 * replacement, not `expected object, received string`.
 */
const coolifyRollbackSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string') {
      ctx.addIssue({ code: 'custom', message: COOLIFY_ROLLBACK_PROSE_REFUSAL });
      return;
    }
    const ok =
      typeof value === 'object' &&
      Object.keys(value).length === 1 &&
      (value as { mode?: unknown }).mode === COOLIFY_ROLLBACK_MODE;
    if (!ok) {
      ctx.addIssue({
        code: 'custom',
        message: 'rollback must be exactly {"mode":"coolify-image"}',
      });
    }
  })
  .transform((value) => value as { mode: typeof COOLIFY_ROLLBACK_MODE } | undefined)
  .optional();

export const coolifyConfigSchema = z.object({
  baseUrl: z.string().url().max(500),
  targets: z
    .array(coolifyTargetSchema)
    .min(1)
    .max(20)
    .superRefine((targets, ctx) => {
      const seen = new Set<string>();
      for (const t of targets) {
        if (seen.has(t.label)) {
          ctx.addIssue({
            code: 'custom',
            message: `two deploy targets are both labelled "${t.label}" — a label names one application and must be unique within this binding`,
          });
          return;
        }
        seen.add(t.label);
      }
    }),
  ...releaseChannelFields,
  rollback: coolifyRollbackSchema,
});

export const coolifySecretsSchema = z.object({
  apiToken: z.string().min(8).max(2000),
});

export const COOLIFY_BINDING_CONFIG_KEYS = ['targets', ...RELEASE_CHANNEL_KEYS] as const;
