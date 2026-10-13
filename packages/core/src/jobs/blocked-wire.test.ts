import { describe, expect, it } from 'vitest';
import { blockedBodySchema } from './blocked-wire.js';

const dialog = {
  kind: 'dialog',
  questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }],
};

describe('the blocked body', () => {
  it('takes the three things a pane can have stopped on', () => {
    for (const asked of [
      dialog,
      { kind: 'permission', tool: 'Bash', input: '{"command":"ls"}' },
      { kind: 'unread', why: 'no transcript path is known' },
    ]) {
      expect(blockedBodySchema.safeParse({ error: 'ended', asked }).success).toBe(true);
    }
  });

  it('refuses a body that names no pane question, naming the field', () => {
    const none = blockedBodySchema.safeParse({ error: 'ended' });
    expect(none.success).toBe(false);
    const empty = blockedBodySchema.safeParse({
      error: 'ended',
      asked: { kind: 'dialog', questions: [] },
    });
    expect(empty.success).toBe(false);
  });

  it('refuses a key it does not know, at either level', () => {
    expect(blockedBodySchema.safeParse({ error: 'e', asked: dialog, extra: 1 }).success).toBe(
      false,
    );
    const inner = { ...dialog, questions: [{ ...dialog.questions[0], mystery: true }] };
    expect(blockedBodySchema.safeParse({ error: 'e', asked: inner }).success).toBe(false);
  });

  it('refuses a kind that is not one of the three', () => {
    expect(
      blockedBodySchema.safeParse({ error: 'e', asked: { kind: 'shrug', why: 'x' } }).success,
    ).toBe(false);
  });
});
