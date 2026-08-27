import { describe, expect, it } from 'vitest';
import {
  AUTONOMOUS_FACT_CONTRACT,
  declaredAutonomousFacts,
  missingAutonomousFacts,
} from './autonomous-contract.js';
import { RESERVED_PROJECT_FACT_KEYS } from './project-facts.js';

const ANSWERED = { 'build-commands': 'pnpm build', 'test-commands': 'pnpm test' };

describe('missingAutonomousFacts', () => {
  it('reports every required key on a project that has answered nothing', () => {
    expect(missingAutonomousFacts({}).map((f) => f.key)).toEqual([
      'build-commands',
      'test-commands',
    ]);
    expect(missingAutonomousFacts(null).map((f) => f.key)).toHaveLength(2);
  });

  it('passes a project that has answered the required keys', () => {
    expect(missingAutonomousFacts(ANSWERED)).toEqual([]);
  });

  // cm:guard blank must count as missing, or a half-filled settings form flips the project to autonomous with a build command the agent cannot run
  it('counts a blank or whitespace answer as unanswered', () => {
    expect(
      missingAutonomousFacts({ ...ANSWERED, 'test-commands': '   ' }).map((f) => f.key),
    ).toEqual(['test-commands']);
    expect(missingAutonomousFacts({ ...ANSWERED, 'build-commands': '' }).map((f) => f.key)).toEqual(
      ['build-commands'],
    );
  });

  it('ignores an optional key left unanswered', () => {
    expect(missingAutonomousFacts({ ...ANSWERED, 'deploy-policy': '' })).toEqual([]);
  });
});

describe('AUTONOMOUS_FACT_CONTRACT', () => {
  // cm:guard a contract key that collides with a reserved key is unsettable: mergeProjectFacts drops reserved keys silently, so the gate would demand an answer the author has no way to give
  it('claims no key that projectFacts reserves as derived', () => {
    const reserved = new Set<string>(RESERVED_PROJECT_FACT_KEYS);
    expect(AUTONOMOUS_FACT_CONTRACT.filter((f) => reserved.has(f.key))).toEqual([]);
  });

  it('gives every key a role, since the role is what the operator is shown', () => {
    expect(AUTONOMOUS_FACT_CONTRACT.every((f) => f.role.trim().length > 0)).toBe(true);
  });
});

describe('declaredAutonomousFacts', () => {
  it('returns answered keys in contract order, trimmed', () => {
    expect(
      declaredAutonomousFacts({ 'test-commands': ' pnpm test\n', 'build-commands': 'pnpm build' }),
    ).toEqual([
      { fact: AUTONOMOUS_FACT_CONTRACT[0], text: 'pnpm build' },
      { fact: AUTONOMOUS_FACT_CONTRACT[1], text: 'pnpm test' },
    ]);
  });

  it('skips keys the project never set and anything outside the contract', () => {
    expect(declaredAutonomousFacts({ 'build-commands': 'x', 'unrelated-note': 'y' })).toEqual([
      { fact: AUTONOMOUS_FACT_CONTRACT[0], text: 'x' },
    ]);
  });
});
