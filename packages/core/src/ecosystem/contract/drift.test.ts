import { describe, expect, it } from 'vitest';
import { contractsNamedIn, type LandingWorld, landingDriftRefusal } from './drift.js';

const world = (text: string, contracts: LandingWorld['contracts']): LandingWorld => ({
  named: contractsNamedIn(text),
  contracts,
});
const held = (current: string, ...recorded: string[]) => ({
  recorded: new Set([current, ...recorded]),
  current,
});

describe('landingDriftRefusal', () => {
  it("lands a consumer issue naming another project's contract at the provider's current version", () => {
    const w = world(
      'built against contract: acme-api/orders@2.0',
      new Map([['acme-api/orders', held('2.0')]]),
    );
    expect(landingDriftRefusal(['acme-api/orders@2.0'], w)).toBeNull();
  });

  it('refuses a landing that names no version of a contract the issue is built against', () => {
    const w = world('contract: acme-api/orders@2.0', new Map([['acme-api/orders', held('2.0')]]));
    expect(landingDriftRefusal([], w)?.code).toBe('CONTRACT_LANDING_UNNAMED');
  });

  it("refuses a version that is not the provider's current one, naming the current", () => {
    const w = world(
      'contract: acme-api/orders@1.0',
      new Map([['acme-api/orders', held('2.0', '1.0')]]),
    );
    const refusal = landingDriftRefusal(['acme-api/orders@1.0'], w);
    expect(refusal?.code).toBe('CONTRACT_DRIFT');
    expect(refusal?.detail).toContain('current at 2.0');
  });

  it('refuses a version the provider never recorded', () => {
    const w = world('', new Map([['acme-api/orders', held('2.0')]]));
    expect(landingDriftRefusal(['acme-api/orders@9.9'], w)?.detail).toContain('never recorded');
  });

  it('refuses a ref whose project slug no project holds, by name', () => {
    const w = world('', new Map([['ghost/orders', null]]));
    expect(landingDriftRefusal(['ghost/orders@1.0'], w)?.detail).toContain('names project ghost');
  });

  it('refuses a landing not written as <project>/<contract>@<version>', () => {
    expect(landingDriftRefusal(['orders'], world('', new Map()))?.code).toBe('CONTRACT_DRIFT');
  });
});
