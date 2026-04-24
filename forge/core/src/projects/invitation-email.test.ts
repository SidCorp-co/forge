import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMail = vi.fn(async () => ({ messageId: 'x' }));

vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail })) },
}));

vi.mock('../config/env.js', () => ({
  env: {
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: 587,
    SMTP_USER: 'u',
    SMTP_PASS: 'p',
    SMTP_FROM: 'noreply@example.com',
    SMTP_DEBUG: false,
    APP_BASE_URL: 'http://localhost:8080',
  },
}));

const loggerInfo = vi.fn();
vi.mock('../logger.js', () => ({
  logger: { info: loggerInfo, error: vi.fn() },
}));

const envMod = await import('../config/env.js');
const emailMod = await import('./invitation-email.js');

beforeEach(() => {
  vi.clearAllMocks();
  emailMod.__resetTransportForTests();
  (envMod.env as { SMTP_DEBUG: boolean }).SMTP_DEBUG = false;
});

describe('sendInvitationEmail', () => {
  it('sends via nodemailer when SMTP_DEBUG is false', async () => {
    await emailMod.sendInvitationEmail('invitee@example.com', {
      projectName: 'Acme Widgets',
      inviterEmail: 'owner@example.com',
      token: 'tok-abc',
    });

    expect(sendMail).toHaveBeenCalledTimes(1);
    const args = (sendMail.mock.calls as unknown as unknown[][])[0]?.[0] as unknown as {
      from: string;
      to: string;
      subject: string;
      text: string;
      html: string;
    };
    expect(args.from).toBe('noreply@example.com');
    expect(args.to).toBe('invitee@example.com');
    expect(args.subject).toMatch(/Acme Widgets/);
    const expectedLink = 'http://localhost:8080/invite/accept?token=tok-abc';
    expect(args.text).toContain(expectedLink);
    expect(args.text).toContain('owner@example.com');
    expect(args.html).toContain(expectedLink);
    expect(loggerInfo).not.toHaveBeenCalled();
  });

  it('logs and does NOT send when SMTP_DEBUG is true', async () => {
    (envMod.env as { SMTP_DEBUG: boolean }).SMTP_DEBUG = true;

    await emailMod.sendInvitationEmail('invitee@example.com', {
      projectName: 'Acme',
      inviterEmail: 'owner@example.com',
      token: 'tok-debug',
    });

    expect(sendMail).not.toHaveBeenCalled();
    expect(loggerInfo).toHaveBeenCalledTimes(1);
    const [payload] = (loggerInfo.mock.calls as unknown as unknown[][])[0] ?? [];
    expect(payload).toMatchObject({
      to: 'invitee@example.com',
      link: 'http://localhost:8080/invite/accept?token=tok-debug',
    });
  });

  it('HTML-escapes project name and inviter email in the HTML body', async () => {
    await emailMod.sendInvitationEmail('invitee@example.com', {
      projectName: 'Bad<script>alert(1)</script>&Co',
      inviterEmail: 'owner@example.com',
      token: 'tok-plain',
    });

    const args = (sendMail.mock.calls as unknown as unknown[][])[0]?.[0] as unknown as {
      text: string;
      html: string;
    };
    expect(args.html).not.toContain('<script>');
    expect(args.html).toContain('Bad&lt;script&gt;alert(1)&lt;/script&gt;&amp;Co');
    // Plain-text body is plain text — no escaping required there.
    expect(args.text).toContain('Bad<script>alert(1)</script>&Co');
  });

  it('URL-encodes tokens with reserved chars', async () => {
    await emailMod.sendInvitationEmail('u@e.co', {
      projectName: 'P',
      inviterEmail: 'o@e.co',
      token: 'a+b/c=',
    });
    const args = (sendMail.mock.calls as unknown as unknown[][])[0]?.[0] as unknown as {
      text: string;
    };
    expect(args.text).toContain('token=a%2Bb%2Fc%3D');
  });
});
