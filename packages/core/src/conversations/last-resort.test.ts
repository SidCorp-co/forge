import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { LAST_RESORT_LINES, ROOM_STILL_QUEUED_LINES, STILL_QUEUED_LINE } = await import(
  './last-resort.js'
);
const { FORGE_KEY_PREFIXES, internalCodesIn } = await import('../messaging/internal-codes.js');
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

  const lines = [
    ...Object.entries(LAST_RESORT_LINES),
    ['still_queued', STILL_QUEUED_LINE],
    ['room_still_queued', ROOM_STILL_QUEUED_LINES.vi],
  ];

  it.each(lines)('%s is plain Vietnamese', (_kind, line) => {
    expect(confidentLanguageOf(line)).toBe('vi');
  });

  it.each(lines)('%s holds no internal code', (_kind, line) => {
    expect(internalCodesIn(line, FORGE_KEY_PREFIXES)).toEqual([]);
    expect(line).not.toMatch(/[A-Z]{2,}_[A-Z_]+|\(|@/);
  });

  // ISS-977: a support thread's message stays queued once Forge's retries ran out, so its line
  // says the assistant answers when it can and never asks the person to send it again
  it('the still-queued line never asks the person to resend', () => {
    expect(STILL_QUEUED_LINE).not.toMatch(/gửi lại/i); // i18n-allow: the Vietnamese phrase the line must never hold (ISS-977)
    expect(STILL_QUEUED_LINE).toMatch(/trả lời ngay khi có thể/); // i18n-allow: the Vietnamese promise the line must hold (ISS-977)
  });

  // ISS-1105: the room's one line for a broken session is said in the room's language, and in
  // either it never asks anyone to resend
  it("the room's line is English where the room is not Vietnamese, and neither asks to resend", () => {
    expect(confidentLanguageOf(ROOM_STILL_QUEUED_LINES.en)).toBe('en');
    expect(internalCodesIn(ROOM_STILL_QUEUED_LINES.en, FORGE_KEY_PREFIXES)).toEqual([]);
    expect(ROOM_STILL_QUEUED_LINES.vi).not.toMatch(/gửi lại/i); // i18n-allow: the Vietnamese phrase the line must never hold (ISS-977)
    expect(ROOM_STILL_QUEUED_LINES.en).not.toMatch(/resend|send it again/i);
  });
});
