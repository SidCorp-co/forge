import { describe, expect, it } from 'vitest';
import { verdictStanding } from '../issues/verdict-standing.js';
import { parseForgeRecord } from './forge-record.js';
import { type ContractLookup, verdictContractRefusals } from './verdict-contract.js';
import { verdictIdentityRefusals } from './verdict-identity.js';

const record = (contract: string) =>
  parseForgeRecord(
    [
      '```forge-record: verdict · contract 1',
      'criterion: 3',
      'verdict: pass',
      `contract: ${contract}`,
      '```',
    ].join('\n'),
  );

const lookup: ContractLookup = async (_projectId, named) => ({
  projectSlug: 'hop',
  versions: ['1.1.0', '1.0.0'],
  named: named.project === 'hop' && ['1.0.0', '1.1.0'].includes(named.version),
});

describe('a contract: verdict identity', () => {
  it('is an identity on its own, and a malformed one is refused under verdict-identity', () => {
    expect(verdictIdentityRefusals(record('hop/postcare-api@1.1.0'))).toEqual([]);
    expect(verdictIdentityRefusals(record('postcare-api 1.1.0')).map((r) => r.rule)).toEqual([
      'verdict-identity',
    ]);
  });

  it('passes a version the issue project recorded', async () => {
    expect(await verdictContractRefusals('p', record('hop/postcare-api@1.1.0'), lookup)).toEqual(
      [],
    );
  });

  it('refuses a version never recorded, listing the recorded ones', async () => {
    const [refused] = await verdictContractRefusals('p', record('hop/postcare-api@2.0.0'), lookup);
    expect(refused?.rule).toBe('verdict-contract');
    expect(refused?.why).toContain('`1.1.0`');
  });

  it("refuses another project's contract by name", async () => {
    const [refused] = await verdictContractRefusals('p', record('crm/api@1.1.0'), lookup);
    expect(refused?.why).toContain("project `crm`'s contract");
  });

  it('stands on the current version and is superseded by a later approved one', () => {
    const at = { kind: 'contract' as const, value: 'hop/postcare-api@1.1.0' };
    const serving = { kind: 'undeclared', missing: '' } as never;
    const ids = (current: string) => ({
      source: null,
      contracts: new Map([['hop/postcare-api', current]]),
    });
    expect(verdictStanding(at, serving, ids('1.1.0'))).toBe('stands');
    expect(verdictStanding(at, serving, ids('1.2.0'))).toBe('superseded');
    expect(verdictStanding(at, serving, { source: null })).toBe('unanchored');
  });
});
