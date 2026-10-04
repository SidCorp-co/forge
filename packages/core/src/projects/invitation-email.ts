import { mailDeliveryEnabled, sendMail } from '../integrations/mail/index.js';
import { buildInvitationLink, escapeInvitationHtml } from '../lib/invitation.js';
import { logger } from '../observability/logger.js';

interface InvitationEmailContext {
  projectName: string;
  inviterEmail: string;
  token: string;
}

export async function sendInvitationEmail(to: string, ctx: InvitationEmailContext): Promise<void> {
  const link = buildInvitationLink(ctx.token);

  if (!mailDeliveryEnabled()) {
    logger.info({ to, link }, 'project invitation (debug/no-SMTP — not sent)');
    return;
  }

  const subject = `You're invited to join ${ctx.projectName}`;
  const bodyText = `${ctx.inviterEmail} invited you to join the "${ctx.projectName}" project on Forge.\n\nAccept the invitation by opening this link (valid for 7 days):\n\n${link}\n`;
  const safeProjectName = escapeInvitationHtml(ctx.projectName);
  const safeInviterEmail = escapeInvitationHtml(ctx.inviterEmail);
  const safeLink = escapeInvitationHtml(link);
  const bodyHtml = `<p><strong>${safeInviterEmail}</strong> invited you to join the "<strong>${safeProjectName}</strong>" project on Forge.</p><p>Accept the invitation by opening this link (valid for 7 days):</p><p><a href="${safeLink}">${safeLink}</a></p>`;

  await sendMail({
    to,
    subject,
    text: bodyText,
    html: bodyHtml,
  });
}
