import { describe, expect, it } from 'vitest';
import { detectStateConfab } from './confab.js';
import type { ToolCallRecord } from './run-turn-core.js';

const DRAFT = '0b6f3c1e-2a4d-4e8f-9a1b-3c5d7e9f1a2b';

const channel = (args: Record<string, unknown>, isError: boolean): ToolCallRecord => ({
  name: 'forge_channel',
  arguments: JSON.stringify(args),
  round: 1,
  isError,
  durationMs: 1,
  resultPreview: '',
  resultIssueRefs: [],
  ranAs: 'person',
});

describe('a reply claiming a refused channel write', () => {
  it('is caught when a refused submit by uuid is told as sent', () => {
    const probe = detectStateConfab('FP-CN-1 has been sent to the plugin team.', [
      channel({ action: 'submit', ref: DRAFT }, true),
    ]);
    expect(probe.claims).toEqual([
      {
        tool: 'forge_channel',
        subject: null,
        sentence: 'FP-CN-1 has been sent to the plugin team.',
      },
    ]);
  });

  it('is caught by its number when a refused hold is told as held', () => {
    const probe = detectStateConfab('I have held FP-CR-1 until we talk.', [
      channel({ action: 'hold', thread: 'FP-CR-1', reason: 'talk' }, true),
    ]);
    expect(probe.claims.map((c) => c.subject)).toEqual(['FP-CR-1']);
  });

  it('keeps a channel number whole, so another conversation numbered 1 is not confused with it', () => {
    const probe = detectStateConfab('I have held FP-RFI-1.', [
      channel({ action: 'hold', thread: 'FP-CR-1', reason: 'x' }, true),
    ]);
    expect(probe.suspected).toBe(false);
  });

  it('is not raised when the reply says the write was refused', () => {
    const probe = detectStateConfab('FP-CN-1 was not sent: the channel refused it.', [
      channel({ action: 'submit', ref: DRAFT }, true),
    ]);
    expect(probe.suspected).toBe(false);
  });

  it('is not raised for a write that landed, or for a refused read', () => {
    expect(
      detectStateConfab('FP-CN-1 has been sent.', [
        channel({ action: 'submit', ref: DRAFT }, false),
      ]).suspected,
    ).toBe(false);
    expect(
      detectStateConfab('FP-CN-1 has been sent.', [
        channel({ action: 'read', ref: 'FP-CN-1' }, true),
      ]).suspected,
    ).toBe(false);
  });
});
