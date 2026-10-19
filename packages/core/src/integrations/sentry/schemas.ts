import { z } from 'zod';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from '../release-channel-schema.js';

const sentryTargetSchema = z.object({
  label: z.string().min(1).max(120),
  organizationSlug: z.string().min(1).max(200).optional(),
  projectSlug: z.string().min(1).max(200).optional(),
  environment: z.string().min(1).max(120).optional(),
  notes: z.string().max(2000).optional(),
});

/** One label names one Sentry project within a binding; a second would leave a read to guess. */
const sentryTargetsSchema = z
  .array(sentryTargetSchema)
  .max(50)
  .superRefine((targets, ctx) => {
    const seen = new Set<string>();
    for (const t of targets) {
      if (seen.has(t.label)) {
        ctx.addIssue({
          code: 'custom',
          message: `two Sentry targets are both labelled "${t.label}" — a label names one Sentry project and must be unique within this project's integration`,
        });
        return;
      }
      seen.add(t.label);
    }
  });

/**
 * A key a Sentry connection may not carry, refused by name. A target is what confines an agent to one
 * project's Sentry projects, so it is held by the project's binding: on the shared connection it
 * would be read by every project bound to it (ISS-1380).
 */
const refusedOnConnection = (key: string, say: string) =>
  z.never({ error: `\`${key}\` is not connection config for Sentry: ${say}` }).optional();

const TARGETS_LIVE_ON_THE_BINDING =
  "Sentry targets belong to a project's integration, never to the connection it shares, so one project's agents cannot name another's. Send `targets` with the project's integration (PATCH /api/projects/:projectId/integrations/:id, or when binding the connection).";
const SLUGS_LIVE_IN_A_TARGET =
  "a target carries its own `organizationSlug` and `projectSlug`: send `targets: [{ label, organizationSlug, projectSlug }]` with the project's integration.";

const sentryShape = { host: z.string().min(1).max(255), ...releaseChannelFields };

/** The body of a project-side create or PATCH: both tiers, split by `SENTRY_BINDING_CONFIG_KEYS`. */
export const sentryConfigBase = z.object({
  ...sentryShape,
  targets: sentryTargetsSchema.optional(),
  organizationSlug: refusedOnConnection('organizationSlug', SLUGS_LIVE_IN_A_TARGET),
  projectSlug: refusedOnConnection('projectSlug', SLUGS_LIVE_IN_A_TARGET),
});

/** What the shared connection itself may hold: where Sentry is, and nothing that names a project. */
export const sentryConnectionConfig = z.object({
  ...sentryShape,
  targets: refusedOnConnection('targets', TARGETS_LIVE_ON_THE_BINDING),
  organizationSlug: refusedOnConnection('organizationSlug', SLUGS_LIVE_IN_A_TARGET),
  projectSlug: refusedOnConnection('projectSlug', SLUGS_LIVE_IN_A_TARGET),
});

export const sentrySecretsSchema = z.object({
  authToken: z.string().min(8).max(2000),
});

export const SENTRY_BINDING_CONFIG_KEYS = ['targets', ...RELEASE_CHANNEL_KEYS] as const;
