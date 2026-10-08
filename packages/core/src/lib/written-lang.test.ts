import { describe, expect, it } from 'vitest';
import { writtenLangFor } from './written-lang.js';

// A text is stored with the language its writer declared; failing that, with what its own letters
// settle, before any default of the writer's: an agent on a vi project that wrote English is stored
// as English, which is what a reader meets (hop /status, 2026-10-08). Neither path reads the database.

const agent = { userId: null, agency: 'agent' as const };
const PROJECT = '00000000-0000-4000-8000-000000000000';

describe('the language a text is stored with', () => {
  it('is the declared one, whatever the text reads as', async () => {
    expect(
      await writtenLangFor(agent, PROJECT, 'vi', undefined, 'The plan is written in English'),
    ).toBe('vi');
  });

  it("is what the text's letters settle where nothing was declared", async () => {
    expect(
      await writtenLangFor(
        agent,
        PROJECT,
        undefined,
        undefined,
        'Missing CLI verb: no verb links an issue to a requirement',
      ),
    ).toBe('en');
    expect(await writtenLangFor(agent, PROJECT, null, undefined, 'Sửa lỗi đăng nhập')).toBe('vi'); // i18n-allow: Vietnamese text under test
  });
});
