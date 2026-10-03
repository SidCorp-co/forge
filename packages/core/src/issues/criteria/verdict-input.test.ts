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
    contract: null,
    environment: null,
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

  it('reads a contract line as `<project>/<contract>` at its version', () => {
    const d = draftFromBlock({ ...block, verdict: 'pass', contract: 'hop/postcare-api@1.1.0' });
    expect(d.identity).toEqual({ kind: 'contract', ref: 'hop/postcare-api', version: '1.1.0' });
    expect(verdictDraftFault(d)).toBeNull();
  });

  it('keeps a malformed design so its refusal names it', () => {
    const d = draftFromBlock({ ...block, verdict: 'pass', design: 'issue-lifecycle two' });
    expect(verdictDraftFault(d)?.code).toBe('VERDICT_DESIGN_SHAPE');
  });
});

describe('a storefront draft identity (ISS-91)', () => {
  const sf = {
    kind: 'storefront_draft' as const,
    workflowId: 'b2eb2792-a043-4d5f-80a3-50a32c29e6e9',
    draftVersion: 'a'.repeat(64),
    environment: 'preview',
  };

  it('accepts a workflow id, a draft version and an environment key', () => {
    expect(code({ identity: sf })).toBeNull();
  });

  it('refuses a malformed draft by name, saying which field and what shape is valid', () => {
    const fault = verdictDraftFault(
      draft({ identity: { ...sf, workflowId: 'has space', environment: 'Preview' } }),
    );
    expect(fault?.code).toBe('VERDICT_STOREFRONT_DRAFT_SHAPE');
    expect(fault?.detail).toContain('workflowId `has space`');
    expect(fault?.detail).toContain('environment `Preview`');
    expect(fault?.detail).toContain('kind: "storefront_draft"');
  });

  it('leaves the commit and runtime forms exactly as strict', () => {
    expect(
      code({ identity: { kind: 'runtime', ref: `${sf.workflowId}@draft:${sf.draftVersion}` } }),
    ).toBe('VERDICT_RUNTIME_NOT_FULL');
    expect(code({ identity: { kind: 'commit', sha: SHA.slice(0, 39) } })).toBe(
      'VERDICT_COMMIT_NOT_FULL',
    );
  });

  it('reads a comment block naming `<id>@draft:<version>` as a storefront draft on its environment', () => {
    const d = draftFromBlock({
      criterion: 1,
      verdict: 'pass',
      runtime: `${sf.workflowId}@draft:${sf.draftVersion}`,
      source: null,
      design: null,
      contract: null,
      environment: 'preview',
      why: null,
      cited: [],
    });
    expect(d.identity).toEqual(sf);
    expect(verdictDraftFault(d)).toBeNull();
  });
});
