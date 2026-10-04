import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

let transport: Transporter | null = null;

function getTransport(): Transporter {
  if (!transport) {
    if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_USER || !env.SMTP_PASS) {
      throw new Error('SMTP not configured');
    }
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }
  return transport;
}

/** False under SMTP_DEBUG or with no SMTP_HOST: the caller logs what it would have sent instead. */
export function mailDeliveryEnabled(): boolean {
  return !env.SMTP_DEBUG && Boolean(env.SMTP_HOST);
}

export async function sendMail(message: MailMessage): Promise<void> {
  await getTransport().sendMail({ from: env.SMTP_FROM ?? 'noreply@localhost', ...message });
}

export function __resetMailTransportForTests(): void {
  transport = null;
}
