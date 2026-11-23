import { describe, expect, it } from 'vitest';
import {
  askRefusals,
  type DecisionNamingProduction,
  type DeclaredEnvironment,
  effectiveVariables,
  type HeldVariable,
  protectedReaders,
  proposedProtection,
  type RulingAsk,
  rulingRead,
  withheldWhy,
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
    const refused = askRefusals(['DATABASE_URL', 'NOPE', 'STRIPE_KEY'], read, production, ask);
    expect(refused.map((r) => [r.code, r.path])).toEqual([
      ['VARIABLE_KEY_UNKNOWN', '/key/NOPE'],
      ['VARIABLE_PROTECTED_WITHHELD', '/key/STRIPE_KEY'],
    ]);
    expect(refused[0]?.detail).toContain('NOPE');
    expect(refused[1]?.detail).toContain(ask.lacks);
    // which run reads it, by the branch the environment deploys from (ISS-1392)
    const named = askRefusals(['STRIPE_KEY'], read, { ...production, deploysFrom: 'main' }, ask);
    expect(named[0]?.detail).toContain('only a run with an issue merged on `main`, the branch');
    expect(refused[1]?.detail).toContain('names no branch it deploys from, so only a run working');
  });

  it('refuses nothing when every asked key is effective', () => {
    const read = effectiveVariables([v('A', null)], stg, false);
    expect(askRefusals(['A', 'A'], read, stg, ask)).toEqual([]);
  });
});

const ask: RulingAsk = {
  lacks: "none of this run's issues (ISS-7) carries a ruling for a production act on `production`",
  who: 'a person holding project.admin on this project (Ann)',
};

describe("a person's ruling for a production act opens the protected variables (REQ-80 BC-11)", () => {
  const prod: DeclaredEnvironment = { name: 'canawan', tier: 'production', deploysFrom: 'main' };
  const admins = [{ id: 'u-ann', name: 'Ann' }];
  const runIssues = [{ id: 'i7', key: 'ISS-7' }];
  const now = new Date('2026-11-23T00:00:00Z');
  const ruling = (over: Partial<DecisionNamingProduction> = {}): DecisionNamingProduction => ({
    id: 'r1',
    issueId: 'i7',
    issueKey: 'ISS-7',
    issueStatus: 'in_progress',
    environment: 'canawan',
    act: 'Set supplier PGPrints on canawan',
    untilAt: null,
    writer: { type: 'user', id: 'u-ann', agency: 'human', name: 'Ann' },
    ...over,
  });
  const read = (decisions: DecisionNamingProduction[], issues = runIssues) =>
    rulingRead({ decisions, environment: prod, runIssues: issues, admins, now });
  const lacks = (decisions: DecisionNamingProduction[], issues = runIssues) => {
    const r = read(decisions, issues);
    if (r.kind !== 'lacking') throw new Error(`expected a lacking ruling, read ${r.kind}`);
    expect(r.ask.who).toBe('a person holding project.admin on this project (Ann)');
    return r.ask.lacks;
  };

  it("reads a project admin's ruling on the run's open issue naming the environment", () => {
    const r = read([ruling()]);
    expect(r).toMatchObject({ kind: 'ruled', ruling: { id: 'r1', issueKey: 'ISS-7' } });
  });

  it('opens a protected variable on the environment once ruled, and only there', () => {
    const secret = v('ADMIN_KEY', 'canawan', true);
    expect(effectiveVariables([secret], prod, true).effective.get('ADMIN_KEY')).toBe(secret);
    expect(effectiveVariables([secret], { ...prod, tier: 'staging' }, true).withheld).toEqual([
      'ADMIN_KEY',
    ]);
  });

  it('lacks one where none is written, naming the issues it read', () => {
    expect(lacks([])).toBe(
      "none of this run's issues (ISS-7) carries a ruling for a production act on `canawan`",
    );
    expect(lacks([], [])).toContain('this run works no issue');
  });

  it('lacks one written by a person without project.admin, naming them', () => {
    const by = { type: 'user', id: 'u-bob', agency: 'human' as const, name: 'Bob' };
    expect(lacks([ruling({ writer: by })])).toContain('written by Bob, who holds no project.admin');
  });

  it("lacks one written by an agent, even on an admin's account", () => {
    const box = { type: 'device', id: 'd1', agency: 'agent' as const, name: 'box' };
    const pat = { type: 'user', id: 'u-ann', agency: 'agent' as const, name: 'Ann' };
    for (const writer of [box, pat]) {
      expect(lacks([ruling({ writer })])).toContain(
        "written by an agent, and a ruling is a person's",
      );
    }
  });

  it('lacks one naming another environment, naming both', () => {
    expect(lacks([ruling({ environment: 'stg' })])).toBe(
      "ISS-7's ruling names `stg`, not `canawan`",
    );
  });

  it('lacks one on an issue no longer open', () => {
    for (const status of ['closed', 'dropped']) {
      expect(lacks([ruling({ issueStatus: status })])).toContain(
        `ISS-7 is ${status}, and a ruling holds only while its issue is open`,
      );
    }
  });

  it('lacks one on an issue this run does not work, naming that issue', () => {
    expect(lacks([ruling({ issueId: 'i9', issueKey: 'ISS-9' })])).toBe(
      'ISS-9 carries a ruling for `canawan`, and this run works ISS-7, not ISS-9',
    );
  });

  it('lacks one naming no act, and one whose until date has passed', () => {
    expect(lacks([ruling({ act: null })])).toContain('names no act in its `decision` field');
    const lapsed = ruling({ untilAt: new Date('2026-11-22T00:00:00Z') });
    expect(lacks([lapsed])).toContain('lapsed at 2026-11-22T00:00:00.000Z');
    expect(lacks([ruling({ untilAt: now })])).toContain('lapsed at');
    expect(read([ruling({ untilAt: new Date('2026-11-24T00:00:00Z') })]).kind).toBe('ruled');
  });

  it('takes a standing ruling over a failed one beside it', () => {
    const r = read([ruling({ id: 'r0', environment: 'stg' }), ruling()]);
    expect(r).toMatchObject({ kind: 'ruled', ruling: { id: 'r1' } });
  });

  it('names who may give it where nobody holds project.admin', () => {
    const r = rulingRead({ decisions: [], environment: prod, runIssues, admins: [], now });
    expect(r.kind === 'lacking' && r.ask.who).toContain('nobody holds project.admin');
  });
});

describe('a refused protected variable asks for the ruling, never for protection off (REQ-80 BC-12)', () => {
  const prod: DeclaredEnvironment = { name: 'canawan', tier: 'production', deploysFrom: 'main' };
  const why = withheldWhy(prod, ask);

  it('names the ruling it lacks, who gives it, the act and the environment, asked once', () => {
    expect(why).toContain(ask.lacks);
    expect(why).toContain(`Ask ${ask.who} once, in plain words`);
    expect(why).toContain('naming that act and `canawan`');
    expect(why).toContain('`production` field is `canawan`');
  });

  // ISS-1431: the person asked had nowhere to give it but their own API call; the refusal names both
  // places they give it, the issue's page and a room whose agent records it as theirs
  it('names where the person gives it: the issue page, or a room act recording it as theirs', () => {
    expect(why).toContain("they give it on the issue's page (Production ruling)");
    expect(why).toContain('support.owner_forge_act, act issue.rule_production');
  });

  it('never tells an agent to have protection turned off', () => {
    for (const text of [
      why,
      protectedReaders(prod),
      protectedReaders({ name: 'p', tier: 'production' }),
    ]) {
      expect(text).not.toMatch(/protection off|protected: false|unprotect|turn[^.]*protection/i);
    }
    expect(protectedReaders(prod)).toContain("carries a project admin's ruling");
  });

  // ISS-1429 reopen: a set proposal left without `protected` turned a protected variable unprotected
  describe('a proposal never turns protection off', () => {
    const held = { key: 'STRIPE_KEY', environment: 'canawan', protected: true };

    it('keeps a protected variable protected where the proposal leaves `protected` out', () => {
      expect(proposedProtection(undefined, held)).toEqual({ protected: true, refusals: [] });
      expect(proposedProtection(true, held)).toEqual({ protected: true, refusals: [] });
    });

    it('refuses `protected: false` on a protected variable by name, pointing at the ruling', () => {
      const { refusals } = proposedProtection(false, held);
      expect(refusals.map((r) => r.code)).toEqual(['VARIABLE_PROPOSAL_UNPROTECTS']);
      expect(refusals[0]?.path).toBe('/protected');
      expect(refusals[0]?.detail).toContain('STRIPE_KEY is protected on `canawan`');
      expect(refusals[0]?.detail).toContain('a person holding project.admin for a ruling once');
      expect(
        proposedProtection(false, { ...held, environment: null }).refusals[0]?.detail,
      ).toContain('protected on every environment');
    });

    it('leaves a new key and an unprotected one as asked, unprotected by default', () => {
      expect(proposedProtection(undefined, null)).toEqual({ protected: false, refusals: [] });
      expect(proposedProtection(true, null)).toEqual({ protected: true, refusals: [] });
      const plain = { ...held, protected: false };
      expect(proposedProtection(undefined, plain)).toEqual({ protected: false, refusals: [] });
      expect(proposedProtection(false, plain)).toEqual({ protected: false, refusals: [] });
    });
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
