// ISS-34 — a tool result's issue references are issues, never the tail of a channel number.

import { describe, expect, it } from 'vitest';
import { issueRefsIn } from './run-turn-core.js';

describe('issueRefsIn', () => {
  it('names each issue a result carries, once, upper-cased', () => {
    expect(issueRefsIn('ISS-12 blocks iss-7; ISS-12 again')).toEqual(['ISS-12', 'ISS-7']);
  });

  it('reads no issue out of a channel document number', () => {
    expect(issueRefsIn('UQ-CR-3, UQ-RFI-12 and UQ-CN-1 are open; FP-ACK-3 replaced it')).toEqual(
      [],
    );
  });

  it('still names an issue that sits beside a channel number', () => {
    expect(issueRefsIn('{"number":"UQ-CR-2","issue":"ISS-34"}')).toEqual(['ISS-34']);
  });

  it('reads an issue that leads a hyphenated token, and none that ends one', () => {
    expect(issueRefsIn('ISS-34-uifix is its branch; ab-ISS-4 names no issue')).toEqual(['ISS-34']);
  });
});
