// A comment sent with no intent is a note; only `intent: question` is owed a reply. The default once
// made every person's comment a question, and the operator's 639 merge claims and landing notes,
// sent through a PAT with no intent, read as owed on beta.

import { describe, expect, it } from 'vitest';
import { resolveIntent } from './service.js';

describe('the intent a comment is stored under', () => {
  it('is note when none is sent, and says so in the warning', () => {
    const taken = resolveIntent(undefined);
    expect(taken.intent).toBe('note');
    expect(taken.warning).toMatch(/^COMMENT_INTENT_DEFAULTED: .*`note`.*intent: question/);
  });

  it('is note for null as for absent', () => {
    expect(resolveIntent(null).intent).toBe('note');
  });

  it('is question only when question is sent, with no warning', () => {
    expect(resolveIntent('question')).toEqual({ intent: 'question', warning: null });
    expect(resolveIntent('note')).toEqual({ intent: 'note', warning: null });
    expect(resolveIntent('decision')).toEqual({ intent: 'decision', warning: null });
  });

  it('refuses an intent outside the closed set by name, with the valid set', () => {
    for (const wrong of ['Question', 'ask', '', 7]) {
      expect(() => resolveIntent(wrong)).toThrow(
        /is not a comment intent — send one of: question, decision, note/,
      );
    }
  });
});
