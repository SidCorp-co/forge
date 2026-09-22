import { describe, expect, it } from 'vitest';
import {
  CLIENT_CAPABILITIES,
  declares,
  NO_CAPABILITIES,
  parseClientCapabilities,
  RECORD_ROUTE_CAPABILITY,
} from './client-capabilities.js';

describe('parseClientCapabilities', () => {
  it('reads nothing from an absent header, which is the dormancy', () => {
    expect(parseClientCapabilities(undefined).size).toBe(0);
    expect(parseClientCapabilities(null).size).toBe(0);
    expect(parseClientCapabilities('').size).toBe(0);
    expect(parseClientCapabilities('   ').size).toBe(0);
  });

  it('reads comma and space separated tokens, case-folded', () => {
    const caps = parseClientCapabilities('Record-Route, something-else  third');
    expect([...caps].sort()).toEqual(['record-route', 'something-else', 'third']);
  });

  it('ignores a token this build has never heard of rather than refusing it', () => {
    const caps = parseClientCapabilities('a-capability-from-2027');
    expect(declares(caps, RECORD_ROUTE_CAPABILITY)).toBe(false);
    expect(caps.size).toBe(1);
  });

  it('declares record-route only when the header names it', () => {
    expect(declares(parseClientCapabilities('record-route'), RECORD_ROUTE_CAPABILITY)).toBe(true);
    expect(declares(parseClientCapabilities('record-routes'), RECORD_ROUTE_CAPABILITY)).toBe(false);
    expect(declares(NO_CAPABILITIES, RECORD_ROUTE_CAPABILITY)).toBe(false);
  });

  it('names record-route among the tokens this build gives meaning to', () => {
    expect(CLIENT_CAPABILITIES).toContain(RECORD_ROUTE_CAPABILITY);
  });
});
