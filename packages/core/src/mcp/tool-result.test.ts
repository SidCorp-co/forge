import { describe, expect, it } from 'vitest';
import { toToolCallContent } from './tool-result.js';

describe('toToolCallContent', () => {
  it('JSON-wraps a plain object result (backward-compatible default)', () => {
    const out = toToolCallContent({ documentId: 'x', attachments: [] });
    expect(out.content).toEqual([
      { type: 'text', text: JSON.stringify({ documentId: 'x', attachments: [] }) },
    ]);
    expect(out.structuredContent).toEqual({ documentId: 'x', attachments: [] });
  });

  it('wraps a scalar result under { value }', () => {
    const out = toToolCallContent('hello');
    expect(out.content).toEqual([{ type: 'text', text: JSON.stringify('hello') }]);
    expect(out.structuredContent).toEqual({ value: 'hello' });
  });

  it('passes _mcpContent blocks through as content (image vision opt-in)', () => {
    const out = toToolCallContent({
      _mcpContent: [
        { type: 'text', text: 'Attachment "shot.png":' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
      attachmentId: 'a-1',
      inlined: true,
    });
    expect(out.content).toEqual([
      { type: 'text', text: 'Attachment "shot.png":' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]);
    // The non-_mcpContent keys still ride along as structuredContent.
    expect(out.structuredContent).toEqual({ attachmentId: 'a-1', inlined: true });
  });

  it('omits structuredContent when _mcpContent is the only key', () => {
    const out = toToolCallContent({ _mcpContent: [{ type: 'text', text: 'hi' }] });
    expect(out.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(out.structuredContent).toBeUndefined();
  });

  it('does NOT treat a non-array _mcpContent as content blocks', () => {
    const out = toToolCallContent({ _mcpContent: 'oops' });
    // Falls through to the JSON wrapper.
    expect(out.content[0]?.type).toBe('text');
    expect(out.structuredContent).toEqual({ _mcpContent: 'oops' });
  });
});
