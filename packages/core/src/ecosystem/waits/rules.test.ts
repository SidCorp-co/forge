import { CONTRACT_WAIT_REFUSAL_CODES } from '@forge/contracts/contract-waits';
import { describe, expect, it } from 'vitest';
import {
  addRefusals,
  holdsDispatch,
  notLiveSentence,
  providerLiveMode,
  providerLiveShortfall,
  retractRefusal,
  settlingVersion,
  type WaitTarget,
  writerRefusal,
} from './rules.js';

const HOP = '11111111-1111-4111-8111-111111111111';
const AUTOFLOW = '22222222-2222-4222-8222-222222222222';
const ECO = '33333333-3333-4333-8333-333333333333';

const target = (over: Partial<WaitTarget> = {}): WaitTarget => ({
  consumerId: HOP,
  ref: 'autoflow/book-follow-up',
  contractSlug: 'book-follow-up',
  provider: { id: AUTOFLOW, slug: 'autoflow' },
  publication: { ecosystems: [ECO] },
  consumerEcosystems: [ECO],
  versioning: 'semver',
  minVersion: '2.0.0',
  duplicate: null,
  requestNamed: null,
  request: null,
  ...over,
});

const codes = (t: WaitTarget) => addRefusals(t).map((r) => `${r.code} ${r.path}`);

describe('what an issue may wait on (E1)', () => {
  it('takes another project’s contract shared with it, at a version in the provider’s scheme', () => {
    expect(addRefusals(target())).toEqual([]);
    expect(addRefusals(target({ versioning: 'dated', minVersion: '2026-11-02.1' }))).toEqual([]);
  });

  it('refuses a contract no project publishes, by name', () => {
    expect(codes(target({ provider: null, publication: null }))).toEqual([
      'CONTRACT_WAIT_CONTRACT_UNKNOWN /contract',
    ]);
    expect(codes(target({ publication: null }))).toEqual([
      'CONTRACT_WAIT_CONTRACT_UNKNOWN /contract',
    ]);
  });

  it('refuses the project’s own contract, pointing at a blocks edge', () => {
    const own = addRefusals(target({ provider: { id: HOP, slug: 'hop' } }));
    expect(own.map((r) => r.code)).toEqual(['CONTRACT_WAIT_OWN_CONTRACT']);
    expect(own[0]?.detail).toContain('blocks edge');
  });

  it('refuses a contract not published to an ecosystem the consumer is active in', () => {
    expect(codes(target({ consumerEcosystems: [] }))).toEqual([
      'CONTRACT_WAIT_NOT_SHARED /contract',
    ]);
  });

  it('refuses a version outside the provider’s scheme, naming the scheme', () => {
    const r = addRefusals(target({ minVersion: 'v2' }));
    expect(r.map((x) => `${x.code} ${x.path}`)).toEqual([
      'CONTRACT_WAIT_VERSION_NOT_IN_SCHEME /minVersion',
    ]);
    expect(r[0]?.detail).toContain('MAJOR.MINOR.PATCH');
    expect(codes(target({ versioning: null }))).toEqual([
      'CONTRACT_WAIT_VERSION_NOT_IN_SCHEME /minVersion',
    ]);
  });

  it('refuses a second live wait on the same contract', () => {
    expect(codes(target({ duplicate: { id: 'w1', minVersion: '1.5.0' } }))).toEqual([
      'CONTRACT_WAIT_DUPLICATE /contract',
    ]);
  });

  it('refuses a change request that is unknown, or about another contract or from another project', () => {
    expect(codes(target({ requestNamed: 'HOP-CR-9' }))).toEqual([
      'CONTRACT_WAIT_REQUEST_MISMATCH /request',
    ]);
    const request = {
      number: 'HOP-CR-3',
      consumerId: HOP,
      providerId: AUTOFLOW,
      contractSlug: 'book-follow-up',
    };
    expect(codes(target({ requestNamed: 'HOP-CR-3', request }))).toEqual([]);
    expect(
      codes(target({ requestNamed: 'HOP-CR-3', request: { ...request, contractSlug: 'slots' } })),
    ).toEqual(['CONTRACT_WAIT_REQUEST_MISMATCH /request']);
    expect(
      codes(target({ requestNamed: 'HOP-CR-3', request: { ...request, consumerId: AUTOFLOW } })),
    ).toEqual(['CONTRACT_WAIT_REQUEST_MISMATCH /request']);
  });

  it('refuses retracting a wait twice', () => {
    expect(retractRefusal({ id: 'w', retractedAt: null })).toBeNull();
    expect(retractRefusal({ id: 'w', retractedAt: new Date(0) })?.code).toBe(
      'CONTRACT_WAIT_RETRACTED',
    );
  });
});

describe('who may write a wait', () => {
  const facts = (agency: 'human' | 'agent', role: 'viewer' | 'member' | null) => ({
    userId: 'u',
    agency,
    role,
  });

  it('takes a member person and the project’s own agent', () => {
    expect(writerRefusal(facts('human', 'member'), HOP, 'adding a wait')).toBeNull();
    expect(writerRefusal(facts('agent', 'member'), HOP, 'adding a wait')).toBeNull();
  });

  it('refuses a viewer and another project’s agent, by name', () => {
    for (const f of [facts('human', 'viewer'), facts('agent', null), facts('human', null)]) {
      expect(writerRefusal(f, HOP, 'adding a wait')?.code).toBe('CONTRACT_WAIT_WRITE_FORBIDDEN');
    }
  });
});

describe('when a wait settles', () => {
  it('settles on the newest approved version at or above the minimum', () => {
    expect(settlingVersion('semver', '2.0.0', ['2.1.0', '2.0.0', '1.4.0'])).toBe('2.1.0');
    expect(settlingVersion('semver', '2.0.0', ['2.0.0'])).toBe('2.0.0');
    expect(settlingVersion('dated', '2026-11-02', ['2026-11-02.1'])).toBe('2026-11-02.1');
  });

  it('stays open below the minimum, and an approved version outside the scheme never settles it', () => {
    expect(settlingVersion('semver', '2.0.0', ['1.9.9', '1.4.0'])).toBeNull();
    expect(settlingVersion('semver', '2.0.0', ['next'])).toBeNull();
    expect(settlingVersion('semver', '2.0.0', [])).toBeNull();
  });
});

describe('the dispatch gate (E1, kernel)', () => {
  it('holds a live wait no version has settled, and nothing else', () => {
    expect(holdsDispatch({ retractedAt: null, settledAt: null })).toBe(true);
    expect(holdsDispatch({ retractedAt: null, settledAt: new Date(0) })).toBe(false);
    expect(holdsDispatch({ retractedAt: new Date(0), settledAt: null })).toBe(false);
  });
});

describe('the consumer production release gate (E4, kernel)', () => {
  const live = (over: Partial<Parameters<typeof providerLiveShortfall>[0]> = {}) =>
    providerLiveShortfall({
      issueId: 'i',
      issue: 'ISS-12',
      contract: 'autoflow/book-follow-up',
      minVersion: '2.0.0',
      versioning: 'semver',
      live: '2.0.0',
      mode: 'required',
      ...over,
    });

  it('lets a release ship once the provider serves the version or above', () => {
    expect(live()).toBeNull();
    expect(live({ live: '2.3.1' })).toBeNull();
  });

  it('refuses while production serves less, or nothing Forge could read', () => {
    expect(live({ live: '1.4.0' })).toEqual({
      issueId: 'i',
      issue: 'ISS-12',
      contract: 'autoflow/book-follow-up',
      needed: '2.0.0',
      live: '1.4.0',
    });
    expect(live({ live: null })?.live).toBeNull();
    expect(live({ versioning: null })).not.toBeNull();
  });

  it('is off only where every shared ecosystem turns it off', () => {
    expect(live({ live: null, mode: 'off' })).toBeNull();
    expect(providerLiveMode([])).toBe('required');
    expect(providerLiveMode([undefined])).toBe('required');
    expect(providerLiveMode(['off', 'required'])).toBe('required');
    expect(providerLiveMode(['off', 'off'])).toBe('off');
  });

  it('names the contract, the version needed and the provider’s live version', () => {
    const s = notLiveSentence([
      { issueId: 'i', issue: 'ISS-12', contract: 'autoflow/x', needed: '2.0.0', live: '1.4.0' },
      { issueId: 'j', issue: 'ISS-13', contract: 'autoflow/y', needed: '1.0.0', live: null },
    ]);
    expect(s).toContain('`ISS-12` needs autoflow/x >= 2.0.0');
    expect(s).toContain('serves 1.4.0');
    expect(s).toContain('serves no version Forge could read');
  });
});

describe('the vocabulary', () => {
  it('declares every code the rules return', () => {
    const returned = [
      ...addRefusals(target({ provider: null, publication: null })),
      ...addRefusals(target({ provider: { id: HOP, slug: 'hop' } })),
      ...addRefusals(
        target({
          consumerEcosystems: [],
          minVersion: 'x',
          duplicate: { id: 'w', minVersion: '1.0.0' },
          requestNamed: 'HOP-CR-1',
        }),
      ),
    ].map((r) => r.code);
    for (const code of returned) expect(CONTRACT_WAIT_REFUSAL_CODES).toContain(code);
  });
});
