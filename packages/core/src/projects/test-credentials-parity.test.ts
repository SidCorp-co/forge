import { findCredentialFaults } from '@forge/contracts/test-credentials';
import { describe, expect, it } from 'vitest';
import { credentialFaults } from './environments.js';

/**
 * `@forge/contracts/test-credentials` `findCredentialFaults` is the settings form's copy of the rule this write
 * door holds, and core may not import that entry at runtime. This file is what keeps the two
 * equal: a rule changed on one side alone leaves the form passing what the server refuses.
 */

const row = (label: string, username: string, password: string) => ({ label, username, password });

const CASES: Record<string, unknown[]> = {
  'no password': [row('QA', 'qa', '')],
  'a password of spaces': [row('QA', 'qa', '   ')],
  'a label repeated in another case': [row('QA', 'a', 'x'), row(' qa ', 'b', 'y')],
  'one login under two labels': [row('Admin', 'qa@x', 's'), row('Owner', 'QA@x', 's')],
  'a repeated label then a repeated login': [
    row('A', 'u1', 'p'),
    row('A', 'u2', 'p'),
    row('B', 'u2', 'p'),
  ],
  'a repeated label with no password': [row('QA', 'qa', 'x'), row('QA', 'qa', '')],
  'one username, two passwords': [row('Preview', 'qa', 'one'), row('Live', 'qa', 'two')],
  'an unlabelled row': [row('', 'x', ''), row('B', 'b', 'p')],
  'something that is not a row': [null, 'QA', row('QA', 'qa', 'p')],
};

describe('credentialFaults agrees with the settings form', () => {
  it.each(Object.entries(CASES))('on %s', (_name, rows) => {
    const core = credentialFaults(rows).map(
      ({ path: _path, message: _message, ...finding }) => finding,
    );
    expect(core).toEqual(findCredentialFaults(rows));
  });

  it('names a fault on at least one case, so agreement is not two empty lists', () => {
    expect(Object.values(CASES).filter((rows) => credentialFaults(rows).length > 0)).toHaveLength(
      6,
    );
  });
});
