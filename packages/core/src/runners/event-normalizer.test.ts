import { describe, expect, it } from 'vitest';
import { normalizeAntigravityEvent } from './event-normalizer.js';

describe('normalizeAntigravityEvent', () => {
  it('maps tool_started -> tool_call', () => {
    const out = normalizeAntigravityEvent({
      type: 'tool_started',
      data: { tool: 'Read', args: { path: 'foo.ts' } },
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('tool_call');
    expect((out[0]?.data as Record<string, unknown>)['tool']).toBe('Read');
  });

  it('maps tool_finished -> tool_result', () => {
    const out = normalizeAntigravityEvent({
      type: 'tool_finished',
      data: { tool: 'Read', result: 'ok' },
    });
    expect(out[0]?.kind).toBe('tool_result');
  });

  it('maps assistant_chunk -> stdout when text present', () => {
    const out = normalizeAntigravityEvent({ type: 'assistant_chunk', data: { text: 'hi' } });
    expect(out[0]?.kind).toBe('stdout');
    expect((out[0]?.data as Record<string, unknown>)['text']).toBe('hi');
  });

  it('drops assistant_chunk when text is missing', () => {
    expect(normalizeAntigravityEvent({ type: 'assistant_chunk', data: {} })).toEqual([]);
  });

  it('maps error -> stderr', () => {
    const out = normalizeAntigravityEvent({ type: 'error', data: { message: 'boom' } });
    expect(out[0]?.kind).toBe('stderr');
  });

  it('maps done -> result', () => {
    const out = normalizeAntigravityEvent({ type: 'done', data: { exit: 0 } });
    expect(out[0]?.kind).toBe('result');
  });

  it('drops unknown event types', () => {
    expect(normalizeAntigravityEvent({ type: 'mystery', data: {} })).toEqual([]);
  });

  it('preserves the raw wire envelope (type+timestamp only) for forensics', () => {
    const wire = { type: 'tool_started', data: { tool: 'Bash' }, timestamp: '2026-04-26T00:00:00Z' };
    const out = normalizeAntigravityEvent(wire);
    expect((out[0]?.data as Record<string, unknown>)['_raw']).toEqual({
      type: 'tool_started',
      timestamp: '2026-04-26T00:00:00Z',
    });
  });
});
