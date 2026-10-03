import type { ContentLanguageSetting } from '@forge/contracts/content-language';
import { describe, expect, it } from 'vitest';
import { contentLanguageBlock, contentLanguageRecord, jobContentContext } from './block.js';

const vi: ContentLanguageSetting = {
  contentLanguage: 'vi',
  keepTermsInEnglish: ['checkout', 'storefront'],
  source: 'document',
};
const en: ContentLanguageSetting = {
  contentLanguage: 'en',
  keepTermsInEnglish: [],
  source: 'default',
};

describe('contentLanguageBlock', () => {
  it('names the language by name and tag in every context', () => {
    for (const context of ['artifact', 'chat', 'code'] as const) {
      expect(contentLanguageBlock(vi, context)).toContain('content language is Vietnamese (`vi`)');
    }
  });

  it('artifact: stored prose is in the language, and the never list holds', () => {
    const block = contentLanguageBlock(vi, 'artifact');
    expect(block).toMatch(/Write the prose you store in or show through Forge .* in Vietnamese/);
    expect(block).toContain('requirement text and criteria');
    expect(block).toContain('release notes');
    expect(block).toContain('Never translate machine-read text');
    expect(block).not.toMatch(/Answer the person/);
  });

  it('chat: the reply follows the person, falls back to the setting, and stored prose does not follow the person', () => {
    const block = contentLanguageBlock(vi, 'chat');
    expect(block).toContain('Answer the person in the language they wrote in');
    expect(block).toContain('When you cannot tell which, answer in Vietnamese (`vi`)');
    expect(block).toMatch(/store in Forge .* is in Vietnamese \(`vi`\), whoever asked/);
  });

  it('code: says plainly that code, identifiers, commits and PR text are English', () => {
    const block = contentLanguageBlock(vi, 'code');
    expect(block).toMatch(
      /Code, identifiers and file names are English, and so are commit messages, branch names, and pull request titles and descriptions/,
    );
    expect(block).toMatch(/Prose you post to Forge for this project is in Vietnamese/);
  });

  it("keeps the built-in technical terms and the project's own in English", () => {
    const block = contentLanguageBlock(vi, 'artifact');
    expect(block).toMatch(
      /technical terms stay in English: API, webhook, SLA, deploy,.*checkout, storefront\./,
    );
  });

  it('an en project is told English, not nothing', () => {
    expect(contentLanguageBlock(en, 'chat')).toContain(
      'When you cannot tell which, answer in English (`en`)',
    );
  });
});

describe('jobContentContext', () => {
  it('a job that never opens the repository writes artifacts; one that may commit gets the code block', () => {
    expect(jobContentContext('clarify')).toBe('artifact');
    expect(jobContentContext('plan')).toBe('artifact');
    expect(jobContentContext('code')).toBe('code');
    expect(jobContentContext('drive')).toBe('code');
    expect(jobContentContext('release')).toBe('code');
  });
});

it('contentLanguageRecord carries the setting, the context and the revision, copied', () => {
  const record = contentLanguageRecord(vi, 'code', 7);
  expect(record).toEqual({ ...vi, context: 'code', revision: 7 });
  expect(record.keepTermsInEnglish).not.toBe(vi.keepTermsInEnglish);
});
