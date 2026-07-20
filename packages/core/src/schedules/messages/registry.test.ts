import { describe, expect, it } from 'vitest';
import {
  RETIRED_STRATEGY_INPUTS,
  getImprovementMessage,
  improvementMessages,
  listImprovementMessages,
} from './registry.js';

describe('improvementMessages registry', () => {
  it('listImprovementMessages returns an array', () => {
    const list = listImprovementMessages();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toBe(improvementMessages);
  });

  it('all messages have required fields', () => {
    for (const msg of listImprovementMessages()) {
      expect(msg.key).toBeTruthy();
      expect(msg.title).toBeTruthy();
      expect(msg.message).toBeTruthy();
      expect(msg.rationale).toBeTruthy();
      expect(msg.category).toBeTruthy();
      expect(typeof msg.version).toBe('number');
      expect(typeof msg.recommended).toBe('boolean');
      expect(['propose', 'auto']).toContain(msg.defaultMode);
    }
  });

  it('all keys are unique', () => {
    const keys = listImprovementMessages().map((m) => m.key);
    expect(keys).toHaveLength(new Set(keys).size);
  });

  it('getImprovementMessage returns undefined for unknown key', () => {
    expect(getImprovementMessage('non-existent-key')).toBeUndefined();
  });

  it('getImprovementMessage returns the message for a known key', () => {
    const first = listImprovementMessages()[0]!;
    expect(getImprovementMessage(first.key)).toBe(first);
  });

  // AC1: 3 one-shot entries removed from registry
  it('registry does NOT contain the 3 retired one-shot keys', () => {
    expect(getImprovementMessage('merged-at-on-pass')).toBeUndefined();
    expect(getImprovementMessage('release-conflict-2tier')).toBeUndefined();
    expect(getImprovementMessage('qa-quality-bar')).toBeUndefined();
  });

  // AC2: optimize-skills standing entry present
  it('registry contains the optimize-skills standing entry', () => {
    const msg = getImprovementMessage('optimize-skills');
    expect(msg).toBeDefined();
    expect(msg!.standing).toBe(true);
    expect(msg!.category).toBe('steward');
    expect(msg!.recommended).toBe(true);
  });

  it('optimize-skills has correct shape', () => {
    const msg = getImprovementMessage('optimize-skills');
    expect(msg).toBeDefined();
    expect(msg!.version).toBe(1);
    expect(msg!.defaultMode).toBe('propose');
    expect(msg!.standing).toBe(true);
    expect(msg!.title).toBeTruthy();
    expect(msg!.message).toBeTruthy();
    expect(msg!.rationale).toBeTruthy();
  });

  it('registry contains the standing templates (steward + drift-check + product-map-refresh + feedback-digest)', () => {
    const keys = listImprovementMessages().map((m) => m.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'optimize-skills',
        'knowledge-drift-check',
        'product-map-refresh',
        'feedback-triage-digest',
      ]),
    );
    expect(listImprovementMessages()).toHaveLength(4);
  });

  it('all registry entries are standing', () => {
    const standing = listImprovementMessages().filter((m) => m.standing === true);
    expect(standing.map((m) => m.key).sort()).toEqual(
      [
        'knowledge-drift-check',
        'optimize-skills',
        'product-map-refresh',
        'feedback-triage-digest',
      ].sort(),
    );
  });

  // feedback-triage-digest standing entry (ISS-713)
  it('registry contains the feedback-triage-digest standing entry', () => {
    const msg = getImprovementMessage('feedback-triage-digest');
    expect(msg).toBeDefined();
    expect(msg!.standing).toBe(true);
    expect(msg!.category).toBe('ops');
    expect(msg!.recommended).toBe(true);
    expect(msg!.defaultMode).toBe('propose');
    expect(msg!.version).toBe(1);
  });

  // product-map-refresh standing entry (ISS-587 Tier-3 MVP)
  it('registry contains the product-map-refresh standing entry with auto default', () => {
    const msg = getImprovementMessage('product-map-refresh');
    expect(msg).toBeDefined();
    expect(msg!.standing).toBe(true);
    expect(msg!.category).toBe('documentation');
    expect(msg!.recommended).toBe(true);
    expect(msg!.defaultMode).toBe('auto');
    expect(msg!.appliesWhen).toBeTruthy();
  });
});

describe('RETIRED_STRATEGY_INPUTS', () => {
  it('contains all 3 retired patterns', () => {
    expect(RETIRED_STRATEGY_INPUTS.MERGED_AT_ON_PASS.key).toBe('merged-at-on-pass');
    expect(RETIRED_STRATEGY_INPUTS.RELEASE_CONFLICT_2TIER.key).toBe('release-conflict-2tier');
    expect(RETIRED_STRATEGY_INPUTS.QA_QUALITY_BAR.key).toBe('qa-quality-bar');
  });

  it('each retired pattern has message and appliesWhen', () => {
    for (const input of Object.values(RETIRED_STRATEGY_INPUTS)) {
      expect(input.message).toBeTruthy();
      expect(input.appliesWhen).toBeTruthy();
      expect(input.appliesToSkills.length).toBeGreaterThan(0);
    }
  });
});
