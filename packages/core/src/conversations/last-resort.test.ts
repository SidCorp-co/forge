import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { LAST_RESORT_LINES } = await import('./last-resort.js');
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

  it.each(Object.entries(LAST_RESORT_LINES))('%s is plain Vietnamese', (_kind, line) => {
    expect(confidentLanguageOf(line)).toBe('vi');
  });

  it.each(Object.entries(LAST_RESORT_LINES))('%s holds no internal code', (_kind, line) => {
    expect(internalCodesIn(line)).toEqual([]);
    expect(line).not.toMatch(/[A-Z]{2,}_[A-Z_]+|\(|@/);
  });
});
