import { env } from '../config/env.js';
import { mailDeliveryEnabled, sendMail } from '../integrations/mail/index.js';
import { logger } from '../logger.js';

export function buildInvitationLink(token: string): string {
  return `${env.APP_BASE_URL}/invite/accept?token=${encodeURIComponent(token)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface InvitationEmailContext {
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
  const safeProjectName = escapeHtml(ctx.projectName);
  const safeInviterEmail = escapeHtml(ctx.inviterEmail);
  const safeLink = escapeHtml(link);
  const bodyHtml = `<p><strong>${safeInviterEmail}</strong> invited you to join the "<strong>${safeProjectName}</strong>" project on Forge.</p><p>Accept the invitation by opening this link (valid for 7 days):</p><p><a href="${safeLink}">${safeLink}</a></p>`;

  await sendMail({
    to,
    subject,
    text: bodyText,
    html: bodyHtml,
  });
}

export interface OrgInvitationEmailContext {
  orgName: string;
  inviterEmail: string;
  token: string;
}

/** Org-tier variant — same transport/link landing, `kind=org` selects the
 *  org accept endpoint on the web accept page. */
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
  const safeOrgName = escapeHtml(ctx.orgName);
  const safeInviterEmail = escapeHtml(ctx.inviterEmail);
  const safeLink = escapeHtml(link);
  const bodyHtml = `<p><strong>${safeInviterEmail}</strong> invited you to join the "<strong>${safeOrgName}</strong>" organization on Forge.</p><p>Accept the invitation by opening this link (valid for 7 days):</p><p><a href="${safeLink}">${safeLink}</a></p>`;

  await sendMail({
    to,
    subject,
    text: bodyText,
    html: bodyHtml,
  });
}
