import { env } from '../config/env.js';
import { mailDeliveryEnabled, sendMail } from '../integrations/identity/index.js';
import { logger } from '../observability/logger.js';

function buildVerificationLink(token: string): string {
  // Link must hit the API origin (where /api/auth/verify lives), NOT the web
  // origin. With subdomain-split deploys (web=forge-beta.example.com,
  // api=forge-beta-api.example.com) APP_BASE_URL is the web URL, so we fall
  // through to OAUTH_REDIRECT_BASE which already names the API origin.
  // Single-origin deploys leave OAUTH_REDIRECT_BASE unset → APP_BASE_URL.
  const apiBase = (env.OAUTH_REDIRECT_BASE ?? env.APP_BASE_URL).replace(/\/+$/, '');
  return `${apiBase}/api/auth/verify?token=${encodeURIComponent(token)}`;
}

export async function sendVerificationEmail(to: string, token: string): Promise<void> {
  const link = buildVerificationLink(token);

  if (!mailDeliveryEnabled()) {
    logger.info({ to, link }, 'email verification (debug/no-SMTP — not sent)');
    return;
  }

  await sendMail({
    to,
    subject: 'Verify your email',
    text: `Verify your email by opening this link (valid for 24 hours):\n\n${link}\n`,
    html: `<p>Verify your email by opening this link (valid for 24 hours):</p><p><a href="${link}">${link}</a></p>`,
  });
}
