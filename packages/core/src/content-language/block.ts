/**
 * The one place a prompt is told what language to write in: the job preamble (`prompt/system.ts`),
 * the in-core and BA assistant (`assistant/external-chat.ts`), and a chat session's cold start
 * (`agent-sessions/chat-turn.ts`, which onboarding and Agent-mode conversations open through).
 */

import {
  type ContentLanguageContext,
  type ContentLanguageRecord,
  type ContentLanguageSetting,
  contentLanguageName,
  TECHNICAL_TERMS_KEPT_IN_ENGLISH,
} from '@forge/contracts/content-language';
import type { JobType } from '../db/schema.js';

/** The metadata key a job or assistant session records the language it was told under. */
export const CONTENT_LANGUAGE_KEY = 'contentLanguage';

// cm:why a job that never opens the repository writes only prose stored in Forge; every other job
// may commit, so it is told both halves: code English, Forge prose in the content language.
const ARTIFACT_JOB_TYPES: ReadonlySet<JobType> = new Set(['triage', 'clarify', 'plan', 'pm']);

export function jobContentContext(type: JobType): ContentLanguageContext {
  return ARTIFACT_JOB_TYPES.has(type) ? 'artifact' : 'code';
}

const PERSISTED =
  'requirement text and criteria; workflow design labels, summaries and descriptions; comments and notes; questionnaires and onboarding messages; feedback triage text; suggestions; plan and summary prose; release notes';

function lead(language: string, context: ContentLanguageContext): string[] {
  if (context === 'chat') {
    return [
      `- Answer the person in the language they wrote in. When you cannot tell which, answer in ${language}.`,
      `- Anything you store in Forge for this project is in ${language}, whoever asked and whatever language the conversation is in: ${PERSISTED}.`,
    ];
  }
  if (context === 'code') {
    return [
      '- Code, identifiers and file names are English, and so are commit messages, branch names, and pull request titles and descriptions: that is the code standard, not a translation choice.',
      `- Prose you post to Forge for this project is in ${language}: ${PERSISTED}.`,
    ];
  }
  return [
    `- Write the prose you store in or show through Forge for this project in ${language}: ${PERSISTED}.`,
  ];
}

/** The block for `setting` in `context`, ready to append to a system prompt. */
export function contentLanguageBlock(
  setting: ContentLanguageSetting,
  context: ContentLanguageContext,
): string {
  const tag = setting.contentLanguage;
  const language = `${contentLanguageName(tag)} (\`${tag}\`)`;
  const terms = [...TECHNICAL_TERMS_KEPT_IN_ENGLISH, ...setting.keepTermsInEnglish];
  return [
    '## Content language',
    `This project's content language is ${language}.`,
    ...lead(language, context),
    `- Inside that prose, technical terms stay in English: ${terms.join(', ')}.`,
    '- Never translate machine-read text: ids, enum values, refusal codes, status names, step types, field names, `file:symbol` citations, code, identifiers, file names, commit messages, branch names, pull request titles. Forge UI labels are English.',
  ].join('\n');
}

/** What a session records beside `artifactContext`: the setting it was told, in which context. */
export function contentLanguageRecord(
  setting: ContentLanguageSetting,
  context: ContentLanguageContext,
  revision: number | null,
): ContentLanguageRecord {
  return { ...setting, keepTermsInEnglish: [...setting.keepTermsInEnglish], context, revision };
}
