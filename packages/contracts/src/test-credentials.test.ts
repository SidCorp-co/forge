import { describe, expect, it } from 'vitest';
import { findCredentialFaults } from './test-credentials.js';

const row = (label: string, username: string, password: string) => ({ label, username, password });

describe('findCredentialFaults', () => {
  it('names a labelled row with no password, or a password of spaces', () => {
    expect(findCredentialFaults([row('QA', 'qa', ''), row('B', 'b', '  ')])).toEqual([
      { index: 0, field: 'password', rule: 'password-required' },
      { index: 1, field: 'password', rule: 'password-required' },
    ]);
  });

  it('names each fault of a row on its own: a repeated label and a repeated login', () => {
    expect(
      findCredentialFaults([row('A', 'u1', 'p'), row('a ', 'u2', 'p'), row('B', 'U2', 'p')]),
    ).toEqual([
      { index: 1, field: 'label', rule: 'duplicate-label', sameAs: 0 },
      { index: 2, field: 'username', rule: 'duplicate-login', sameAs: 1 },
    ]);
  });

  it('names a repeated label and a missing password on one row both', () => {
    expect(findCredentialFaults([row('QA', 'qa', 'x'), row('QA', 'qa', '')])).toEqual([
      { index: 1, field: 'label', rule: 'duplicate-label', sameAs: 0 },
      { index: 1, field: 'password', rule: 'password-required' },
    ]);
  });

  it('keeps one username with two passwords, which are two logins, and leaves unlabelled rows to the schema', () => {
    expect(
      findCredentialFaults([
        row('Preview', 'qa', 'one'),
        row('Live', 'qa', 'two'),
        row('', 'x', ''),
      ]),
    ).toEqual([]);
  });
});
