import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isEnabled, snapshotFlags, type FeatureFlag } from './feature-flags';

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

  it('returns false by default (no env set)', () => {
    expect(isEnabled('chatProvider')).toBe(false);
    expect(isEnabled('runnerFramework')).toBe(false);
  });

  it('reads `true` from env (camelCase → SCREAMING_SNAKE_CASE)', () => {
    process.env.FEATURE_CHAT_PROVIDER = 'true';
    expect(isEnabled('chatProvider')).toBe(true);
  });

  it('reads `1` as enabled', () => {
    process.env.FEATURE_RUNNER_FRAMEWORK = '1';
    expect(isEnabled('runnerFramework')).toBe(true);
  });

  it('rejects other values (e.g. "on", "yes")', () => {
    process.env.FEATURE_CHAT_PROVIDER = 'on';
    expect(isEnabled('chatProvider')).toBe(false);
    process.env.FEATURE_CHAT_PROVIDER = 'yes';
    expect(isEnabled('chatProvider')).toBe(false);
  });

  it('snapshotFlags returns every defined flag', () => {
    const snap = snapshotFlags();
    const expectedKeys: FeatureFlag[] = [
      'chatProvider',
      'runnerFramework',
      'pipelineControl',
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
