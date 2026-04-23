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

export function buildVerificationLink(token: string): string {
  return `${env.APP_BASE_URL}/api/auth/verify?token=${encodeURIComponent(token)}`;
}

export async function sendVerificationEmail(to: string, token: string): Promise<void> {
  const link = buildVerificationLink(token);

  if (env.SMTP_DEBUG) {
    logger.info({ to, link }, 'email verification (debug — not sent)');
    return;
  }

  await getTransport().sendMail({
    from: env.SMTP_FROM,
    to,
    subject: 'Verify your email',
    text: `Verify your email by opening this link (valid for 24 hours):\n\n${link}\n`,
    html: `<p>Verify your email by opening this link (valid for 24 hours):</p><p><a href="${link}">${link}</a></p>`,
  });
}

export function __resetTransportForTests(): void {
  transport = null;
}
