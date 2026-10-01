import { describe, expect, it } from 'vitest';
import { correctFalseClaims, detectStateConfab } from './confab.js';
import { refusalCodeOf } from './refusal-code.js';
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
  refusalCode: isError ? 'CHANNEL_WRITE_NOT_AUTHORISED' : null,
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
        action: 'submit',
        target: DRAFT,
        refusalCode: 'CHANNEL_WRITE_NOT_AUTHORISED',
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

describe('the correction a caught claim puts in front of the person', () => {
  const refusedSubmit = channel({ action: 'submit', ref: DRAFT }, true);

  it('names the refused action, its code, and that nothing was written', () => {
    const { text } = correctFalseClaims('FP-CN-1 has been sent to the plugin team.', [
      refusedSubmit,
    ]);
    expect(text).toBe(
      `FP-CN-1 has been sent to the plugin team.\n\nCorrection: the submit of ${DRAFT} was refused (CHANNEL_WRITE_NOT_AUTHORISED); nothing was written.`,
    );
  });

  it('corrects an issue write the same way', () => {
    const cli: ToolCallRecord = {
      ...refusedSubmit,
      name: 'forge',
      arguments: JSON.stringify({ argv: ['comment', 'ISS-7', '-'] }),
      refusalCode: 'FORBIDDEN',
    };
    expect(correctFalseClaims('I have updated ISS-7 with your note.', [cli]).text).toContain(
      'Correction: the forge comment of ISS-7 was refused (FORBIDDEN); nothing was written.',
    );
  });

  it('leaves an honest reply after a refused write untouched', () => {
    const honest =
      'I could not send it: you are a viewer on this project, so the channel refused it.';
    expect(correctFalseClaims(honest, [refusedSubmit]).text).toBe(honest);
  });

  it('corrects once, however many times the reply passes through', () => {
    const once = correctFalseClaims('FP-CN-1 has been sent.', [refusedSubmit]).text;
    expect(correctFalseClaims(once, [refusedSubmit]).text).toBe(once);
  });
});

describe('the code a refused result names', () => {
  it('reads error.code, a leading CODE:, and an UPPER_SNAKE token', () => {
    expect(
      refusalCodeOf(JSON.stringify({ error: { code: 'CHANNEL_NO_ROLE', refusals: [] } })),
    ).toBe('CHANNEL_NO_ROLE');
    expect(refusalCodeOf(JSON.stringify({ error: 'FORBIDDEN: needs issues:write' }))).toBe(
      'FORBIDDEN',
    );
    expect(refusalCodeOf('exit 1: PAT_GRANT_PREDATES_ROUTE for this call')).toBe(
      'PAT_GRANT_PREDATES_ROUTE',
    );
    expect(refusalCodeOf('it did not work')).toBeNull();
  });
});
