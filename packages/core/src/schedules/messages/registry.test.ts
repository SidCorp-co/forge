import { describe, expect, it } from 'vitest';
import {
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

  it('registry contains exactly 3 seed messages', () => {
    expect(listImprovementMessages()).toHaveLength(3);
  });

  it('merged-at-on-pass has correct shape', () => {
    const msg = getImprovementMessage('merged-at-on-pass');
    expect(msg).toBeDefined();
    expect(msg!.category).toBe('pipeline-correctness');
    expect(msg!.appliesToSkills).toContain('forge-test');
    expect(msg!.appliesWhen).toBeTruthy();
    expect(msg!.version).toBe(1);
    expect(msg!.recommended).toBe(true);
  });

  it('release-conflict-2tier has correct shape', () => {
    const msg = getImprovementMessage('release-conflict-2tier');
    expect(msg).toBeDefined();
    expect(msg!.category).toBe('pipeline-correctness');
    expect(msg!.appliesToSkills).toContain('forge-release');
    expect(msg!.appliesWhen).toBeTruthy();
    expect(msg!.version).toBe(1);
    expect(msg!.recommended).toBe(true);
  });

  it('qa-quality-bar has correct shape', () => {
    const msg = getImprovementMessage('qa-quality-bar');
    expect(msg).toBeDefined();
    expect(msg!.category).toBe('quality');
    expect(msg!.appliesToSkills).toContain('forge-test');
    expect(msg!.appliesWhen).toBeTruthy();
    expect(msg!.version).toBe(1);
    expect(msg!.recommended).toBe(true);
  });
});
