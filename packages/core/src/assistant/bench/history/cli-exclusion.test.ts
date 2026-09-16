/**
 * ISS-1065 — the bench rooms history drops without a run file: a gone room whose every row is a
 * shipped task's message, counted apart; a person's mixed session and a standing room stay; and an
 * older file without the two keys reads as none.
 */

import { describe, expect, it } from 'vitest';
import { main } from '../cli.js';
import { createClient } from '../client.js';
import { FAKE_PROJECT, FAKE_TOKEN } from '../fake-deployment.js';
import { BENCH_ROOM, deps, ENV, fake, HISTORY, runFile, seed, seededRows } from './cli-ground.js';
import { readHistoryResult } from './result.js';

describe('history: bench rooms by task message', () => {
  it('excludes a gone room whose every row is a shipped task message, counts it apart, and keeps a mixed session and a standing room (ISS-1065)', async () => {
    const { fetch } = fake([
      ...seededRows(),
      // a bench room whose run file is lost: two task messages, the room deleted with a read-back
      seed({ sessionId: 'lost-bench', query: 'Which project is this room scoped to? Name it.' }),
      seed({ sessionId: 'lost-bench', query: 'How many open issues does it have?' }),
      // a person who asked one task-shaped question and then something else, room gone
      seed({ sessionId: 'person-mixed', query: 'How many open issues does it have?' }),
      seed({ sessionId: 'person-mixed', query: 'And who is on call?' }),
      // a person whose one query is a task's message, room still standing
      seed({
        sessionId: 'room-0001',
        query: 'Summarize what this project is about in one message.',
      }),
    ]);
    const client = createClient({ api: 'https://api.test', fetch });
    client.useToken(FAKE_TOKEN);
    expect((await client.openRoom(FAKE_PROJECT.id, 'a person’s room')).id).toBe('room-0001');
    const { d, out, written } = deps(fetch, { '/tmp/run.json': runFile() });
    expect(await main([...HISTORY, '--exclude', '/tmp/run.json'], ENV, d)).toBe(0);
    const h = readHistoryResult(written['/tmp/h.json'] ?? '');
    expect(h.excludedSessions).toEqual([BENCH_ROOM]);
    expect(h.excludedRows).toBe(2);
    expect(h.excludedSessionsByTask).toEqual(['lost-bench']);
    expect(h.excludedRowsByTask).toBe(2);
    expect(h.groups.reduce((n, g) => n + g.rows, 0)).toBe(4 + 3);
    expect(out.at(-1)).toBe(
      'excluded 2 row(s) of 1 bench room(s) by run file and 2 row(s) of 1 by task message; wrote /tmp/h.json',
    );
  });

  it('reads a history file written before the by-task exclusion as an empty list and zero', () => {
    const { d, written } = deps(fake().fetch);
    return main(HISTORY, ENV, d).then(() => {
      const file = JSON.parse(written['/tmp/h.json'] ?? '') as Record<string, unknown>;
      delete file.excludedSessionsByTask;
      delete file.excludedRowsByTask;
      const h = readHistoryResult(JSON.stringify(file));
      expect(h.excludedSessionsByTask).toEqual([]);
      expect(h.excludedRowsByTask).toBe(0);
    });
  });
});
