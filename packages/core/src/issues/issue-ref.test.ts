import { describe, expect, it } from 'vitest';
import {
  canonicalIssueKey,
  formatIssueRef,
  issueRefNeedsHeldPrefixes,
  LEGACY_ISSUE_PREFIX,
  parseIssueRef,
  validateIssuePrefix,
} from './issue-ref.js';

describe('formatIssueRef', () => {
  it('renders the legacy prefix for a project that has set none', () => {
    expect(formatIssueRef(null, 977)).toBe('ISS-977');
  });

  it("renders the project's own prefix where it has one", () => {
    expect(formatIssueRef('FD', 977)).toBe('FD-977');
  });
});

describe('canonicalIssueKey', () => {
  // cm:why ISS-992 — the stored `runIssues` key never takes the project's prefix; `admissible.ts` matches it by string containment, so a prefixed key would make a run's issues unfindable.
  it('stays ISS- whatever prefix the project holds', () => {
    expect(canonicalIssueKey(977)).toBe('ISS-977');
    expect(canonicalIssueKey(977)).not.toBe(formatIssueRef('FD', 977));
  });
});

describe('parseIssueRef', () => {
  it('resolves a bare sequence number', () => {
    expect(parseIssueRef('977', ['FD'])).toEqual({ ok: true, issSeq: 977 });
  });

  it('resolves the legacy prefix on a project that has moved to its own', () => {
    expect(parseIssueRef('ISS-977', ['FD'])).toEqual({ ok: true, issSeq: 977 });
  });

  it("resolves the project's own prefix", () => {
    expect(parseIssueRef('FD-977', ['FD'])).toEqual({ ok: true, issSeq: 977 });
  });

  it('resolves a prefix the project has retired, so a published reference still works', () => {
    expect(parseIssueRef('FD-977', ['FX', 'FD'])).toEqual({ ok: true, issSeq: 977 });
  });

  it('is case-insensitive about the prefix', () => {
    expect(parseIssueRef('fd-977', ['FD'])).toEqual({ ok: true, issSeq: 977 });
  });

  it('refuses a prefix this project does not hold, naming what was sent', () => {
    const out = parseIssueRef('FP-977', ['FD']);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a refusal');
    expect(out.code).toBe('FOREIGN_PREFIX');
    expect(out.message).toContain('FP');
    expect(out.message).toContain('FD');
  });

  it('does NOT quietly resolve a foreign prefix to this project’s issue of that number', () => {
    expect(parseIssueRef('FP-977', ['FD'])).not.toEqual({ ok: true, issSeq: 977 });
  });

  it('refuses text that is not a reference at all', () => {
    const out = parseIssueRef('not-an-issue', []);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a refusal');
    expect(out.code).toBe('SHAPE');
  });

  it('refuses a sequence number past what int4 holds', () => {
    const out = parseIssueRef('2147483648', []);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a refusal');
    expect(out.code).toBe('RANGE');
  });

  it('refuses sequence zero, which no issue can hold', () => {
    expect(parseIssueRef('0', []).ok).toBe(false);
  });
});

describe('issueRefNeedsHeldPrefixes', () => {
  it('is false for a bare number and for the legacy prefix, which need no read', () => {
    expect(issueRefNeedsHeldPrefixes('977')).toBe(false);
    expect(issueRefNeedsHeldPrefixes(`${LEGACY_ISSUE_PREFIX}-977`)).toBe(false);
  });

  it('is true for any other prefix, which can only be judged against the project', () => {
    expect(issueRefNeedsHeldPrefixes('FD-977')).toBe(true);
  });
});

describe('validateIssuePrefix', () => {
  it('accepts two to six characters of a letter then letters or digits', () => {
    expect(validateIssuePrefix('FD')).toEqual({ ok: true, prefix: 'FD' });
    expect(validateIssuePrefix('FP2')).toEqual({ ok: true, prefix: 'FP2' });
    expect(validateIssuePrefix('ABCDEF')).toEqual({ ok: true, prefix: 'ABCDEF' });
  });

  it('upper-cases what it accepts, because a foreign key cannot sit on lower(prefix)', () => {
    expect(validateIssuePrefix('fd')).toEqual({ ok: true, prefix: 'FD' });
  });

  it('refuses one character, seven, a leading digit and a separator, naming the shape', () => {
    for (const bad of ['F', 'ABCDEFG', '1FD', 'F-D', 'F D']) {
      const out = validateIssuePrefix(bad);
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error(`expected ${bad} to be refused`);
      expect(out.reason).toBe('shape');
      expect(out.message).toContain('two to six');
    }
  });

  it('refuses ISS, naming it as the shared legacy prefix', () => {
    const out = validateIssuePrefix('iss');
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a refusal');
    expect(out.reason).toBe('reserved');
    expect(out.message).toContain('legacy');
  });
});
