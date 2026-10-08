import { describe, expect, it, vi } from 'vitest';

vi.mock('../orgs/index.js', async () => {
  const { z } = await import('zod');
  return {
    boundedPresence: () => z.number(),
    presenceInvalid: (i: string[]) => new Error(i.join()),
  };
});

const { asksToStop, tagsOnlyAPerson, validateRoomPresence } = await import('./presence.js');

const handles = ['helper'];

describe('a message tags only a person', () => {
  it.each([
    ['@an để e xem nha', true], // i18n-allow: production message, renamed
    ['gỡ con này ra dùm anh @binh', true], // i18n-allow: production message, renamed
    ['@an @helper xem giúp', false], // i18n-allow: a person and the handle tagged together
    ['@an helper ơi xem giúp', false], // i18n-allow: the handle named as a bare word
    ['@all deploy xong rồi', false], // i18n-allow: a room-wide tag
    ['mail an@example.com hỏi giúp', false], // i18n-allow: an email address is no tag
    ['ISS-12 sao rồi', false], // i18n-allow: nobody tagged
  ])('%s → %s', (content, expected) => {
    expect(tagsOnlyAPerson(content, handles)).toBe(expected);
  });
});

describe('a message, taken whole, asks the handle to stop', () => {
  it.each([
    ['cút đi @helper', true], // i18n-allow: production message
    ['im đi', true], // i18n-allow: the brief's own phrase
    ['Helper ơi, đừng trả lời nữa nhé!', true], // i18n-allow: a stop with a vocative and punctuation
    ['dừng lại @helper', true], // i18n-allow: the finding's own phrase
    ['stop replying here', true],
    ['@helper stop the deploy on staging', false],
    ['đừng trả lời khách hàng bằng tiếng Anh', false], // i18n-allow: an instruction, not a stop
    ['nó bảo ko phản hồi nữa rồi kìa :D', false], // i18n-allow: production message about the stop, not one
  ])('%s → %s', (content, expected) => {
    expect(asksToStop(content, handles)).toBe(expected);
  });
});

// a project handle is its slug, and a slug may hold a hyphen or a dot (ISS-277, found by probe P7:
// every group-room window under a `test-…` handle closed `unreachable` on an invalid expression)
describe('a handle with a hyphen or a dot is read as a word, not as an expression', () => {
  const named = ['forge-dev', 'acme.ops'];
  it.each([
    ['stop replying @forge-dev', true],
    ['acme.ops, be quiet', true],
    ['forge-dev stop the deploy on staging', false],
  ])('%s → %s', (content, expected) => {
    expect(asksToStop(content, named)).toBe(expected);
  });

  it('names the hyphenated handle and not a longer word that holds it', async () => {
    const { namesHandle } = await import('./presence.js');
    expect(namesHandle('@forge-dev draft REQ-9', 'forge-dev')).toBe(true);
    expect(namesHandle('ask forge-devops instead', 'forge-dev')).toBe(false);
    expect(namesHandle('acmexops is down', 'acme.ops')).toBe(false);
  });
});

describe('a room records a quiet in its presence', () => {
  it('takes a well-formed quiet and refuses a malformed one by name', () => {
    expect(
      validateRoomPresence({ quiet: { since: '2026-09-15T02:26:04.000Z', by: 'cuong' } }),
    ).toEqual({
      quiet: { since: '2026-09-15T02:26:04.000Z', by: 'cuong' },
    });
    expect(() => validateRoomPresence({ quiet: { since: 'yesterday', by: null } })).toThrow(
      /presence\.quiet\.since/,
    );
  });
});
