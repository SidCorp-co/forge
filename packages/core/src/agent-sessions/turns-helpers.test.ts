import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { canonicalTranscript, planTranscriptWrite } = await import('./turns-helpers.js');

const user = (content: string) => ({ id: content, type: 'user', content });
const assistant = (content: string) => ({ id: content, type: 'assistant', content });

describe('planTranscriptWrite: the turn rows are the transcript, so every entry is written', () => {
  it('appends only what is new', () => {
    const plan = planTranscriptWrite([user('a')], [user('a'), assistant('b')]);
    expect(plan.insert.map((t) => [t.turnIndex, t.role])).toEqual([[1, 'assistant']]);
    expect(plan.update).toEqual([]);
    expect(plan.truncateFrom).toBeNull();
  });

  it('rewrites an entry that changed in the middle, not only at the tail', () => {
    const plan = planTranscriptWrite(
      [user('a'), assistant('b'), user('c')],
      [user('a'), assistant('B'), user('c')],
    );
    expect(plan.update.map((t) => t.turnIndex)).toEqual([1]);
  });

  it('rewrites a changed prefix when the transcript also grows', () => {
    const plan = planTranscriptWrite(
      [user('a'), assistant('b')],
      [user('a'), assistant('B'), user('c')],
    );
    expect(plan.update.map((t) => t.turnIndex)).toEqual([1]);
    expect(plan.insert.map((t) => t.turnIndex)).toEqual([2]);
  });

  it('truncates from the new length and rewrites what changed before it', () => {
    const plan = planTranscriptWrite([user('a'), assistant('b'), user('c')], [user('A')]);
    expect(plan.truncateFrom).toBe(1);
    expect(plan.update.map((t) => t.turnIndex)).toEqual([0]);
  });

  it('writes nothing for an identical transcript, and everything for a first write', () => {
    const same = planTranscriptWrite([user('a')], [user('a')]);
    expect(same).toEqual({ update: [], insert: [], truncateFrom: null });
    const first = planTranscriptWrite([], [user('a'), assistant('b')]);
    expect(first.insert.map((t) => t.turnIndex)).toEqual([0, 1]);
  });

  it('refuses by name an entry no turn role represents, instead of leaving a hole', () => {
    expect(() => planTranscriptWrite([], [user('a'), { type: 'todos' }, assistant('b')])).toThrow(
      /messages\[1\].*todos/,
    );
  });
});

describe('canonicalTranscript: a legacy role-shaped entry is refused, never converted', () => {
  it('passes canonical entries through as they are', () => {
    const out = canonicalTranscript([user('a'), assistant('b')]);
    expect(out).toEqual({ ok: true, messages: [user('a'), assistant('b')] });
  });

  it('names the index and the shape of a role-shaped entry', () => {
    const out = canonicalTranscript([user('a'), { role: 'assistant', content: 'b' }]);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.index).toBe(1);
      expect(out.why).toMatch(/type: undefined/);
    }
  });

  it('refuses a transcript that is not an array', () => {
    const out = canonicalTranscript({ type: 'user' });
    expect(out).toEqual({ ok: false, index: -1, why: 'messages is object, not an array' });
  });
});
