import { describe, expect, it } from 'vitest';
import { contractsNamedIn, type LandingWorld, landingDriftRefusal } from './drift.js';

const world = (over: Partial<LandingWorld> = {}): LandingWorld => ({
  projectSlug: 'hop',
  named: contractsNamedIn('Build GET /postcare/overdue against contract:hop/postcare-api@1.1.0.'),
  contracts: new Map([
    ['postcare-api', { recorded: new Set(['1.0.0', '1.1.0', '1.2.0']), current: '1.1.0' }],
  ]),
  ...over,
});

describe('the drift check at landing', () => {
  it('passes a landing naming the current version the issue named', () => {
    expect(landingDriftRefusal(['hop/postcare-api@1.1.0'], world())).toBeNull();
  });

  it('refuses a landing that names no version of a contract the issue is built against', () => {
    expect(landingDriftRefusal([], world())?.code).toBe('CONTRACT_LANDING_UNNAMED');
  });

  it('refuses a landing whose version is no longer current, naming the current one', () => {
    const drift = landingDriftRefusal(['hop/postcare-api@1.0.0'], world());
    expect(drift?.code).toBe('CONTRACT_DRIFT');
    expect(drift?.detail).toContain('current at 1.1.0');
  });

  it("refuses a version never recorded, and another project's contract", () => {
    expect(landingDriftRefusal(['hop/postcare-api@9.0.0'], world())?.code).toBe('CONTRACT_DRIFT');
    expect(landingDriftRefusal(['hop/postcare-api@1.1.0', 'crm/x@1.0.0'], world())?.code).toBe(
      'CONTRACT_DRIFT',
    );
  });

  it('leaves an issue naming no contract and a landing naming none alone', () => {
    expect(landingDriftRefusal([], world({ named: [] }))).toBeNull();
  });
});

describe('the contract versions an issue names, which its landing names in turn', () => {
  it('reads each contract:<project>/<contract>@<version> once, without trailing punctuation', () => {
    expect(
      contractsNamedIn(
        'see contract:hop/api@1.2.0. and `contract:hop/api@1.2.0`, contract:hop/b@2026-10-01',
      ),
    ).toEqual([
      { ref: 'hop/api', contract: 'api', version: '1.2.0' },
      { ref: 'hop/b', contract: 'b', version: '2026-10-01' },
    ]);
  });
});
