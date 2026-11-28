// @direct-test-of packages/core/src/support/ops-reads.ts
// @direct-test-of packages/core/src/support/shared-picture.ts
// @direct-test-of packages/core/src/support/ops-release-holds.ts
// @direct-test-of packages/core/src/support/ops-feedback-read.ts
// @direct-test-of packages/core/src/support/promise-watch.ts
// ISS-1483 (dev.864): a title or a name a room read hands over is an agent's free text and can name the
// master; it goes through `titleWords`. The database-backed reads are poisoned end to end in
// tests/integration/support-agent-reads-e2e.test.ts; this file holds the word rule and a source guard
// for the reads that need a deeper world (in flight, a release hold).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { titleWords } from './room-read-words.js';
import { INTERNAL_WORDS, NAMES_THE_HAND } from './room-voice.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('a title a room reads (ISS-1483)', () => {
  it('keeps a plain title, and reads the kind where the title names an internal hand', () => {
    expect(titleWords('Sign-in page', 'issue')).toBe('Sign-in page');
    for (const poison of [
      'A room agent and its master trade one-shot facts',
      'the orchestrator retries ISS-9999',
      'judge fails 9e174d4534ab',
      'the steward holds PAT_PROJECT_OUTSIDE_FENCE',
      'a qa run on the box',
    ]) {
      const said = titleWords(poison, 'issue');
      expect(said, poison).toBe('an issue');
      expect(NAMES_THE_HAND.test(said) || INTERNAL_WORDS.test(said)).toBe(false);
    }
    // a handle is taken out of a title that is otherwise plain
    expect(titleWords('Fix sign-in ISS-9999', 'issue')).not.toContain('ISS-9999');
  });

  it('is the only way an issue title leaves the reads that build a room picture', () => {
    for (const file of [
      'ops-reads.ts',
      'shared-picture.ts',
      'ops-release-holds.ts',
      'ops-feedback-read.ts',
    ]) {
      const raw = readFileSync(resolve(HERE, file), 'utf8')
        .split('\n')
        .filter(
          (l) =>
            !l.includes('titleWords') &&
            /\btitle:\s*(?:r|row|issue|\w+)\.title\b|\bname:\s*(?:r|p)\.name\b/.test(l),
        );
      expect(raw, `${file} hands a title or name raw`).toEqual([]);
    }
  });
});
