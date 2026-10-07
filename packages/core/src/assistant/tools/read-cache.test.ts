import { describe, expect, it } from 'vitest';
import { cachedReads, readCacheKey } from './read-cache.js';

function counting() {
  const calls: string[] = [];
  let fail = false;
  return {
    calls,
    failNext: () => {
      fail = true;
    },
    tools: {
      tools: [],
      ranAs: () => null,
      async execute(name: string, argsJson: string) {
        calls.push(`${name} ${argsJson}`);
        if (fail) {
          fail = false;
          return {
            content: [{ type: 'text' as const, text: 'EMBEDDING_UNAVAILABLE' }],
            isError: true,
          };
        }
        return { content: [{ type: 'text' as const, text: `result ${calls.length}` }] };
      },
    },
  };
}

const SEARCH = JSON.stringify({ action: 'search', query: 'export' });
const SEARCH_REORDERED = JSON.stringify({ query: 'export', action: 'search' });
const GUIDE = JSON.stringify({ argv: ['guide', 'issue-dependencies'] });

describe('a room serves its repeated reads from its own earlier read', () => {
  it('runs a knowledge, memory or guide read once per room, whatever the key order', async () => {
    const t = counting();
    const room = cachedReads(`room-${Math.random()}`, t.tools);
    await room?.execute('forge_knowledge', SEARCH);
    const again = await room?.execute('forge_knowledge', SEARCH_REORDERED);
    await room?.execute('forge_memory', SEARCH);
    await room?.execute('forge_memory', SEARCH);
    await room?.execute('forge', GUIDE);
    await room?.execute('forge', GUIDE);
    expect(t.calls).toHaveLength(3);
    const said = again?.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(said).toContain("Served from this conversation's own read");
    expect(said).toContain('result 1');
  });

  it('never caches a tracker read, a write, a refused read, or another room', async () => {
    const t = counting();
    const id = `room-${Math.random()}`;
    const room = cachedReads(id, t.tools);
    const issue = JSON.stringify({ argv: ['issue', 'ISS-61'] });
    await room?.execute('forge', issue);
    await room?.execute('forge', issue);
    t.failNext();
    await room?.execute('forge_memory', SEARCH);
    await room?.execute('forge_memory', SEARCH);
    await cachedReads(`other-${Math.random()}`, t.tools)?.execute('forge_memory', SEARCH);
    expect(t.calls).toHaveLength(5);
  });

  it('forgets what it held once a note is written to memory, and after ten minutes', async () => {
    const t = counting();
    let now = 0;
    const id = `room-${Math.random()}`;
    const room = cachedReads(id, t.tools, () => now);
    await room?.execute('forge_memory', SEARCH);
    await room?.execute('forge_memory_note', JSON.stringify({ note: 'x' }));
    await room?.execute('forge_memory', SEARCH);
    now = 10 * 60 * 1000 + 1;
    await room?.execute('forge_memory', SEARCH);
    expect(t.calls.filter((c) => c.startsWith('forge_memory ')).length).toBe(3);
  });

  it('keys only the reads it may hold', () => {
    expect(readCacheKey('forge_knowledge', JSON.stringify({ action: 'write' }))).toBeNull();
    expect(
      readCacheKey('forge', JSON.stringify({ argv: ['knowledge', 'search', 'x'] })),
    ).not.toBeNull();
    expect(readCacheKey('forge', JSON.stringify({ argv: ['new', '-'], body: 'x' }))).toBeNull();
    expect(readCacheKey('forge', 'not json')).toBeNull();
  });
});
