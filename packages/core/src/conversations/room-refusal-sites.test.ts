// ISS-1229 r27, judge-77: a person reaching a room they could not read was told "Conversation <uuid>
// has no agent in it…". Every refusal the room doors send a person says "This room" and names no id;
// the ids ride `details`. A sentence here that interpolates an id, or opens on "conversation", fails.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { roomRefusal } from './room-refusal.js';

const SRC = join(import.meta.dirname, '..');

const ROOM_DOORS = [
  'conversations/scope.ts',
  'conversations/participants.ts',
  'assistant/conversation-access.ts',
  'assistant/conversation-routes.ts',
  'assistant/conversation-attachment-routes.ts',
];

/** Every string or template literal in a source, with the line it starts on. */
function literals(source: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  const pattern = /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;
  for (const m of source.matchAll(pattern)) {
    out.push({ text: m[0], line: source.slice(0, m.index).split('\n').length });
  }
  return out;
}

/** An id, a list of ids (`scope`, `projectIds`) or a joined list of anything (r27 review F2). */
const ID_INTERPOLATED =
  /\$\{[^}]*(?:[a-z]Ids?\b|\.ids?\b|\bids?\b|\bscope\b(?!\.length)|\.join\()[^}]*\}/;
/** Literals that are not sentences: a SQL fragment and a URL a client follows. */
const NOT_A_SENTENCE = /^`(?:count\(|\/api\/)/;

describe('a refusal about a room', () => {
  it.each(ROOM_DOORS)('in %s names no id and never opens on "conversation"', (file) => {
    const source = readFileSync(join(SRC, file), 'utf8');
    const offenders = literals(source)
      .filter(({ text }) => !NOT_A_SENTENCE.test(text))
      .filter(({ text }) => ID_INTERPOLATED.test(text) || /^[`'"]conversation \$\{/i.test(text))
      .map(({ text, line }) => `${file}:${line} ${text.slice(0, 80)}`);
    expect(offenders).toEqual([]);
  });

  it('carries the ids it is about in details, beside its code', () => {
    const refused = roomRefusal(403, 'CONVERSATION_NO_SCOPE', 'This room has no agent in it', {
      conversationId: 'c-1',
    });
    expect(refused.status).toBe(403);
    expect(refused.message).toBe('This room has no agent in it');
    expect(refused.cause).toEqual({
      code: 'CONVERSATION_NO_SCOPE',
      details: { conversationId: 'c-1' },
    });
  });
});
