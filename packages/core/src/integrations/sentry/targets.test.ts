import { describe, expect, it } from 'vitest';
import { renderSentryTargetsLine, resolveSentryTarget, resolveSentryTargets } from './targets.js';
import type { SentryConfig } from './types.js';

const base = (over: Partial<SentryConfig>): SentryConfig =>
  ({ host: 'logs.canawan.com', environment: 'prod', ...over }) as SentryConfig;

describe('resolveSentryTargets', () => {
  it('returns targets[] when present & non-empty', () => {
    const cfg = base({
      targets: [
        { label: 'Backend', organizationSlug: 'acme', projectSlug: 'be' },
        { label: 'Mobile', organizationSlug: 'acme', projectSlug: 'mob' },
      ],
    });
    expect(resolveSentryTargets(cfg)).toEqual([
      { label: 'Backend', organizationSlug: 'acme', projectSlug: 'be' },
      { label: 'Mobile', organizationSlug: 'acme', projectSlug: 'mob' },
    ]);
  });

  it('takes targets[] over legacy single-slug fields when both present', () => {
    const cfg = base({
      organizationSlug: 'legacy-org',
      projectSlug: 'legacy-proj',
      targets: [{ label: 'Backend', organizationSlug: 'acme', projectSlug: 'be' }],
    });
    expect(resolveSentryTargets(cfg)).toEqual([
      { label: 'Backend', organizationSlug: 'acme', projectSlug: 'be' },
    ]);
  });

  it('synthesizes one default target from legacy single-slug fields', () => {
    const cfg = base({ organizationSlug: 'anhome', projectSlug: 'anhome-mobile' });
    expect(resolveSentryTargets(cfg)).toEqual([
      { label: 'default', organizationSlug: 'anhome', projectSlug: 'anhome-mobile' },
    ]);
  });

  it('synthesizes a default target from a partial legacy pair (org only)', () => {
    const cfg = base({ organizationSlug: 'anhome' });
    expect(resolveSentryTargets(cfg)).toEqual([{ label: 'default', organizationSlug: 'anhome' }]);
  });

  it('returns [] for a host-only config with no targets or legacy slugs', () => {
    expect(resolveSentryTargets(base({}))).toEqual([]);
  });

  it('returns [] for an empty targets array (falls through, no legacy)', () => {
    expect(resolveSentryTargets(base({ targets: [] }))).toEqual([]);
  });

  it('returns [] for null/undefined config', () => {
    expect(resolveSentryTargets(null)).toEqual([]);
    expect(resolveSentryTargets(undefined)).toEqual([]);
  });
});

describe('renderSentryTargetsLine', () => {
  it('renders label + org + project + env + notes', () => {
    const line = renderSentryTargetsLine([
      {
        label: 'Backend prod',
        organizationSlug: 'acme',
        projectSlug: 'be',
        environment: 'prod',
        notes: 'API errors live here',
      },
    ]);
    expect(line).toBe('  - Backend prod: org=acme project=be env=prod — API errors live here');
  });

  it('omits optional scope/notes that are absent', () => {
    expect(renderSentryTargetsLine([{ label: 'Frontend' }])).toBe('  - Frontend:');
    expect(renderSentryTargetsLine([{ label: 'FE', projectSlug: 'fe' }])).toBe(
      '  - FE: project=fe',
    );
  });

  it('joins multiple targets one per line', () => {
    const line = renderSentryTargetsLine([
      { label: 'Backend', projectSlug: 'be' },
      { label: 'Mobile', projectSlug: 'mob' },
    ]);
    expect(line).toBe('  - Backend: project=be\n  - Mobile: project=mob');
  });

  it('returns empty string for no targets', () => {
    expect(renderSentryTargetsLine([])).toBe('');
  });
});

describe('resolveSentryTarget (ISS-1085)', () => {
  const targets = [
    { label: 'forge-core', organizationSlug: 'canawan', projectSlug: 'forge-core' },
    { label: 'forge-web', organizationSlug: 'canawan', projectSlug: 'forge-web' },
  ];

  it('returns the named target', () => {
    expect(resolveSentryTarget({ host: 'h', targets }, 'forge-web')).toEqual({
      label: 'forge-web',
      organizationSlug: 'canawan',
      projectSlug: 'forge-web',
    });
  });

  it('resolves the ISS-524 legacy single-slug config as the `default` target', () => {
    expect(
      resolveSentryTarget({ host: 'h', organizationSlug: 'canawan', projectSlug: 'forge-core' }),
    ).toEqual({ label: 'default', organizationSlug: 'canawan', projectSlug: 'forge-core' });
  });

  it('carries the environment through when the target declares one', () => {
    expect(
      resolveSentryTarget({ host: 'h', targets: [{ ...targets[0], environment: 'prod' }] }),
    ).toMatchObject({ environment: 'prod' });
  });

  it('refuses an unknown label rather than guessing a Sentry project', () => {
    expect(() => resolveSentryTarget({ host: 'h', targets }, 'forge-mobile')).toThrow(
      'sentry: no target labelled "forge-mobile" — this binding declares: forge-core, forge-web',
    );
  });

  it('refuses an absent label where several targets are declared', () => {
    expect(() => resolveSentryTarget({ host: 'h', targets })).toThrow(
      'sentry: no target label was named and this binding declares 2: forge-core, forge-web',
    );
  });

  it('refuses a target carrying no organizationSlug, naming it', () => {
    expect(() => resolveSentryTarget({ host: 'h', targets: [{ label: 'forge-core' }] })).toThrow(
      'sentry: target "forge-core" declares no organizationSlug',
    );
  });

  it('refuses a binding declaring no targets at all', () => {
    expect(() => resolveSentryTarget({ host: 'h' })).toThrow(
      'sentry: this binding declares no targets',
    );
  });
});
