import { z } from 'zod';
import { describeOperation, fail, json } from '../../api-reference/declare/describe.js';
import { noSuchBinding, notProjectAdmin, onProject } from '../routes-reference.js';
import { SENTRY_PROJECTS_MAX } from './projects.js';

/** A host as an operator types it, with or without the scheme and never with a path. */
const sentryHostField = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^(https?:\/\/)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?\/*$/i,
    'a Sentry host without a path, e.g. logs.canawan.com or sentry.io',
  );

const organizationSlugField = z.string().min(1).max(200).optional();

export const sentryProjectsBodySchema = z.union([
  z.object({ integrationId: z.uuid(), organizationSlug: organizationSlugField }).strict(),
  z
    .object({
      host: sentryHostField,
      authToken: z.string().min(8).max(2000),
      organizationSlug: organizationSlugField,
    })
    .strict(),
]);

export const sentryProjectsSchema = z.object({
  projects: z.array(
    z.object({
      organizationSlug: z.string(),
      slug: z.string(),
      name: z.string().nullable(),
      platform: z.string().nullable(),
    }),
  ),
  truncated: z.boolean(),
});

export const listSentryProjectsOperation = onProject(
  describeOperation({
    summary: 'The Sentry projects a token can read, for the target picker',
    description: `Give \`integrationId\` to use the stored token of one of this project's Sentry integrations, or \`host\` and \`authToken\` before anything is saved. \`organizationSlug\` narrows the listing to one organization; without it every organization the token lists is walked. At most ${SENTRY_PROJECTS_MAX} projects, each beside its organization, with \`truncated\` set where Sentry held more. Metadata only: the token is never in the answer. A Sentry failure is refused naming its cause, never answered as an empty list.`,
    responses: {
      200: json(sentryProjectsSchema),
      400: fail('BAD_REQUEST', 'the body names neither an integration nor a host with a token'),
      403: notProjectAdmin,
      404: noSuchBinding,
      409: fail('MISSING_CREDENTIALS', 'the stored connection holds no Sentry host or auth token'),
      424: fail(
        'SENTRY_REFUSED',
        "Sentry did not answer the listing: the message and `details.reason` name why (the token was rejected or lacks scope, Sentry answered an error status, the host is unreachable, or the answer was not a list), and `details.httpStatus` is Sentry's own status where one was reached",
      ),
    },
  }),
);
