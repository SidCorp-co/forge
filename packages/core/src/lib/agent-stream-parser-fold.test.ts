/**
 * ISS-1020 — the resumable half of `agent-stream-parser`, kept apart from
 * `agent-stream-parser.test.ts` because it asserts a different thing about the
 * same module: not what one line parses to, but that the fold gives the same
 * answer however the events are cut into passes.
 */

import { describe, expect, it } from 'vitest';
import {
  applyEventsToState,
  buildSessionFromEvents,
  createDeriveState,
  type DerivedSession,
  type JobEventLike,
} from './agent-stream-parser.js';

/**
 * ISS-1020 — an incremental derive resumes this fold rather than re-running it
 * from event 1. The claim these cases have to be able to break is that folding
 * `k+1..n` onto the state `1..k` left is the same computation as folding
 * `1..n`: if it is not, a live transcript is quietly wrong for the rest of the
 * job, and nothing downstream can tell.
 */
describe('applyEventsToState', () => {
  /** A stream carrying every shape the fold treats statefully: an assistant
   *  continuation that rewrites the tail, a tool result that settles a call
   *  emitted by an earlier event, a todos block replaced in place, a second
   *  tool call whose result lands three events later, and the id factory
   *  running throughout. */
  const stream: JobEventLike[] = [
    {
      kind: 'stdout',
      ts: 1_000,
      data: { line: { type: 'system', subtype: 'init', session_id: 'claude-xyz' } },
    },
    {
      kind: 'stdout',
      ts: 1_100,
      data: {
        line: {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'starting' }], model: 'opus' },
        },
      },
    },
    {
      kind: 'stdout',
      ts: 1_200,
      data: {
        line: {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a.ts' } }],
          },
        },
      },
    },
    {
      kind: 'stdout',
      ts: 1_900,
      data: {
        line: {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { cmd: 'ls' } }],
          },
        },
      },
    },
    { kind: 'progress', ts: 2_000, data: { claudeSessionId: 'claude-xyz' } },
    {
      kind: 'stdout',
      ts: 2_400,
      data: {
        line: {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
        },
      },
    },
    {
      kind: 'stdout',
      ts: 2_800,
      data: {
        line: {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true }],
          },
        },
      },
    },
    {
      kind: 'stdout',
      ts: 3_000,
      data: {
        line: {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'TodoWrite',
                input: { todos: [{ content: 'one', status: 'pending' }] },
              },
            ],
          },
        },
      },
    },
    {
      kind: 'stdout',
      ts: 3_100,
      data: {
        line: {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'TodoWrite',
                input: { todos: [{ content: 'one', status: 'completed' }] },
              },
            ],
          },
        },
      },
    },
    {
      kind: 'stdout',
      ts: 3_400,
      data: {
        line: { type: 'user', message: { content: [{ type: 'text', text: 'not a tool result' }] } },
      },
    },
    {
      kind: 'stdout',
      ts: 3_900,
      data: { line: { type: 'result', total_cost_usd: 0.42, duration_ms: 2_900, num_turns: 4 } },
    },
  ];

  function foldInTwo(at: number): DerivedSession {
    const state = createDeriveState();
    applyEventsToState(state, stream.slice(0, at));
    applyEventsToState(state, stream.slice(at));
    return { messages: state.messages, claudeSessionId: state.claudeSessionId };
  }

  it('folding at any split point equals folding the whole stream at once', () => {
    const whole = buildSessionFromEvents(stream);
    expect(whole.messages.length).toBeGreaterThan(1);
    for (let at = 0; at <= stream.length; at++) {
      expect(foldInTwo(at), `split after event ${at}`).toEqual(whole);
    }
  });

  it('settles a tool result whose call was folded in an earlier pass', () => {
    // cm:why split at 4 and no other number: t1's tool_use is event 2 and its tool_result is event 5, so this is the split that puts the settle in a later pass than the call it settles — the case a plain seq cursor with an append would lose.
    const split = foldInTwo(4);
    const call = split.messages.flatMap((m) => m.toolCalls ?? []).find((t) => t.id === 't1');
    expect(call?.output).toBe('file body');
    expect(call?.durationMs).toBe(1_200);
    expect(buildSessionFromEvents(stream)).toEqual(split);
  });

  it('carries the error flag of a tool result settled in a later pass', () => {
    const call = foldInTwo(4)
      .messages.flatMap((m) => m.toolCalls ?? [])
      .find((t) => t.id === 't2');
    expect(call?.isError).toBe(true);
    expect(call?.output).toBe('boom');
  });

  it('issues no id twice across passes', () => {
    const ids = foldInTwo(5).messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a pass over no events leaves the state exactly as it was', () => {
    const state = createDeriveState();
    applyEventsToState(state, stream);
    const before = structuredClone(state.messages);
    applyEventsToState(state, []);
    expect(state.messages).toEqual(before);
  });
});
