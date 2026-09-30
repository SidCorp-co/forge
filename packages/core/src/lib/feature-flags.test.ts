import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FeatureFlag, isEnabled, snapshotFlags } from './feature-flags';

describe('feature-flags', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Strip any FEATURE_* env keys that might bleed in from the dev shell.
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('FEATURE_')) delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('FEATURE_')) delete process.env[k];
    }
    Object.assign(process.env, originalEnv);
  });

  it('returns true by default (no env set) — flags ship on for v0.1.x alpha', () => {
    expect(isEnabled('commentMentions')).toBe(true);
    expect(isEnabled('knowledgeOps')).toBe(true);
  });

  it('explicit FEATURE_X=false overrides default-on', () => {
    process.env.FEATURE_COMMENT_MENTIONS = 'false';
    expect(isEnabled('commentMentions')).toBe(false);
    process.env.FEATURE_KNOWLEDGE_OPS = '0';
    expect(isEnabled('knowledgeOps')).toBe(false);
  });

  it('reads `true` from env (camelCase → SCREAMING_SNAKE_CASE)', () => {
    process.env.FEATURE_COMMENT_MENTIONS = 'true';
    expect(isEnabled('commentMentions')).toBe(true);
  });

  it('reads `1` as enabled', () => {
    process.env.FEATURE_KNOWLEDGE_OPS = '1';
    expect(isEnabled('knowledgeOps')).toBe(true);
  });

  it('rejects other values (e.g. "on", "yes")', () => {
    process.env.FEATURE_COMMENT_MENTIONS = 'on';
    expect(isEnabled('commentMentions')).toBe(false);
    process.env.FEATURE_COMMENT_MENTIONS = 'yes';
    expect(isEnabled('commentMentions')).toBe(false);
  });

  it('snapshotFlags returns every defined flag', () => {
    const snap = snapshotFlags();
    const expectedKeys: FeatureFlag[] = [
      'commentMentions',
      'userPreferences',
      'knowledgeOps',
      'webhookAdapter',
    ];
    for (const k of expectedKeys) {
      expect(snap).toHaveProperty(k);
      expect(typeof snap[k]).toBe('boolean');
    }
  });
});
