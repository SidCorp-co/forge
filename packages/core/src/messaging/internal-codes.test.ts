import { describe, expect, it } from 'vitest';
import {
  FORGE_KEY_PREFIXES,
  internalCodeRefusals,
  internalCodesIn,
  keyPrefixesOf,
} from './internal-codes.js';

// ISS-1107: a token is an issue key only when its prefix is one Forge issues, never for its shape,
// so a store's order number with a letter prefix (FB-565, RIV-68493) passes, and ISS-123 does not.
describe('internalCodesIn: issue keys are read by the prefixes Forge issues', () => {
  const prefixes = keyPrefixesOf(['AF', 'FP2'], []);

  it('passes an order number whose prefix no Forge record carries', () => {
    expect(internalCodesIn('Orders RIV-68493 and RIV-68340 shipped.', prefixes)).toEqual([]);
  });

  it.each(['ISS-123', 'FB-565', 'REQ-77', 'MK-10', 'BC-8', 'L-65', 'AF-12', 'FP2-3'])(
    'refuses %s, a key Forge issues',
    (key) => {
      expect(internalCodesIn(`See ${key} please.`, prefixes)).toEqual([
        { kind: 'issue key', quote: key },
      ]);
    },
  );

  it('refuses a key in any case the shape takes, never a word that only ends in one', () => {
    expect(internalCodesIn('ISS-123', prefixes)).toHaveLength(1);
    expect(internalCodesIn('MISS-123 and BISS-4', prefixes)).toEqual([]);
  });

  it('passes a code the project declared its own, and still refuses the other prefixes', () => {
    const declared = keyPrefixesOf(['AF'], ['FB']);
    expect(internalCodesIn('Order FB-68493', declared)).toEqual([]);
    expect(internalCodesIn('ISS-123 FB-68493', declared)).toEqual([
      { kind: 'issue key', quote: 'ISS-123' },
    ]);
  });

  it('reads a declared code by its prefix whatever case it was written in', () => {
    expect(internalCodesIn('AF-1', keyPrefixesOf(['AF'], ['af']))).toEqual([]);
  });

  it('carries the prefixes core mints for its own records', () => {
    expect([...FORGE_KEY_PREFIXES].sort()).toEqual(['BC', 'FB', 'ISS', 'L', 'MK', 'REQ']);
  });

  it("the refusal of a key names the door a project's own code goes through", () => {
    const [refusal] = internalCodeRefusals('ISS-123', 'a room', prefixes);
    expect(refusal?.rule).toBe('SUPPORT_INTERNAL_CODE');
    expect(refusal?.shape).toMatch(/userFacingCodes/);
  });
});
