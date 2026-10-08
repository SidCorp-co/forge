// A run reads its tracker door and its release block at the moment it parks, asks, marks or aborts.
// Each act that says what it waits on or carries is named there with the refusals that hold it, and
// every refusal named is one core can return: a misspelt code teaches a refusal no reader will meet.

import { MERGE_REFUSAL_CODES } from '@forge/contracts/issues';
import { QUESTION_REFUSAL_CODES } from '@forge/contracts/questions';
import { MEMORY_REFUSAL_CODES } from '@forge/contracts/memory';
import { RELEASE_BLOCKER_CODES, RELEASE_REFUSAL_CODES } from '@forge/contracts/releases';
import { describe, expect, it } from 'vitest';
import { releaseBatchStatePrompt } from '../state-prompts/release-batch.js';
import {
  DRIVE_RULES_TEXT,
  DRIVE_TOOL_REFERENCE_TEXT,
  STEP_TOOL_REFERENCE_TEXT,
} from './drive-rules.js';

const CODES = new Set<string>([
  ...QUESTION_REFUSAL_CODES,
  ...MERGE_REFUSAL_CODES,
  ...RELEASE_REFUSAL_CODES,
  ...RELEASE_BLOCKER_CODES,
]);
const unknown = (text: string) =>
  [...text.matchAll(/\b(?:QUESTION|ARTIFACT_CARRIER|RELEASE)_[A-Z_]+\b/g)]
    .map((m) => m[0])
    .filter((code) => !CODES.has(code));

const DOORS = [
  ['a drive run', DRIVE_TOOL_REFERENCE_TEXT],
  ['a pipeline step', STEP_TOOL_REFERENCE_TEXT],
] as const;

describe("a run's tracker door teaches the acts that name what they wait on", () => {
  it.each(DOORS)('%s parks on a merge mark by name', (_who, text) => {
    for (const word of ['"awaitsMerge":{"issueId":"<id>"}', 'QUESTION_MERGE_ALREADY_MARKED']) {
      expect(text).toContain(word);
    }
  });

  it.each(DOORS)('%s asks a business question about its requirement', (_who, text) => {
    for (const word of [
      '"about":{"requirement":null}',
      '{"contract":"<project>/<contract>"}',
      'QUESTION_ABOUT_UNKNOWN',
      'QUESTION_ABOUT_NO_REQUIREMENT',
      'QUESTION_ABOUT_ON_MERGE_WAIT',
    ]) {
      expect(text).toContain(word);
    }
  });

  it.each(DOORS)('%s marks an artifact another issue carries', (_who, text) => {
    for (const word of ['"carriedBy":"<that issue\'s key>"', 'ARTIFACT_CARRIER_SHIPPED']) {
      expect(text).toContain(word);
    }
  });

  it.each(DOORS)('%s names only refusals core returns', (_who, text) => {
    expect(unknown(text)).toEqual([]);
  });
});

describe('a release run says what left when it stops', () => {
  it('names carried, the refusal a silence earns, and the contradiction', () => {
    for (const word of [
      '"carried":[{"kind":"tag","name":"v1.4.0"}]',
      '"carried":[]',
      'RELEASE_VERSION_UNDECIDED',
      'RELEASE_CARRIED_CONTRADICTS',
    ]) {
      expect(releaseBatchStatePrompt).toContain(word);
    }
  });

  it('names only refusals core returns', () => {
    expect(unknown(releaseBatchStatePrompt)).toEqual([]);
  });

  it('catches a refusal no code list holds', () => {
    expect(unknown('refused `RELEASE_VERSION_UNDECIDE`')).toEqual(['RELEASE_VERSION_UNDECIDE']);
  });
});

describe('a run writes memory another reader can trust', () => {
  it('names a foreign key by its project, keeps bookkeeping out, and gives an outdated verdict its reason', () => {
    for (const word of [
      '`<its slug> ISS-n`',
      'never as a `decision`',
      'MEMORY_EVIDENCE_REQUIRED',
    ]) {
      expect(DRIVE_RULES_TEXT).toContain(word);
    }
    expect(MEMORY_REFUSAL_CODES).toContain('MEMORY_EVIDENCE_REQUIRED');
  });
});
