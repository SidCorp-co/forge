import { describe, expect, it } from 'vitest';
import { renderSentryTargetsLine, resolveSentryTarget, resolveSentryTargets } from './targets.js';

const core = { label: 'core', organizationSlug: 'canawan', projectSlug: 'forge-core' };

describe('the targets a binding declares', () => {
  it('reads the binding list and nothing else', () => {
    expect(resolveSentryTargets({ host: 'h', targets: [core] })).toEqual([core]);
  });

  it('derives no `default` target from legacy slugs: that pair is not Sentry config any more', () => {
    const legacy = { host: 'h', organizationSlug: 'canawan', projectSlug: 'web' } as never;

    expect(resolveSentryTargets(legacy)).toEqual([]);
  });

  it('answers none for an absent config or a targets value that is not a list', () => {
    expect(resolveSentryTargets(null)).toEqual([]);
    expect(resolveSentryTargets({ host: 'h', targets: 'core' } as never)).toEqual([]);
  });

  it('refuses a label the binding does not declare, listing the labels it does', () => {
    expect(() => resolveSentryTarget({ host: 'h', targets: [core] }, 'billing')).toThrow(
      /no target labelled "billing" — this binding declares: core/,
    );
  });

  it('prompts with the targets it was given', () => {
    expect(renderSentryTargetsLine([core])).toBe('  - core: org=canawan project=forge-core');
  });
});
