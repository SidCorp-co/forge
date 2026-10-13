import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { parseLoginApprove, parseLoginInit, parsePollCode } from './login-routes-reference.js';

function refusal(run: () => unknown): { status: number; message: string; code: unknown } {
  try {
    run();
  } catch (err) {
    if (err instanceof HTTPException) {
      return {
        status: err.status,
        message: err.message,
        code: (err.cause as { code?: string } | undefined)?.code,
      };
    }
    throw err;
  }
  throw new Error('expected a refusal');
}

const LABEL = 'device_label is required (1..100 chars)';
const PLATFORM = 'device_platform must be one of windows|macos|linux';

describe('login/init body', () => {
  it('reads a populated body, trimming and lower-casing as the handler always did', () => {
    expect(
      parseLoginInit({
        device_label: '  box  ',
        device_platform: ' Linux ',
        device_hostname: ' h ',
        machine_id: ' m ',
      }),
    ).toEqual({
      device_label: 'box',
      device_platform: 'linux',
      device_hostname: 'h',
      machine_id: 'm',
    });
  });

  it('treats a missing, empty or wrongly typed label as absent', () => {
    for (const device_label of [undefined, '', '   ', 5, null, ['x']]) {
      expect(refusal(() => parseLoginInit({ device_label, device_platform: 'linux' }))).toEqual({
        status: 400,
        message: LABEL,
        code: 'INVALID_BODY',
      });
    }
  });

  it('refuses a label of 101 characters and takes one of 100', () => {
    const long = { device_label: 'x'.repeat(101), device_platform: 'linux' };
    expect(refusal(() => parseLoginInit(long)).message).toBe(LABEL);
    const edge = { device_label: 'x'.repeat(100), device_platform: 'linux' };
    expect(parseLoginInit(edge).device_label).toHaveLength(100);
  });

  it('names the platform when it is absent or not one of the three', () => {
    for (const device_platform of [undefined, '', 'beos', 7]) {
      expect(refusal(() => parseLoginInit({ device_label: 'box', device_platform }))).toEqual({
        status: 400,
        message: PLATFORM,
        code: 'INVALID_BODY',
      });
    }
  });

  it('refuses a hostname over 100 characters, and ignores an empty or non-string one', () => {
    const base = { device_label: 'box', device_platform: 'macos' };
    const tooLong = { ...base, device_hostname: 'h'.repeat(101) };
    expect(refusal(() => parseLoginInit(tooLong)).message).toBe('device_hostname too long');
    expect(parseLoginInit({ ...base, device_hostname: '   ' }).device_hostname).toBe('');
    expect(parseLoginInit({ ...base, device_hostname: 4 }).device_hostname).toBeUndefined();
  });

  it('checks the label before the platform before the hostname', () => {
    const wrong = { device_platform: 'beos', device_hostname: 'h'.repeat(200) };
    expect(refusal(() => parseLoginInit(wrong)).message).toBe(LABEL);
    expect(refusal(() => parseLoginInit({ ...wrong, device_label: 'box' })).message).toBe(PLATFORM);
  });

  it('answers a body that is no object like an empty one: the label is required', () => {
    for (const raw of [null, 5, 'x', []]) {
      expect(refusal(() => parseLoginInit(raw)).message).toBe(LABEL);
    }
  });
});

describe('login/approve body', () => {
  const agent = '0b0e2f6a-7a37-4f55-9a43-61f1d2f0a111';

  it('takes a code with or without the dash, in any case', () => {
    expect(parseLoginApprove({ pairing_code: 'abc-def2' }).pairing_code).toBe('abc-def2');
    expect(parseLoginApprove({ pairing_code: 'ABCDEF2', agent_id: agent }).agent_id).toBe(agent);
    expect(parseLoginApprove({ pairing_code: 'ABCDEF2', agent_id: null }).agent_id).toBeNull();
  });

  it('refuses an absent, empty, short or wrongly typed code by name', () => {
    for (const pairing_code of [undefined, '', 'ABC', 'ABC-DEFGH', 'ABC-DEI2', 12, null]) {
      expect(refusal(() => parseLoginApprove({ pairing_code }))).toEqual({
        status: 400,
        message: 'invalid pairing_code',
        code: 'INVALID_PAIRING_CODE',
      });
    }
  });

  it('refuses an agent that is not a uuid, after the code', () => {
    for (const agent_id of ['', 'nope', 3, {}]) {
      expect(refusal(() => parseLoginApprove({ pairing_code: 'ABCDEF2', agent_id }))).toEqual({
        status: 400,
        message: 'agent_id must be a uuid',
        code: 'INVALID_BODY',
      });
    }
    const both = { pairing_code: 'x', agent_id: 'nope' };
    expect(refusal(() => parseLoginApprove(both)).code).toBe('INVALID_PAIRING_CODE');
  });
});

describe('login/poll query', () => {
  it('returns the code as typed when it is well formed', () => {
    expect(parsePollCode('ABC-DEF2')).toBe('ABC-DEF2');
  });

  it('refuses an absent, empty or malformed code by name', () => {
    for (const raw of [undefined, '', 'ABC', 'ABC-DEF2X', 'ABC-DEO2']) {
      expect(refusal(() => parsePollCode(raw))).toEqual({
        status: 400,
        message: 'invalid pairing_code',
        code: 'INVALID_PAIRING_CODE',
      });
    }
  });
});
