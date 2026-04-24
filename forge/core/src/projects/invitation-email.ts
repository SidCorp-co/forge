import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

let transport: Transporter | null = null;

function getTransport(): Transporter {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }
  return transport;
}

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

  if (env.SMTP_DEBUG) {
    logger.info({ to, link }, 'project invitation (debug — not sent)');
    return;
  }

  const subject = `You're invited to join ${ctx.projectName}`;
  const bodyText = `${ctx.inviterEmail} invited you to join the "${ctx.projectName}" project on Forge.\n\nAccept the invitation by opening this link (valid for 7 days):\n\n${link}\n`;
  const safeProjectName = escapeHtml(ctx.projectName);
  const safeInviterEmail = escapeHtml(ctx.inviterEmail);
  const safeLink = escapeHtml(link);
  const bodyHtml = `<p><strong>${safeInviterEmail}</strong> invited you to join the "<strong>${safeProjectName}</strong>" project on Forge.</p><p>Accept the invitation by opening this link (valid for 7 days):</p><p><a href="${safeLink}">${safeLink}</a></p>`;

  await getTransport().sendMail({
    from: env.SMTP_FROM,
    to,
    subject,
    text: bodyText,
    html: bodyHtml,
  });
}

export function __resetTransportForTests(): void {
  transport = null;
}
