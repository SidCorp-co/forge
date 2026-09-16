/**
 * ISS-1064 — each rule of the memory-note gate red and green, the refusal text's shape, and the
 * pre-call hook reading the turn: the person's messages, the notes already kept, the search.
 */

import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../providers/types.js';
import type { PreCallContext, ToolCallRecord } from '../run-turn-core.js';
import {
  DUPLICATE_SCORE,
  judgeNote,
  memoryNotePreCall,
  NOTE_TEXT_MAX,
  NOTE_TEXT_MIN,
  NOTE_TOOL_CHAT_NAME,
  type NoteJudgeInput,
  type NoteRefusal,
  REFUSAL_TEXT_MAX,
  recentPersonTurns,
  refusalText,
} from './memory-note-gate.js';

import { base, code, REMEMBER } from './memory-note-gate-ground.js';

describe('judgeNote', () => {
  it('passes the fact with the remember-framing dropped, and refuses the message copied back', () => {
    expect(code(base())).toBeNull();
    const r = judgeNote(base({ text: REMEMBER }));
    expect(r?.code).toBe('restates_message');
    expect(r?.howToWrite).toBe('the release code name is bench-1a2b3c4d5e6f.');
    // punctuation and case are not extraction
    expect(
      code(base({ text: 'remember for this project the release code name is bench-1a2b3c4d5e6f' })),
    ).toBe('restates_message');
  });

  it('the framed message copied back may be an earlier one: a "Thanks" after it does not clear the copy', () => {
    const r = judgeNote(base({ text: REMEMBER, recentTurns: [REMEMBER, 'Thanks.'] }));
    expect(r?.code).toBe('restates_message');
    expect(r?.howToWrite).toBe('the release code name is bench-1a2b3c4d5e6f.');
    expect(code(base({ recentTurns: [REMEMBER, 'Thanks.'] }))).toBeNull();
  });

  it('a message with no remember-framing may be kept word for word: the sentence is the fact', () => {
    const said = 'The deploy window is Thursday 14:00 UTC.';
    expect(
      code(base({ text: said, recentTurns: ['Please remember what I tell you next.', said] })),
    ).toBeNull();
  });

  it('a second note in a one-sentence turn is refused; a two-sentence message admits it', () => {
    expect(code(base({ notesThisTurn: 1 }))).toBe('second_note_this_turn');
    expect(code(base({ notesThisTurn: 0 }))).toBeNull();
    const two = 'Remember these: the reviewer is Priya Raman. We deploy on Wednesdays.';
    expect(
      code(base({ text: 'Deploys happen on Wednesdays.', recentTurns: [two], notesThisTurn: 1 })),
    ).toBeNull();
    expect(
      code(base({ text: 'Deploys happen on Wednesdays.', recentTurns: [two], notesThisTurn: 2 })),
    ).toBe('second_note_this_turn');
  });

  it('too short and too long, by the content alone', () => {
    expect(code(base({ text: 'bench-1a2b' }))).toBe('too_short');
    expect(code(base({ text: 'x'.repeat(NOTE_TEXT_MIN) }))).toBeNull();
    expect(code(base({ text: 'y'.repeat(NOTE_TEXT_MAX + 1) }))).toBe('too_long');
  });

  it('a duplicate at or above the store threshold is refused naming the twin; below it passes; a search that returned nothing passes', () => {
    const twin = {
      text: 'Release code name: bench-1a2b3c4d5e6f\nkept 2026-09-16',
      score: DUPLICATE_SCORE,
    };
    const r = judgeNote(base({ existingNotes: [{ text: 'deploy window', score: 0.3 }, twin] }));
    expect(r?.code).toBe('duplicate');
    expect(r?.rule).toContain('Release code name: bench-1a2b3c4d5e6f');
    expect(r?.rule).not.toContain('kept 2026');
    expect(code(base({ existingNotes: [{ ...twin, score: DUPLICATE_SCORE - 0.01 }] }))).toBeNull();
  });

  it('a note about the exchange is refused; the same words inside a project fact pass', () => {
    const r = judgeNote(base({ text: 'The user asked me to remember the release code name.' }));
    expect(r?.code).toBe('about_the_conversation');
    expect(r?.howToWrite).toBe('remember the release code name.');
    expect(
      code(base({ text: 'Copy agreed for the empty state: "the user asked for dark mode".' })),
    ).toBeNull();
    expect(code(base({ text: 'In this conversation we settled the reviewer.' }))).toBe(
      'about_the_conversation',
    );
  });

  it('every refusal text is under the cap, names its code and rule, and only a rewritable one promises a rewrite', () => {
    const cases: Array<[NoteJudgeInput, boolean]> = [
      [base({ text: REMEMBER }), true],
      [base({ text: 'short' }), true],
      [base({ text: 'z'.repeat(NOTE_TEXT_MAX + 5) }), true],
      [base({ text: 'The user asked me to keep the window.' }), true],
      [base({ notesThisTurn: 1 }), false],
      [base({ existingNotes: [{ text: 'twin '.repeat(40), score: 0.99 }] }), false],
    ];
    for (const [input, rewritable] of cases) {
      const r = judgeNote(input) as NoteRefusal;
      const text = refusalText(r);
      expect(text.length, r.code).toBeLessThan(REFUSAL_TEXT_MAX);
      expect(text).toContain(`(${r.code})`);
      expect(text).toContain(r.rule.slice(0, 40));
      expect(text.includes('Write instead:'), r.code).toBe(rewritable);
      expect(text.includes('Do this:'), r.code).toBe(!rewritable);
    }
    expect(refusalText(judgeNote(base({ notesThisTurn: 1 })) as NoteRefusal)).toContain(
      'Keep no further note this turn',
    );
  });
});

describe('recentPersonTurns', () => {
  it('reads the person’s text after the turn-context prefix, every text part of a parts array, and skips other roles', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'you are' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'ctx' },
          { type: 'image_url', image_url: { url: 'x' } },
          { type: 'text', text: 'look' },
        ],
      },
      { role: 'user', content: `Page: /issues\n\n---\n\n${REMEMBER}` },
    ];
    expect(recentPersonTurns(messages)).toEqual(['first', 'ctx look', REMEMBER]);
    expect(recentPersonTurns(messages, 1)).toEqual([REMEMBER]);
  });
});

describe('memoryNotePreCall', () => {
  const record = (name: string, isError = false): ToolCallRecord => ({
    name,
    arguments: '{}',
    round: 1,
    isError,
    durationMs: 1,
    resultPreview: '',
    resultIssueRefs: [],
  });
  const ctx = (toolCalls: ToolCallRecord[] = []): PreCallContext => ({
    messages: [{ role: 'user', content: REMEMBER }],
    toolCalls,
  });
  const args = (text: string) => JSON.stringify({ text });

  it('fires for the note tool alone, refuses a restatement as a tool error, lets a fact through', async () => {
    const asked: string[] = [];
    const gate = memoryNotePreCall({
      existingNotes: async (t) => {
        asked.push(t);
        return [];
      },
    });
    expect(await gate({ name: 'forge', arguments: args(REMEMBER) }, ctx())).toBeNull();
    const refused = await gate({ name: NOTE_TOOL_CHAT_NAME, arguments: args(REMEMBER) }, ctx());
    expect(refused?.isError).toBe(true);
    expect(JSON.stringify(refused?.content)).toContain('(restates_message)');
    expect(
      await gate(
        { name: NOTE_TOOL_CHAT_NAME, arguments: args('Release code name: bench-1a2b3c4d5e6f.') },
        ctx(),
      ),
    ).toBeNull();
    expect(asked).toEqual([REMEMBER, 'Release code name: bench-1a2b3c4d5e6f.']);
  });

  it('counts only the notes this turn kept, not the refused ones, and reads a failed search as none, reporting it', async () => {
    const errors: unknown[] = [];
    const gate = memoryNotePreCall({
      existingNotes: async () => {
        throw new Error('embeddings down');
      },
      onSearchError: (e) => errors.push(e),
    });
    const fact = args('Release code name: bench-1a2b3c4d5e6f.');
    expect(
      await gate(
        { name: NOTE_TOOL_CHAT_NAME, arguments: fact },
        ctx([record(NOTE_TOOL_CHAT_NAME, true)]),
      ),
    ).toBeNull();
    const second = await gate(
      { name: NOTE_TOOL_CHAT_NAME, arguments: fact },
      ctx([record(NOTE_TOOL_CHAT_NAME)]),
    );
    expect(JSON.stringify(second?.content)).toContain('(second_note_this_turn)');
    expect(errors.map((e) => (e as Error).message)).toEqual(['embeddings down', 'embeddings down']);
  });

  it('a duplicate the search finds is refused; malformed arguments are left to the tool', async () => {
    const gate = memoryNotePreCall({
      existingNotes: async () => [{ text: 'Release code name: bench-1a2b3c4d5e6f', score: 0.97 }],
    });
    const r = await gate(
      {
        name: NOTE_TOOL_CHAT_NAME,
        arguments: args('Code name for the release: bench-1a2b3c4d5e6f.'),
      },
      ctx(),
    );
    expect(JSON.stringify(r?.content)).toContain('(duplicate)');
    expect(await gate({ name: NOTE_TOOL_CHAT_NAME, arguments: '{not json' }, ctx())).toBeNull();
  });
});
