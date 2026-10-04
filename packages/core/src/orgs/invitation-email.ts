import { mailDeliveryEnabled, sendMail } from '../integrations/mail/index.js';
import { buildInvitationLink, escapeInvitationHtml } from '../lib/invitation.js';
import { logger } from '../observability/logger.js';

export interface OrgInvitationEmailContext {
  orgName: string;
  inviterEmail: string;
  token: string;
}

/** The project invitation's transport and link landing; `kind=org` selects the org accept endpoint on the web accept page. */
export async function sendOrgInvitationEmail(
  to: string,
  ctx: OrgInvitationEmailContext,
): Promise<void> {
  const link = `${buildInvitationLink(ctx.token)}&kind=org`;

  if (!mailDeliveryEnabled()) {
    logger.info({ to, link }, 'org invitation (debug/no-SMTP — not sent)');
    return;
  }

  const subject = `You're invited to join ${ctx.orgName} on Forge`;
  const bodyText = `${ctx.inviterEmail} invited you to join the "${ctx.orgName}" organization on Forge.\n\nAccept the invitation by opening this link (valid for 7 days):\n\n${link}\n`;
  const safeOrgName = escapeInvitationHtml(ctx.orgName);
  const safeInviterEmail = escapeInvitationHtml(ctx.inviterEmail);
  const safeLink = escapeInvitationHtml(link);
  const bodyHtml = `<p><strong>${safeInviterEmail}</strong> invited you to join the "<strong>${safeOrgName}</strong>" organization on Forge.</p><p>Accept the invitation by opening this link (valid for 7 days):</p><p><a href="${safeLink}">${safeLink}</a></p>`;

  await sendMail({
    to,
    subject,
    text: bodyText,
    html: bodyHtml,
  });
}
