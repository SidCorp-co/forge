/**
 * An invitation reaches the invitee by mail, or is refused by name (REQ-27 BC-3). Mail is
 * configured when the instance has an SMTP host, or runs the debug transport (`SMTP_DEBUG`, and the
 * test environment) that logs the link and hands the token back. With neither, an invitation would
 * be stored and never arrive, so it is refused before a token is issued; a send that fails withdraws
 * the token it issued and is refused naming the transport's error.
 */

import type { RefusalError } from './refusal.js';

export interface MailSetting {
  SMTP_HOST?: string | undefined;
  SMTP_DEBUG?: boolean | undefined;
  NODE_ENV: string;
}

type InvitationMailCode = 'MAIL_NOT_CONFIGURED' | 'INVITATION_MAIL_FAILED';
type Refuse = (code: InvitationMailCode, detail: string, path?: string) => RefusalError;

/** Why an invitation cannot be mailed on this instance, or null when it can. */
export function mailUnconfigured(setting: MailSetting): string | null {
  if (setting.SMTP_HOST || setting.SMTP_DEBUG || setting.NODE_ENV === 'test') return null;
  return 'this instance has no mail transport (SMTP_HOST is unset), so the invitation could never reach its invitee; an operator sets SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS, or SMTP_DEBUG=1 to log the link instead';
}

/** Refuse before a token is issued where the instance cannot mail it. */
export function refuseUnmailable(setting: MailSetting, refuse: Refuse): void {
  const why = mailUnconfigured(setting);
  if (why) throw refuse('MAIL_NOT_CONFIGURED', why, '/email');
}

/** Send the invitation; on a failed send withdraw its token and refuse naming the error. */
export async function mailInvitation(args: {
  email: string;
  send: () => Promise<void>;
  withdraw: () => Promise<unknown>;
  refuse: Refuse;
}): Promise<void> {
  try {
    await args.send();
  } catch (err) {
    await args.withdraw();
    const why = err instanceof Error ? err.message : String(err);
    throw args.refuse(
      'INVITATION_MAIL_FAILED',
      `the invitation mail to ${args.email} could not be sent (${why.slice(0, 300)}), so no invitation was kept; invite again once mail is working`,
      '/email',
    );
  }
}
