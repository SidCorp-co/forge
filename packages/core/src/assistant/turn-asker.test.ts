// ISS-1451, ISS-1442: a turn is told to answer in the project's content language where the project
// said one; the question's words are only a hint for a project that never said.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const setting = vi.hoisted(() => ({
  view: { source: 'default', contentLanguage: 'en' } as { source: string; contentLanguage: string },
}));
vi.mock('../project-config/index.js', () => ({ readContentLanguage: async () => setting.view }));
vi.mock('../lib/authz.js', () => ({ effectiveProjectRole: async () => null }));

import { answerLanguageOf } from './turn-asker.js';

const ENGLISH_ASK = 'What is the status of ISS-290 right now?';
const VIETNAMESE_ASK = 'Soạn giúp mình một spec issue thật dài cho tính năng xuất báo cáo.'; // i18n-allow: the production ask replayed as the test case

beforeEach(() => {
  setting.view = { source: 'default', contentLanguage: 'en' };
});

describe('the language a turn answers in (ISS-1451)', () => {
  it('is the project’s, by the project, whatever language the question reads as', async () => {
    setting.view = { source: 'document', contentLanguage: 'vi' };
    expect(await answerLanguageOf('p-1', ENGLISH_ASK)).toEqual({ language: 'vi', by: 'project' });
    setting.view = { source: 'document', contentLanguage: 'en' };
    expect(await answerLanguageOf('p-1', VIETNAMESE_ASK)).toEqual({
      language: 'en',
      by: 'project',
    });
  });

  it('is a hint from the question where the project never said, and none where it cannot be told', async () => {
    expect(await answerLanguageOf('p-1', VIETNAMESE_ASK)).toEqual({ language: 'vi', by: 'guess' });
    expect(await answerLanguageOf('p-1', ENGLISH_ASK)).toEqual({ language: 'en', by: 'guess' });
    expect(await answerLanguageOf('p-1', 'ok')).toBeNull();
  });
});
