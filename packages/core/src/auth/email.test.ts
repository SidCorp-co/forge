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
const emailMod = await import('./email.js');

beforeEach(() => {
  vi.clearAllMocks();
  emailMod.__resetTransportForTests();
  (envMod.env as { SMTP_DEBUG: boolean }).SMTP_DEBUG = false;
});

describe('sendVerificationEmail', () => {
  it('sends via nodemailer when SMTP_DEBUG is false', async () => {
    await emailMod.sendVerificationEmail('user@example.com', 'tok-abc');

    expect(sendMail).toHaveBeenCalledTimes(1);
    const args = (sendMail.mock.calls as unknown as unknown[][])[0]?.[0] as unknown as {
      from: string;
      to: string;
      subject: string;
      text: string;
      html: string;
    };
    expect(args.from).toBe('noreply@example.com');
    expect(args.to).toBe('user@example.com');
    expect(args.subject).toMatch(/verify/i);
    const expectedLink = 'http://localhost:8080/api/auth/verify?token=tok-abc';
    expect(args.text).toContain(expectedLink);
    expect(args.html).toContain(expectedLink);
    expect(loggerInfo).not.toHaveBeenCalled();
  });

  it('logs the link and does NOT send when SMTP_DEBUG is true', async () => {
    (envMod.env as { SMTP_DEBUG: boolean }).SMTP_DEBUG = true;

    await emailMod.sendVerificationEmail('user@example.com', 'tok-debug');

    expect(sendMail).not.toHaveBeenCalled();
    expect(loggerInfo).toHaveBeenCalledTimes(1);
    const [payload] = (loggerInfo.mock.calls as unknown as unknown[][])[0] ?? [];
    expect(payload).toMatchObject({
      to: 'user@example.com',
      link: 'http://localhost:8080/api/auth/verify?token=tok-debug',
    });
  });

  it('URL-encodes tokens with reserved chars', async () => {
    await emailMod.sendVerificationEmail('u@e.co', 'a+b/c=');
    const args = (sendMail.mock.calls as unknown as unknown[][])[0]?.[0] as unknown as {
      text: string;
    };
    expect(args.text).toContain('token=a%2Bb%2Fc%3D');
  });

  // Regression: with subdomain-split deploys (web on APP_BASE_URL, API on
  // OAUTH_REDIRECT_BASE) the verification link must hit the API origin —
  // /api/auth/verify only exists there. APP_BASE_URL would 404 on the web.
  it('uses OAUTH_REDIRECT_BASE for the link when set (subdomain-split deploy)', async () => {
    const e = envMod.env as {
      OAUTH_REDIRECT_BASE?: string;
      SMTP_DEBUG: boolean;
    };
    e.SMTP_DEBUG = true;
    e.OAUTH_REDIRECT_BASE = 'https://api.example.com';
    try {
      await emailMod.sendVerificationEmail('split@example.com', 'tok-split');
      const [payload] = (loggerInfo.mock.calls as unknown as unknown[][])[0] ?? [];
      expect(payload).toMatchObject({
        link: 'https://api.example.com/api/auth/verify?token=tok-split',
      });
    } finally {
      delete e.OAUTH_REDIRECT_BASE;
    }
  });
});
