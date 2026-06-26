import { describe, expect, it } from 'vitest';
import { GOLDEN_UX_CONTRACT } from './ux-contract-compiler.fixtures.js';
import { compileUxContract } from './ux-contract-compiler.js';
import {
  PRESET_DEFAULT_TOGGLES,
  type UxToggleSettings,
  WEB_V2_PROFILE,
  compilePresetToRules,
  scaffoldOf,
} from './ux-contract-presets.js';

const ids = (toggles?: UxToggleSettings) =>
  compilePresetToRules('app-strict', WEB_V2_PROFILE, toggles).map((r) => r.id);

describe('compilePresetToRules', () => {
  it('app-strict + web-v2 profile reproduces the golden forge-dev contract', () => {
    const rules = compilePresetToRules('app-strict', WEB_V2_PROFILE);
    const prose = compileUxContract(rules, scaffoldOf(WEB_V2_PROFILE));
    expect(prose).toBe(GOLDEN_UX_CONTRACT);
  });

  it('app-strict defaults emit the full 22-rule catalog', () => {
    expect(ids(PRESET_DEFAULT_TOGGLES['app-strict'])).toHaveLength(22);
  });

  it('emptySearchRequired:false drops exactly st-empty-search', () => {
    const base = ids(PRESET_DEFAULT_TOGGLES['app-strict']);
    const off = ids({ ...PRESET_DEFAULT_TOGGLES['app-strict'], emptySearchRequired: false });
    expect(base.filter((i) => !off.includes(i))).toEqual(['st-empty-search']);
  });

  it('a11yLevel:basic drops exactly the two advanced a11y rules', () => {
    const base = ids(PRESET_DEFAULT_TOGGLES['app-strict']);
    const basic = ids({ ...PRESET_DEFAULT_TOGGLES['app-strict'], a11yLevel: 'basic' });
    expect(base.filter((i) => !basic.includes(i)).sort()).toEqual([
      'a11y-contrast',
      'a11y-reduced-motion',
    ]);
  });

  it('destructiveConfirm:false drops exactly fl-destructive-confirm', () => {
    const base = ids(PRESET_DEFAULT_TOGGLES['app-strict']);
    const off = ids({ ...PRESET_DEFAULT_TOGGLES['app-strict'], destructiveConfirm: false });
    expect(base.filter((i) => !off.includes(i))).toEqual(['fl-destructive-confirm']);
  });

  it('mobileResponsive:false drops exactly rs-375', () => {
    const base = ids(PRESET_DEFAULT_TOGGLES['app-strict']);
    const off = ids({ ...PRESET_DEFAULT_TOGGLES['app-strict'], mobileResponsive: false });
    expect(base.filter((i) => !off.includes(i))).toEqual(['rs-375']);
  });

  it('optimisticUI:false drops exactly fl-optimistic', () => {
    const base = ids(PRESET_DEFAULT_TOGGLES['app-strict']);
    const off = ids({ ...PRESET_DEFAULT_TOGGLES['app-strict'], optimisticUI: false });
    expect(base.filter((i) => !off.includes(i))).toEqual(['fl-optimistic']);
  });

  it('preset defaults differ: marketing & internal-tool are relaxations of app-strict', () => {
    const strict = compilePresetToRules('app-strict', WEB_V2_PROFILE).map((r) => r.id);
    const marketing = compilePresetToRules('marketing', WEB_V2_PROFILE).map((r) => r.id);
    const internal = compilePresetToRules('internal-tool', WEB_V2_PROFILE).map((r) => r.id);
    // marketing: no empty-search, no optimistic, basic a11y
    expect(marketing).not.toContain('st-empty-search');
    expect(marketing).not.toContain('fl-optimistic');
    expect(marketing).not.toContain('a11y-contrast');
    expect(marketing).toContain('rs-375'); // still responsive
    // internal-tool: keeps empty-search, drops mobile + advanced a11y
    expect(internal).toContain('st-empty-search');
    expect(internal).not.toContain('rs-375');
    expect(internal).not.toContain('a11y-reduced-motion');
    // both are strict subsets of the full catalog
    expect(marketing.every((i) => strict.includes(i))).toBe(true);
    expect(internal.every((i) => strict.includes(i))).toBe(true);
  });

  it('overrides fall back to generic text when the profile lacks one', () => {
    const rules = compilePresetToRules('app-strict'); // no profile
    const loading = rules.find((r) => r.id === 'st-loading');
    expect(loading?.text).toContain('skeleton'); // generic, not the web-v2 `<Skeleton>` text
    expect(loading?.text).not.toContain('<Skeleton>');
  });
});
