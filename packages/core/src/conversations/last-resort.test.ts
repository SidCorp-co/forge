import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { LAST_RESORT_LINES, STILL_QUEUED_LINE } = await import('./last-resort.js');
const { internalCodesIn } = await import('../messaging/internal-codes.js');
const { confidentLanguageOf } = await import('./text-language.js');

// ISS-875: core speaks in a room on its own only where the agent cannot, and then in plain
// Vietnamese with no internal code, the screen ISS-872/873 holds every room's posts to.
describe("core's last-resort lines", () => {
  it('are the three cases the agent cannot speak in, and no other', () => {
    expect(Object.keys(LAST_RESORT_LINES).sort()).toEqual([
      'offline',
      'rate_limited',
      'turn_failed',
    ]);
  });

  const lines = [...Object.entries(LAST_RESORT_LINES), ['still_queued', STILL_QUEUED_LINE]];

  it.each(lines)('%s is plain Vietnamese', (_kind, line) => {
    expect(confidentLanguageOf(line)).toBe('vi');
  });

  it.each(lines)('%s holds no internal code', (_kind, line) => {
    expect(internalCodesIn(line)).toEqual([]);
    expect(line).not.toMatch(/[A-Z]{2,}_[A-Z_]+|\(|@/);
  });

  // ISS-977: a support thread's message stays queued once Forge's retries ran out, so its line
  // says the assistant answers when it can and never asks the person to send it again
  it('the still-queued line never asks the person to resend', () => {
    expect(STILL_QUEUED_LINE).not.toMatch(/gửi lại/i); // i18n-allow: the Vietnamese phrase the line must never hold (ISS-977)
    expect(STILL_QUEUED_LINE).toMatch(/trả lời ngay khi có thể/); // i18n-allow: the Vietnamese promise the line must hold (ISS-977)
  });
});
