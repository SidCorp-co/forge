import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';
import { bindingRoles } from '../db/schema.js';

/** The slug names a project. One that names none is a 404, so any string is a legal request. */
export const webhookSlugParamSchema = z.object({ slug: z.string() });

export const deliveryAcceptedSchema = z.union([
  z.object({
    accepted: z.literal(true),
    handler: z.string().describe('The provider whose adapter took the delivery'),
    role: z.enum(bindingRoles),
    stages: z.array(z.string()),
    deliveryId: z.string(),
    actions: z.number().int(),
    refusal: z
      .string()
      .optional()
      .describe('Present where the adapter took the delivery and declined to act on it'),
  }),
  z.object({
    accepted: z.literal(true),
    handler: z.literal('generic'),
    actions: z.literal(0),
  }),
]);

export const receiveWebhook = describeOperation({
  summary: 'Receive a webhook delivery for a project',
  description:
    "No sign-in: the signature is the credential, an HMAC-SHA256 of the raw body. A request carrying a provider header (for example `X-GitHub-Event`) is checked against the secret of that provider's binding on the project and handled by its adapter; any other request is checked against the project webhook secret in `X-Hub-Signature-256` or `X-Forge-Signature-256`. A delivery refused for its signature is recorded against the bindings it could have been meant for.",
  responses: {
    200: json(deliveryAcceptedSchema, 'The delivery was accepted'),
    400: fail({
      BAD_REQUEST: 'the body is not JSON',
      ADAPTER_NOT_REGISTERED: 'the provider header matches an adapter this server does not hold',
      INTEGRATION_NOT_CONFIGURED: 'the project has no active binding for the provider',
      PROVIDER_DECLARES_NO_SIGNATURE_HEADER: 'the provider names no header its signature rides in',
      WEBHOOK_DISABLED: 'the project has no webhook secret, so generic deliveries are off',
    }),
    401: fail({
      MISSING_SIGNATURE: 'the provider signature header is absent',
      INVALID_SIGNATURE: 'no secret held for the delivery verifies its signature',
    }),
    404: fail('NOT_FOUND', 'no project has this slug'),
    500: fail('HANDLER_FAILED', 'the provider adapter threw while handling the delivery'),
  },
});
