import { describe, expect, it } from 'vitest';
import { draftFromBlock, type VerdictDraft, verdictDraftFault } from './verdict-input.js';

const SHA = '3641ba21fec5096e2d1a91a40f2d9e50e9239068';
const draft = (over: Partial<VerdictDraft>): VerdictDraft => ({
  criterion: 2,
  verdict: 'pass',
  reason: null,
  identity: { kind: 'commit', sha: SHA },
  evidence: [],
  ...over,
});
const code = (over: Partial<VerdictDraft>) => verdictDraftFault(draft(over))?.code ?? null;

describe('verdictDraftFault (ISS-55: what a new verdict must carry)', () => {
  it('accepts a pass on a whole commit, a runtime, a design and a contract', () => {
    expect(code({})).toBeNull();
    expect(code({ identity: { kind: 'runtime', ref: SHA } })).toBeNull();
    expect(
      code({ identity: { kind: 'design', workflow: 'issue-lifecycle', revision: 2 } }),
    ).toBeNull();
    expect(
      code({ identity: { kind: 'contract', ref: 'hop/discharge-api', version: '2.0' } }),
    ).toBeNull();
  });

  it('refuses a verdict word outside pass, short, fail, skipped', () => {
    expect(code({ verdict: 'ok' })).toBe('VERDICT_VALUE_UNKNOWN');
  });

  it('refuses a skip with no reason, and takes one with a reason and no identity', () => {
    expect(code({ verdict: 'skipped', identity: null })).toBe('VERDICT_SKIP_REASON_REQUIRED');
    expect(code({ verdict: 'skipped', reason: '  ', identity: null })).toBe(
      'VERDICT_SKIP_REASON_REQUIRED',
    );
    expect(code({ verdict: 'skipped', reason: 'no staging host', identity: null })).toBeNull();
  });

  it('refuses a pass, a short and a fail that name no identity', () => {
    for (const verdict of ['pass', 'short', 'fail']) {
      expect(code({ verdict, identity: null })).toBe('VERDICT_IDENTITY_REQUIRED');
    }
  });

  it('refuses an abbreviated commit by name, at every length short of forty', () => {
    expect(code({ identity: { kind: 'commit', sha: SHA.slice(0, 7) } })).toBe(
      'VERDICT_COMMIT_NOT_FULL',
    );
    expect(code({ identity: { kind: 'commit', sha: SHA.slice(0, 39) } })).toBe(
      'VERDICT_COMMIT_NOT_FULL',
    );
    expect(
      verdictDraftFault(draft({ identity: { kind: 'commit', sha: '1810f843' } }))?.detail,
    ).toContain('`1810f843`');
  });

  it('refuses an abbreviated runtime, a malformed design and a malformed contract', () => {
    expect(code({ identity: { kind: 'runtime', ref: SHA.slice(0, 12) } })).toBe(
      'VERDICT_RUNTIME_NOT_FULL',
    );
    expect(code({ identity: { kind: 'design', workflow: 'x', revision: 0 } })).toBe(
      'VERDICT_DESIGN_SHAPE',
    );
    expect(code({ identity: { kind: 'contract', ref: 'x', version: ' ' } })).toBe(
      'VERDICT_CONTRACT_SHAPE',
    );
  });
});

describe('draftFromBlock (the comment fence dual path)', () => {
  const block = {
    criterion: 4,
    verdict: 'skipped',
    runtime: null,
    source: null,
    design: null,
    why: 'not reachable from this box',
    cited: ['log.txt'],
  };

  it('carries the block why as the reason a skip needs', () => {
    const d = draftFromBlock(block);
    expect(d).toMatchObject({
      criterion: 4,
      verdict: 'skipped',
      reason: 'not reachable from this box',
    });
    expect(verdictDraftFault(d)).toBeNull();
  });

  it('reads a commit line as a commit identity, so an abbreviation is refused', () => {
    const d = draftFromBlock({ ...block, verdict: 'pass', source: '1810f84' });
    expect(d.identity).toEqual({ kind: 'commit', sha: '1810f84' });
    expect(verdictDraftFault(d)?.code).toBe('VERDICT_COMMIT_NOT_FULL');
  });

  it('keeps a malformed design so its refusal names it', () => {
    const d = draftFromBlock({ ...block, verdict: 'pass', design: 'issue-lifecycle two' });
    expect(verdictDraftFault(d)?.code).toBe('VERDICT_DESIGN_SHAPE');
  });
});
