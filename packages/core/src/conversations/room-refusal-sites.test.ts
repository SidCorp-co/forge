// ISS-1229 r27, judge-77: a person reaching a room they could not read was told "Conversation <uuid>
// has no agent in it…". Every refusal the room doors send a person says "This room" and names no id;
// the ids ride `details`. A sentence here that interpolates an id, or opens on "conversation", fails.
// Round 28, judge-80: a room that is gone answered "conversation not found" from a 404 built beside
// `roomRefusal`, so every refusal a room door builds now goes through it, and that sentence is gone.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { roomGone, roomRefusal } from './room-refusal.js';

const SRC = join(import.meta.dirname, '..');

const ROOM_DOORS = [
  'conversations/scope.ts',
  'conversations/participants.ts',
  'assistant/conversation-access.ts',
  'assistant/conversation-routes.ts',
  'assistant/conversation-attachment-routes.ts',
  'assistant/conversation-member-routes.ts',
  'conversations/membership.ts',
];

/** Every `.ts` source under core's `src`, tests left out. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** A refusal a door builds itself: only the input check's 'Invalid input' and a typed error's own message pass. */
function builtBeside(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(
    /new HTTPException\(\s*(\d+)\s*,\s*\{\s*message\b(?:\s*:\s*([^,}]+))?/g,
  )) {
    const message = (m[2] ?? 'message').trim();
    if (message === "'Invalid input'" || message === 'err.message') continue;
    out.push(`${m[1]} ${message.slice(0, 60)}`);
  }
  for (const m of source.matchAll(/\b(notFound|forbidden)\(/g)) out.push(m[0]);
  return out;
}

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

  it.each(ROOM_DOORS)('in %s is built through roomRefusal, never beside it', (file) => {
    expect(builtBeside(readFileSync(join(SRC, file), 'utf8'))).toEqual([]);
  });

  it('never says "conversation not found", anywhere in core', () => {
    const saying = sources(SRC).filter((path) =>
      /conversation not found/i.test(readFileSync(path, 'utf8')),
    );
    expect(saying).toEqual([]);
  });

  it('of a room that is gone says so, 404 CONVERSATION_GONE, its id in details alone', () => {
    const gone = roomGone('c-1');
    expect(gone.status).toBe(404);
    expect(gone.message).toBe('This room no longer exists.');
    expect(gone.cause).toEqual({ code: 'CONVERSATION_GONE', details: { conversationId: 'c-1' } });
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
