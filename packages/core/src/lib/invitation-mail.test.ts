import { describe, expect, it, vi } from 'vitest';
import { mailInvitation, mailUnconfigured, refuseUnmailable } from './invitation-mail.js';
import { isRefusal, refuser } from './refusal.js';

const refuse = refuser<'MAIL_NOT_CONFIGURED' | 'INVITATION_MAIL_FAILED' | 'X'>('X');

describe('an invitation reaches its invitee by mail, or is refused by name (REQ-27 BC-3)', () => {
  it('counts an SMTP host, the debug transport and the test environment as mail', () => {
    expect(mailUnconfigured({ SMTP_HOST: 'smtp.example.com', NODE_ENV: 'production' })).toBeNull();
    expect(mailUnconfigured({ SMTP_DEBUG: true, NODE_ENV: 'development' })).toBeNull();
    expect(mailUnconfigured({ NODE_ENV: 'test' })).toBeNull();
  });

  it('refuses MAIL_NOT_CONFIGURED where a deployed instance has no transport, naming the settings', () => {
    let thrown: unknown;
    try {
      refuseUnmailable({ NODE_ENV: 'production' }, refuse);
    } catch (err) {
      thrown = err;
    }
    expect(isRefusal(thrown, 'MAIL_NOT_CONFIGURED')).toBe(true);
    expect((thrown as Error).message + JSON.stringify((thrown as { refusals: unknown }).refusals)).toMatch(/SMTP_HOST/);
    expect(() => refuseUnmailable({ NODE_ENV: 'development', SMTP_DEBUG: false }, refuse)).toThrow();
  });

  it('withdraws the token and refuses INVITATION_MAIL_FAILED when the send fails', async () => {
    const withdraw = vi.fn(async () => true);
    const sent = mailInvitation({
      email: 'ann@example.com',
      send: async () => {
        throw new Error('connect ECONNREFUSED');
      },
      withdraw,
      refuse,
    });
    await expect(sent).rejects.toSatisfy((e: unknown) => isRefusal(e, 'INVITATION_MAIL_FAILED'));
    expect(withdraw).toHaveBeenCalledOnce();
  });

  it('keeps the invitation when the send succeeds', async () => {
    const withdraw = vi.fn(async () => true);
    await mailInvitation({ email: 'ann@example.com', send: async () => {}, withdraw, refuse });
    expect(withdraw).not.toHaveBeenCalled();
  });
});
