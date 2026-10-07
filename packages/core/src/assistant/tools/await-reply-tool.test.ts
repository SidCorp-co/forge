import { describe, expect, it } from 'vitest';
import { AWAIT_REPLY_TOOL_NAME, awaitReplyCapture } from './await-reply-tool.js';

describe('await_reply', () => {
  it('declares nothing until the model calls it, and declares once it has', async () => {
    const capture = awaitReplyCapture();
    expect(capture.toolset.tools.map((t) => t.function.name)).toEqual([AWAIT_REPLY_TOOL_NAME]);
    expect(capture.declared()).toBe(false);
    const result = await capture.toolset.execute(AWAIT_REPLY_TOOL_NAME, '{}');
    expect(result.isError).not.toBe(true);
    expect(capture.declared()).toBe(true);
  });

  it('takes an empty argument string as no arguments', async () => {
    const capture = awaitReplyCapture();
    await capture.toolset.execute(AWAIT_REPLY_TOOL_NAME, '  ');
    expect(capture.declared()).toBe(true);
  });

  it('refuses arguments by name and declares nothing', async () => {
    for (const args of ['{"question":"Shall I?"}', 'not json', '[]', 'null']) {
      const capture = awaitReplyCapture();
      const result = await capture.toolset.execute(AWAIT_REPLY_TOOL_NAME, args);
      expect(result.isError).toBe(true);
      expect(capture.declared()).toBe(false);
    }
  });

  it('answers another tool name as unknown', async () => {
    const capture = awaitReplyCapture();
    const result = await capture.toolset.execute('room_send', '{}');
    expect(result.isError).toBe(true);
    expect(capture.declared()).toBe(false);
  });

  it('is one capture per attempt: a second capture starts undeclared', async () => {
    const first = awaitReplyCapture();
    await first.toolset.execute(AWAIT_REPLY_TOOL_NAME, '{}');
    expect(awaitReplyCapture().declared()).toBe(false);
  });
});
