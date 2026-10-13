import { z } from 'zod';
import { describeOperation, fail, json, redirect } from '../../api-reference/describe.js';

/** The provider is any string: one the server does not know is refused with a 404, not a 400. */
export const providerParamSchema = z.object({ provider: z.string() });

export const providersSchema = z.object({
  providers: z.array(z.object({ id: z.enum(['github', 'google', 'oidc']), label: z.string() })),
});

const SOCIAL_AUTH_OFF =
  'social sign-in is switched off, so the route does not exist for any caller';

export const listOAuthProviders = describeOperation({
  summary: 'List the sign-in providers this server has configured',
  responses: { 200: json(providersSchema), 404: fail('NOT_FOUND', SOCIAL_AUTH_OFF) },
});

export const startOAuth = describeOperation({
  summary: 'Begin a sign-in with a provider',
  description:
    'Redirects the browser to the provider and sets the short-lived signed state cookie. `redirect` is a same-origin path to return to, and anything else becomes `/projects`.',
  responses: {
    302: redirect("To the provider's authorize page"),
    404: fail({
      NOT_FOUND: `${SOCIAL_AUTH_OFF}, or the provider is not one of github, google, oidc`,
      PROVIDER_NOT_ENABLED: 'the provider is known but not configured on this server',
    }),
  },
});

export const callbackOAuth = describeOperation({
  summary: 'Finish a sign-in: the provider sends the browser back here',
  description:
    'Always a redirect to the web app. Success sets the session cookie and goes to the path `start` was given; a refusal goes to `/login?oauth_error=` with `denied`, `provider_error`, `session_expired` or `email_unverified`. A reauthorization started from `reauth-start` sets no session and returns with `reauth=ok` or `reauth_error=identity_mismatch`.',
  responses: {
    302: redirect('To the web app, with the outcome in the query'),
    403: fail('AGENT_CANNOT_LOGIN', 'the linked account is an agent'),
    404: fail({
      NOT_FOUND: `${SOCIAL_AUTH_OFF}, or the provider is not one of github, google, oidc`,
      PROVIDER_NOT_ENABLED: 'the provider is known but not configured on this server',
    }),
  },
});

export const reauthStartOAuth = describeOperation({
  summary: 'Begin proving identity again through a provider the account is linked to',
  description:
    'Redirects to the provider. An account not linked to this provider is sent back to the settings page with `reauth_error=oauth_not_linked`.',
  responses: {
    302: redirect("To the provider's authorize page, or back to settings when not linked"),
    404: fail({
      NOT_FOUND: `${SOCIAL_AUTH_OFF}, or the provider is not one of github, google, oidc`,
      PROVIDER_NOT_ENABLED: 'the provider is known but not configured on this server',
    }),
  },
});
