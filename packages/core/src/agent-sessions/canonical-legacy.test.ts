import { describe, expect, it } from 'vitest';
import {
  LEGACY_ENTRY_KEY,
  legacyEntryOf,
  toCanonicalEntry,
  toCanonicalMessages,
} from './canonical-legacy.js';

/** The converted entry, or the reason it could not be — so a case reads as one line. */
function convert(raw: unknown): Record<string, unknown> | string {
  const out = toCanonicalEntry(raw);
  return out.ok ? out.entry : out.why;
}

describe('toCanonicalEntry — the one conversion', () => {
  it('turns each legacy role into the canonical kind it always meant', () => {
    expect(convert({ role: 'user', content: 'hi' })).toMatchObject({ type: 'user' });
    expect(convert({ role: 'assistant', content: 'hi' })).toMatchObject({ type: 'assistant' });
    expect(convert({ role: 'system', content: 'hi' })).toMatchObject({ type: 'system' });
    expect(convert({ role: 'tool', content: 'hi' })).toMatchObject({ type: 'tool_result' });
  });

  it('drops `role` rather than leaving it beside the kind it became', () => {
    // cm:guard the removal is the point: `messageRoleToTurnRole` and the web's
    // `entryRole` lost their `role` branch, so an entry carrying both would read
    // one way here and could read the other way anywhere a branch came back.
    const out = toCanonicalEntry({ role: 'user', content: 'hi' });
    if (!out.ok) throw new Error(out.why);
    expect(out.entry).not.toHaveProperty('role');
  });

  it('keeps every other field the entry carried', () => {
    const attachments = [{ id: 'a1', name: 's.png', mime: 'image/png', size: 3, url: '/u' }];
    const out = toCanonicalEntry({
      id: 'm1',
      role: 'user',
      content: 'hi',
      timestamp: 1234,
      attachments,
    });
    if (!out.ok) throw new Error(out.why);
    expect(out.entry).toMatchObject({ id: 'm1', content: 'hi', timestamp: 1234, attachments });
  });

  it('rewrites v1 contentBlocks into ordered canonical blocks', () => {
    const out = toCanonicalEntry({
      role: 'assistant',
      contentBlocks: [
        { type: 'text', text: 'Editing now' },
        { type: 'tool_use', tool: { id: 'tc1', name: 'Edit', input: { file_path: 'a.ts' } } },
        { type: 'todos', todos: [{ content: 'one', status: 'pending' }] },
      ],
    });
    if (!out.ok) throw new Error(out.why);
    expect(out.entry.blocks).toEqual([
      { type: 'text', text: 'Editing now' },
      { type: 'tool', toolCall: { id: 'tc1', name: 'Edit', input: { file_path: 'a.ts' } } },
      { type: 'todos', todos: [{ content: 'one', status: 'pending' }] },
    ]);
    expect(out.entry).not.toHaveProperty('contentBlocks');
  });

  it('leaves an already-canonical entry untouched and says it converted nothing', () => {
    const entry = { id: 'm1', type: 'assistant', blocks: [{ type: 'text', text: 'hi' }] };
    const out = toCanonicalEntry(entry);
    if (!out.ok) throw new Error(out.why);
    expect(out.converted).toBe(false);
    expect(out.entry).toBe(entry);
    expect(out.entry).not.toHaveProperty(LEGACY_ENTRY_KEY);
  });

  it("keeps the original under the canonical one, so the migration's inverse is a rewrite", () => {
    const original = { role: 'user', content: 'hi' };
    const out = toCanonicalEntry(original);
    if (!out.ok) throw new Error(out.why);
    expect(legacyEntryOf(out.entry)).toEqual(original);
  });

  // cm:guard each of these is a REFUSAL rather than a best guess, and the message
  // names what was wrong. The migration turns this into an abort naming the row
  // and the live PATCH into a 400 naming the entry — neither drops the entry to
  // make itself succeed, which is the whole rule this converter exists to keep.
  it.each([
    [{ role: 'moderator', content: 'hi' }, 'names no canonical kind'],
    [{ role: 7, content: 'hi' }, 'names no canonical kind'],
    [{ role: 'assistant', contentBlocks: [{ type: 'diff', patch: '' }] }, 'no member for'],
    [{ role: 'assistant', contentBlocks: ['not an object'] }, 'is not an object'],
    [['an', 'array'], 'not an object'],
    ['a string', 'not an object'],
  ])('refuses %j by name', (raw, fragment) => {
    const out = toCanonicalEntry(raw);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a refusal');
    expect(out.why).toContain(fragment);
  });

  it('prefers the kind the derive already wrote over one reconstructed from an annotation', () => {
    // A row the derive wrote and something older annotated: `type` and `blocks`
    // are the derive's own, and rebuilding them from the annotation would flatten
    // the interleaving the derive recorded.
    const out = toCanonicalEntry({
      type: 'assistant',
      role: 'tool',
      blocks: [{ type: 'text', text: 'ordered' }],
      contentBlocks: [{ type: 'text', text: 'flattened' }],
    });
    if (!out.ok) throw new Error(out.why);
    expect(out.entry.type).toBe('assistant');
    expect(out.entry.blocks).toEqual([{ type: 'text', text: 'ordered' }]);
  });
});

describe('toCanonicalMessages — a whole transcript', () => {
  it('converts every legacy entry and counts what it rewrote', () => {
    const out = toCanonicalMessages([
      { role: 'user', content: 'hi' },
      { type: 'assistant', content: 'hello' },
      { role: 'assistant', content: 'again' },
    ]);
    if (!out.ok) throw new Error(out.why);
    expect(out.converted).toBe(2);
    expect(out.messages.map((m) => m.type)).toEqual(['user', 'assistant', 'assistant']);
  });

  it('refuses the whole array by INDEX, so the caller can name the row', () => {
    const out = toCanonicalMessages([
      { role: 'user', content: 'hi' },
      { role: 'moderator', content: 'nope' },
    ]);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a refusal');
    expect(out.index).toBe(1);
    expect(out.why).toContain('moderator');
  });

  it('refuses a `messages` that is not an array at all', () => {
    const out = toCanonicalMessages({ role: 'user' });
    expect(out.ok).toBe(false);
  });
});
