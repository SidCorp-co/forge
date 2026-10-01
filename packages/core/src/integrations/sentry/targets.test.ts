import { describe, expect, it } from 'vitest';
import { sentryConfigBase } from './schemas.js';
import { resolveSentryTarget, resolveSentryTargets } from './targets.js';

const OLD_SHAPE = { host: 'sentry.io', organizationSlug: 'acme', projectSlug: 'web' };

describe('a Sentry config in the shape ISS-526 retired', () => {
  it('is refused by name rather than read as a target', () => {
    expect(() => resolveSentryTargets(OLD_SHAPE)).toThrow(
      expect.objectContaining({ name: 'SentryRefusal', reason: 'target_old_shape' }),
    );
    expect(() => resolveSentryTarget(OLD_SHAPE)).toThrow(/organizationSlug.*targets/);
  });

  it('is refused even beside a targets list, which it would otherwise sit under unread', () => {
    expect(() =>
      resolveSentryTargets({ ...OLD_SHAPE, targets: [{ label: 'web', organizationSlug: 'acme' }] }),
    ).toThrow(expect.objectContaining({ reason: 'target_old_shape' }));
  });

  it('is not accepted on write', () => {
    expect(sentryConfigBase.safeParse(OLD_SHAPE).success).toBe(false);
    expect(sentryConfigBase.safeParse({ host: 'sentry.io', targets: [] }).success).toBe(true);
  });
});

describe('a Sentry config in the targets shape', () => {
  it('answers its targets', () => {
    const targets = [{ label: 'web', organizationSlug: 'acme', projectSlug: 'web' }];
    expect(resolveSentryTargets({ host: 'sentry.io', targets })).toEqual(targets);
    expect(resolveSentryTargets({ host: 'sentry.io' })).toEqual([]);
    expect(resolveSentryTargets(null)).toEqual([]);
  });
});
