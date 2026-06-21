import { describe, expect, it } from 'vitest';
import { renderSentryTargetsLine, resolveSentryTargets } from './targets.js';
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
    expect(resolveSentryTargets(cfg)).toEqual([
      { label: 'default', organizationSlug: 'anhome' },
    ]);
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
