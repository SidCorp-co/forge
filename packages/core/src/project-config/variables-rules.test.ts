import { describe, expect, it } from 'vitest';
import {
  askRefusals,
  type DeclaredEnvironment,
  effectiveVariables,
  type HeldVariable,
  writeRefusals,
} from './variables-rules.js';

const production: DeclaredEnvironment = { name: 'production', tier: 'production' };
const stg: DeclaredEnvironment = { name: 'stg', tier: 'staging' };
const environments = [production, stg];

let n = 0;
const v = (key: string, environment: string | null, isProtected = false): HeldVariable => ({
  id: `v${++n}`,
  key,
  environment,
  type: 'secret',
  protected: isProtected,
});

describe('the variables a run receives on the environment it targets (REQ-80 BC-8)', () => {
  it('takes the variable scoped to that environment over the all-scope one, per key', () => {
    const all = v('DATABASE_URL', null);
    const scoped = v('DATABASE_URL', 'stg');
    const other = v('DATABASE_URL', 'production');
    const flag = v('FEATURE_X', null);
    const { effective, withheld } = effectiveVariables([scoped, all, other, flag], stg, false);
    expect(effective.get('DATABASE_URL')).toBe(scoped);
    expect(effective.get('FEATURE_X')).toBe(flag);
    expect([...effective.keys()]).toEqual(['DATABASE_URL', 'FEATURE_X']);
    expect(withheld).toEqual([]);
  });

  it('falls back to the all-scope variable where the environment has none of its own', () => {
    const all = v('S3_BUCKET', null);
    const { effective } = effectiveVariables([all, v('S3_BUCKET', 'production')], stg, false);
    expect(effective.get('S3_BUCKET')).toBe(all);
  });

  it('gives a protected variable to a run on a production-tier environment its work landed on', () => {
    const secret = v('STRIPE_KEY', 'production', true);
    expect(effectiveVariables([secret], production, true).effective.get('STRIPE_KEY')).toBe(secret);
  });

  it('withholds a protected variable from a production run whose work did not land there', () => {
    const read = effectiveVariables([v('STRIPE_KEY', 'production', true)], production, false);
    expect(read.effective.has('STRIPE_KEY')).toBe(false);
    expect(read.withheld).toEqual(['STRIPE_KEY']);
  });

  it('withholds an all-scope protected variable on a non-production environment, landed or not', () => {
    const read = effectiveVariables([v('SIGNING_KEY', null, true)], stg, true);
    expect(read.effective.size).toBe(0);
    expect(read.withheld).toEqual(['SIGNING_KEY']);
  });

  it('never answers a withheld key with a less specific value nobody chose for that environment', () => {
    const read = effectiveVariables(
      [v('API_KEY', null), v('API_KEY', 'production', true)],
      production,
      false,
    );
    expect(read.effective.has('API_KEY')).toBe(false);
    expect(read.withheld).toEqual(['API_KEY']);
  });

  it('refuses each asked key nothing holds, and says a protected one is withheld rather than absent', () => {
    const read = effectiveVariables(
      [v('DATABASE_URL', null), v('STRIPE_KEY', 'production', true)],
      production,
      false,
    );
    const refused = askRefusals(['DATABASE_URL', 'NOPE', 'STRIPE_KEY'], read, production);
    expect(refused.map((r) => [r.code, r.path])).toEqual([
      ['VARIABLE_KEY_UNKNOWN', '/key/NOPE'],
      ['VARIABLE_PROTECTED_WITHHELD', '/key/STRIPE_KEY'],
    ]);
    expect(refused[0]?.detail).toContain('NOPE');
    expect(refused[1]?.detail).toContain('none of this run');
  });

  it('refuses nothing when every asked key is effective', () => {
    const read = effectiveVariables([v('A', null)], stg, false);
    expect(askRefusals(['A', 'A'], read, stg)).toEqual([]);
  });
});

describe('what a variable write is refused for (REQ-80 BC-2)', () => {
  const ok = {
    key: 'DATABASE_URL',
    environment: 'stg',
    type: 'secret',
    protected: false,
    value: 'postgres://x',
  } as const;

  it('takes a valid variable at a declared scope, and at every scope', () => {
    expect(writeRefusals(ok, environments)).toEqual([]);
    expect(writeRefusals({ ...ok, environment: null, protected: true }, environments)).toEqual([]);
  });

  it('refuses a protected variable scoped to an environment that is not production-tier', () => {
    const [refusal] = writeRefusals({ ...ok, protected: true }, environments);
    expect(refusal?.code).toBe('VARIABLE_PROTECTED_NOT_PRODUCTION');
    expect(refusal?.path).toBe('/protected');
    expect(refusal?.detail).toContain('staging-tier');
  });

  it('takes a protected variable scoped to the production-tier environment', () => {
    expect(
      writeRefusals({ ...ok, environment: 'production', protected: true }, environments),
    ).toEqual([]);
  });

  it('refuses a scope the project document does not declare, naming the ones it does', () => {
    const [refusal] = writeRefusals({ ...ok, environment: 'qa' }, environments);
    expect(refusal?.code).toBe('VARIABLE_ENVIRONMENT_UNKNOWN');
    expect(refusal?.detail).toContain('`production`, `stg`');
  });

  it('refuses a secret too short for the scrubber at the boundary, and takes one at it', () => {
    expect(writeRefusals({ ...ok, value: '12345' }, environments).map((r) => r.code)).toEqual([
      'VARIABLE_SECRET_TOO_SHORT',
    ]);
    expect(writeRefusals({ ...ok, value: '123456' }, environments)).toEqual([]);
    expect(writeRefusals({ ...ok, type: 'plain', value: 'on' }, environments)).toEqual([]);
  });
});
