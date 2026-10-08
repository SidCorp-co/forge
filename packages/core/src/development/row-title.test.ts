import { saidDisagreements, say, verbatim } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { composedTitle, writtenTitle } from './row-title.js';

// A needs-you row's title is either its writer's words, kept with the language they were written in,
// or Forge's own, said by key: never Forge's English passed off as a writer's.

describe("a needs-you row's title", () => {
  it("keeps a writer's words verbatim, with the language they were written in", () => {
    const t = writtenTitle('Sửa lỗi đăng nhập', 'vi'); // i18n-allow: Vietnamese text under test
    expect(t).toEqual({
      title: 'Sửa lỗi đăng nhập', // i18n-allow: Vietnamese text under test
      titleLang: 'vi',
      says: { title: verbatim('Sửa lỗi đăng nhập') }, // i18n-allow: Vietnamese text under test
    });
    expect(saidDisagreements(t)).toEqual([]);
  });

  it("says Forge's own title by key, in no writer's language", () => {
    const t = composedTitle(say('needsYou.title.release', { version: '0.3.0' }));
    expect(t).toMatchObject({ title: 'Release 0.3.0', titleLang: null });
    expect(t.says.title.key).toBe('needsYou.title.release');
    expect(saidDisagreements(t)).toEqual([]);
  });
});
