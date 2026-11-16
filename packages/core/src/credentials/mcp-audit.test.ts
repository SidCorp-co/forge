// ISS-1251: a refused call is logged with the code it answered with, so door use reads refusals by
// code; a refusal a door answered rather than threw is a refused call, never an ok.
//
// @direct-test-of packages/core/src/credentials/mcp-audit.ts

import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { answeredAudit, refusalCodeOfBody } = await import('./mcp-audit.js');

describe('the audit log of an answered call', () => {
  it('logs a refusal the door answered under its status and code, never as ok', () => {
    expect(
      answeredAudit({ _mcpIsError: true, status: 404, code: 'SUPPORT_MESSAGE_UNKNOWN' }),
    ).toEqual({ resultCode: 'not_found', refusalCode: 'SUPPORT_MESSAGE_UNKNOWN' });
    expect(
      answeredAudit({ _mcpIsError: true, status: 409, error: { code: 'SUPPORT_NOT_REPEATED' } }),
    ).toEqual({ resultCode: 'error', refusalCode: 'SUPPORT_NOT_REPEATED' });
    expect(answeredAudit({ _mcpIsError: true, code: 'X_REFUSED' })).toEqual({
      resultCode: 'error',
      refusalCode: 'X_REFUSED',
    });
  });

  it('logs an answer that is no refusal as ok, with no code', () => {
    expect(answeredAudit({ code: 'NOT_A_REFUSAL', items: [] })).toEqual({
      resultCode: 'ok',
      refusalCode: null,
    });
    expect(answeredAudit(null)).toEqual({ resultCode: 'ok', refusalCode: null });
  });

  it('reads a code only where the body names one in the envelope’s shape', () => {
    expect(refusalCodeOfBody({ error: { code: 'LESSON_NOT_APPLICABLE' } })).toBe(
      'LESSON_NOT_APPLICABLE',
    );
    expect(refusalCodeOfBody({ code: 42 })).toBeNull();
    expect(refusalCodeOfBody({ code: 'has spaces in it' })).toBeNull();
    expect(refusalCodeOfBody('MERGE_CHECK_MISSING')).toBeNull();
  });
});
