// ISS-614 (FB-204): a verdict reason citing a record id such as task-<24 hex> is written, a real
// credential is still refused, and the refusal names the span it read without sending it back.

import { describe, expect, it } from 'vitest';
import { type VerdictDraft, verdictDraftFault } from './verdict-input.js';

const SHA = 'e65b54a38943ea78135b2e1c61fab9dfa5881c8e';
const KEY_BODY = 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv'.repeat(2);

const draft = (reason: string, evidence: string[] = []): VerdictDraft => ({
  criterion: 18,
  verdict: 'pass',
  reason,
  identity: { kind: 'commit', sha: SHA },
  evidence,
});

describe('a verdict reason and the secret detector', () => {
  it.each([
    'the judge saw task-0b4523e70795a679f6ca7c3d in the log',
    'desk-0b4523e70795a679f6ca7c3d and risk-7dc311765850e2253a54cb1b both held',
    'case-90dd84c29657d4436bc176c0 passed',
  ])('writes a reason citing a record id: %s', (reason) => {
    expect(verdictDraftFault(draft(reason))).toBeNull();
  });

  it('refuses a key in the reason, naming its offset and length, never the key', () => {
    const key = `sk-proj-${KEY_BODY}`;
    const fault = verdictDraftFault(draft(`the judge saw ${key} in the log`));
    expect(fault).toMatchObject({ code: 'VERDICT_SECRET', path: '/reason' });
    expect(fault?.detail).toBe(
      `criterion 18's reason carries a provider key at offset 14, ${key.length} characters: \`sk-proj-***\` after \`e judge saw \`. Name the credential entry instead.`,
    );
    expect(fault?.detail).not.toContain(KEY_BODY.slice(0, 8));
  });

  it('refuses a key glued to the word before it, showing where the read began', () => {
    const fault = verdictDraftFault(draft(`token tasksk-${KEY_BODY}`));
    expect(fault?.detail).toContain(
      'a provider key at offset 10, 67 characters: `sk-***` after `token task`',
    );
  });

  it('names a value the scrubber keeps a label before, without the value', () => {
    const fault = verdictDraftFault(draft('db at postgres://forge:hunter22@db.internal'));
    expect(fault?.detail).toContain('a connection password at offset 23, 8 characters: `***`');
    expect(fault?.detail).not.toContain('hunter22');
  });

  it('refuses a secret in evidence at its own path, and counts the spans it does not name', () => {
    const ghp = `ghp_${KEY_BODY.slice(0, 36)}`;
    const fault = verdictDraftFault(draft('fine', ['run.webm', `${ghp} then ${ghp}`]));
    expect(fault).toMatchObject({ code: 'VERDICT_SECRET', path: '/evidence/1' });
    expect(fault?.detail).toBe(
      "criterion 18's evidence 1 carries a provider key at offset 0, 40 characters: `ghp_***` (and 1 more). Name the credential entry instead.",
    );
  });
});
