import { type CriterionProbe, criterionProbeSchema } from '@forge/contracts/criterion-probes';
import { describe, expect, it } from 'vitest';
import { probeNote, probeRuleFault, probeSecretRefusals, restsOnKept } from './probe-rules.js';

const request = (over: Partial<Extract<CriterionProbe, { kind: 'request' }>['request']> = {}) =>
  criterionProbeSchema.parse({
    kind: 'request',
    request: { method: 'GET', path: '/api/health', as: 'replayer', ...over },
    expect: { status: 200 },
  });

const command = (argv: string[]) =>
  criterionProbeSchema.parse({ kind: 'command', command: { argv }, expect: { exitCode: 0 } });

const codes = (probe: CriterionProbe) => probeSecretRefusals(probe).map((r) => [r.code, r.path]);

describe('probeSecretRefusals', () => {
  it('takes a probe with no credential in it', () => {
    expect(codes(request({ headers: { Accept: 'application/json' }, body: '{"n":1}' }))).toEqual(
      [],
    );
    expect(codes(command(['node', 'scripts/probe.mjs', '--json']))).toEqual([]);
  });

  it('refuses a header that carries a credential whatever it holds, at the header', () => {
    for (const name of ['Authorization', 'cookie', 'X-Api-Key', 'Proxy-Authorization']) {
      expect(codes(request({ headers: { [name]: 'x' } }))).toEqual([
        ['VERDICT_PROBE_SECRET', `/probe/request/headers/${name}`],
      ]);
    }
  });

  it('refuses a credential-shaped value wherever it is, without echoing it', () => {
    const token = `ghp_${'Z9y8X7w6'.repeat(4)}`;
    const found = probeSecretRefusals(command(['gh', 'api', token]));
    expect(found.map((r) => r.path)).toEqual(['/probe/command/argv/2']);
    expect(JSON.stringify(found)).not.toContain(token);
    expect(codes(request({ path: '/x?access_token=abcdef123' }))).toEqual([
      ['VERDICT_PROBE_SECRET', '/probe/request/path'],
    ]);
    expect(codes(request({ body: '{"password":"hunter22"}' }))).toEqual([
      ['VERDICT_PROBE_SECRET', '/probe/request/body'],
    ]);
  });
});

describe('probeRuleFault', () => {
  const facts = { criterion: 4, verdict: 'pass', sent: false, kept: false } as const;

  it('refuses a pass or short on an observable criterion with no probe sent or kept', () => {
    for (const verdict of ['pass', 'short']) {
      expect(probeRuleFault({ ...facts, verdict, criterionClass: 'observable' })?.code).toBe(
        'VERDICT_PROBE_REQUIRED',
      );
    }
  });

  it('takes one that sends a probe or finds one kept, and a fail or skip that has neither', () => {
    const observable = { ...facts, criterionClass: 'observable' } as const;
    expect(probeRuleFault({ ...observable, sent: true })).toBeNull();
    expect(probeRuleFault({ ...observable, kept: true })).toBeNull();
    expect(probeRuleFault({ ...observable, verdict: 'fail' })).toBeNull();
    expect(probeRuleFault({ ...observable, verdict: 'skipped' })).toBeNull();
  });

  it('refuses a probe on a code property and owes none on it or on an unclassed criterion', () => {
    expect(probeRuleFault({ ...facts, criterionClass: 'code_property', sent: true })?.code).toBe(
      'VERDICT_PROBE_CODE_PROPERTY',
    );
    expect(probeRuleFault({ ...facts, criterionClass: 'code_property' })).toBeNull();
    expect(probeRuleFault({ ...facts, criterionClass: null })).toBeNull();
  });
});

describe('what a verdict rests on and records', () => {
  it('rests on the kept probe only for a verdict that ran something', () => {
    expect(['pass', 'short', 'fail', 'skipped'].map(restsOnKept)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('names the probe, or the rule that exempts an earned verdict from one', () => {
    expect(probeNote('pass', 'observable', 'p-1')).toBe('p-1');
    expect(probeNote('pass', null, null)).toBe('not owed: no design classes this criterion');
    expect(probeNote('short', 'code_property', null)).toBe(
      'not owed: a code property is judged against the diff',
    );
    expect(probeNote('fail', null, null)).toBeNull();
  });
});
