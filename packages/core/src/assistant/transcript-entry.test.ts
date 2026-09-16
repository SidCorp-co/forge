import { describe, expect, it } from 'vitest';
import type { ContentBlock, ToolCall } from '../lib/agent-stream-parser.js';
import type { ChatStreamEvent } from './providers/types.js';
import { createTranscriptAccumulator } from './transcript-entry.js';

function fold(events: ChatStreamEvent[]) {
  const acc = createTranscriptAccumulator({ id: 'e1', now: () => 1_000 });
  for (const e of events) acc.apply(e);
  return acc;
}

const call = (over: Partial<{ id: string; name: string; args: string }> = {}): ChatStreamEvent => ({
  type: 'tool_call',
  id: over.id ?? 'c1',
  name: over.name ?? 'forge_issues',
  arguments: over.args ?? '{"action":"list"}',
});

function toolOf(blocks: ContentBlock[] | null, at: number): ToolCall {
  const b = blocks?.[at];
  if (b?.type !== 'tool' || !b.toolCall) throw new Error(`no tool block at ${at}`);
  return b.toolCall;
}

function textOf(blocks: ContentBlock[] | null, at: number): string {
  const b = blocks?.[at];
  if (b?.type !== 'text' || b.text === undefined) throw new Error(`no text block at ${at}`);
  return b.text;
}

describe('the assistant turn accumulates one canonical entry', () => {
  it('keeps prose, the call and the prose after it as three ordered blocks', () => {
    const acc = fold([
      { type: 'chunk', text: 'Let me ' },
      { type: 'chunk', text: 'look.' },
      call(),
      { type: 'tool_result', id: 'c1', result: 'two issues', durationMs: 12 },
      { type: 'chunk', text: 'You have two.' },
    ]);

    const blocks = acc.blocks();
    expect(blocks?.map((b) => b.type)).toEqual(['text', 'tool', 'text']);
    expect(textOf(blocks, 0)).toBe('Let me look.');
    expect(textOf(blocks, 2)).toBe('You have two.');
  });

  it('carries the tool name and the arguments the model sent', () => {
    const tc = toolOf(fold([call({ args: '{"action":"list","limit":5}' })]).blocks(), 0);
    expect(tc.name).toBe('forge_issues');
    expect(tc.input).toEqual({ action: 'list', limit: 5 });
  });

  it('settles the returned text onto the call that asked for it', () => {
    const tc = toolOf(
      fold([call(), { type: 'tool_result', id: 'c1', result: 'two issues' }]).blocks(),
      0,
    );
    expect(tc.output).toBe('two issues');
  });

  it('marks a failed result on its own block', () => {
    const tc = toolOf(
      fold([call(), { type: 'tool_result', id: 'c1', result: 'boom', isError: true }]).blocks(),
      0,
    );
    expect(tc.isError).toBe(true);
    expect(tc.output).toBe('boom');
  });

  it('keeps the measured duration of the call', () => {
    const tc = toolOf(
      fold([call(), { type: 'tool_result', id: 'c1', result: 'ok', durationMs: 87 }]).blocks(),
      0,
    );
    expect(tc.durationMs).toBe(87);
  });

  it('settles each call of a round onto its own block', () => {
    const acc = fold([
      call({ id: 'a' }),
      call({ id: 'b', name: 'forge_memory' }),
      { type: 'tool_result', id: 'a', result: 'first', durationMs: 1 },
      { type: 'tool_result', id: 'b', result: 'second', isError: true, durationMs: 2 },
    ]);
    const blocks = acc.blocks();
    expect(toolOf(blocks, 0).output).toBe('first');
    expect(toolOf(blocks, 0).isError).toBeUndefined();
    expect(toolOf(blocks, 1).output).toBe('second');
    expect(toolOf(blocks, 1).isError).toBe(true);
  });

  it('gives a turn that called no tool a single text block', () => {
    const blocks = fold([{ type: 'chunk', text: 'hi' }]).blocks();
    expect(blocks).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('has nothing to store for a turn that produced nothing', () => {
    expect(fold([]).blocks()).toBeNull();
    expect(fold([{ type: 'chunk', text: '' }]).blocks()).toBeNull();
    expect(fold([]).entry()).toBeNull();
  });

  it('is an assistant entry', () => {
    const entry = fold([{ type: 'chunk', text: 'hi' }]).entry();
    expect(entry?.type).toBe('assistant');
    expect(entry?.content).toBe('hi');
  });

  it('refuses a result naming a call this turn never made, by name', () => {
    const acc = fold([call({ id: 'c1' })]);
    expect(() => acc.apply({ type: 'tool_result', id: 'nope', result: 'x' })).toThrow(/nope/);
    expect(() => acc.apply({ type: 'tool_result', id: 'nope', result: 'x' })).toThrow(/c1/);
  });

  it('refuses a result when the turn has made no call at all', () => {
    const acc = fold([{ type: 'chunk', text: 'hi' }]);
    expect(() => acc.apply({ type: 'tool_result', id: 'c1', result: 'x' })).toThrow(/none/);
  });

  it('keeps arguments it cannot parse rather than reporting none', () => {
    const tc = toolOf(fold([call({ args: 'not json at all' })]).blocks(), 0);
    expect(tc.input).toEqual({ arguments: 'not json at all' });
  });

  it('reads an empty argument string as no arguments', () => {
    expect(toolOf(fold([call({ args: '' })]).blocks(), 0).input).toEqual({});
  });
});
