import { describe, expect, it } from 'vitest';
import {
  GOLDEN_UX_CONTRACT,
  UX_CONTRACT_SEED_RULES,
  WEB_V2_SCAFFOLD,
} from './ux-contract-compiler.fixtures.js';
import { compileUxContract } from './ux-contract-compiler.js';

describe('compileUxContract', () => {
  it('reproduces the golden forge-dev contract from the seed fixture + web-v2 scaffold', () => {
    const result = compileUxContract(UX_CONTRACT_SEED_RULES, WEB_V2_SCAFFOLD);
    expect(result).toBe(GOLDEN_UX_CONTRACT);
  });

  it('excludes non-active rules', () => {
    const rules = [
      { group: 'designSystem', text: 'active rule', status: 'active', orderIndex: 0 },
      { group: 'designSystem', text: 'retired rule', status: 'retired', orderIndex: 1 },
      { group: 'designSystem', text: 'proposed rule', status: 'proposed', orderIndex: 2 },
    ];
    const result = compileUxContract(rules, WEB_V2_SCAFFOLD);
    expect(result).toContain('- active rule');
    expect(result).not.toContain('- retired rule');
    expect(result).not.toContain('- proposed rule');
  });

  it('orders rules by orderIndex within each group', () => {
    const rules = [
      { group: 'designSystem', text: 'second', status: 'active', orderIndex: 1 },
      { group: 'designSystem', text: 'first', status: 'active', orderIndex: 0 },
    ];
    const result = compileUxContract(rules, WEB_V2_SCAFFOLD);
    const firstIdx = result.indexOf('- first');
    const secondIdx = result.indexOf('- second');
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it('emits sections in the fixed group order (designSystem → states → flows → a11y → microcopy → responsive)', () => {
    const rules = [
      { group: 'responsive', text: 'r', status: 'active', orderIndex: 0 },
      { group: 'designSystem', text: 'ds', status: 'active', orderIndex: 0 },
    ];
    const result = compileUxContract(rules, WEB_V2_SCAFFOLD);
    const dsIdx = result.indexOf('## 1. Design system');
    const respIdx = result.indexOf('## 6. Responsive');
    expect(dsIdx).toBeLessThan(respIdx);
  });

  it('appends the states "Also:" suffix after states bullets', () => {
    const rules = [{ group: 'states', text: 'some state rule', status: 'active', orderIndex: 0 }];
    const result = compileUxContract(rules, WEB_V2_SCAFFOLD);
    const statesBulletIdx = result.indexOf('- some state rule');
    const alsoIdx = result.indexOf('Also: long text truncates');
    expect(alsoIdx).toBeGreaterThan(statesBulletIdx);
    // "Also:" must directly follow the last bullet (no blank line between)
    expect(result).toContain('- some state rule\nAlso: long text truncates');
  });

  it('always emits the DoD scaffolding', () => {
    const result = compileUxContract([], WEB_V2_SCAFFOLD);
    expect(result).toContain('## Definition of UX-Done (review checklist)');
    expect(result).toContain('Missing any applicable box ⇒ not done.');
  });

  // --- ISS-578: scaffold is now project-driven, not hardcoded ---

  it('builds the preamble label + binding scope from the scaffold', () => {
    const result = compileUxContract([], {
      projectLabel: 'marketing-site (acme)',
      bindingScope: 'apps/web/',
      knownGaps: [],
    });
    expect(result).toContain('# UX Completeness Contract — marketing-site (acme)');
    expect(result).toContain('adds/changes UI in `apps/web/`');
    expect(result).not.toContain('web-v2 (forge-dev)');
  });

  it('emits the Known gaps section only when the scaffold provides gaps', () => {
    const withGaps = compileUxContract([], {
      projectLabel: 'x',
      bindingScope: 'y/',
      knownGaps: ['No dark mode yet → keep light-only.'],
    });
    expect(withGaps).toContain("## Known gaps (don't 'fix' by reinventing");
    expect(withGaps).toContain('- No dark mode yet → keep light-only.');

    const noGaps = compileUxContract([], { projectLabel: 'x', bindingScope: 'y/', knownGaps: [] });
    expect(noGaps).not.toContain('## Known gaps');
  });

  it('does not end with a trailing newline', () => {
    const result = compileUxContract(UX_CONTRACT_SEED_RULES, WEB_V2_SCAFFOLD);
    expect(result.endsWith('\n')).toBe(false);
  });
});
