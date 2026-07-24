import { describe, expect, it } from 'vitest';
import { FORGE_GUIDES, getGuide, listGuides } from './registry.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
// Guardrail (D2 in the plan): the public /api/guides route is fully
// unauthenticated, so a secret-shaped literal here would be a real leak.
const SECRET_SHAPE_RE = /password\s*[:=]|Bearer [A-Za-z0-9]{12,}|forge_pat_|crmk_/i;

describe('FORGE_GUIDES registry', () => {
  it('has at least the 6 seed guides required by AC4', () => {
    const slugs = new Set(FORGE_GUIDES.map((g) => g.slug));
    for (const required of [
      'project-settings-and-test-credentials',
      'issue-dependencies-and-decompose',
      'memory-and-knowledge',
      'deploy-safety',
      'pipeline-and-issue-lifecycle',
      'attachments-and-uploads',
    ]) {
      expect(slugs.has(required)).toBe(true);
    }
  });

  it('every slug is unique and URL-safe kebab-case', () => {
    const slugs = FORGE_GUIDES.map((g) => g.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(SLUG_RE);
    }
  });

  it('every guide has a non-empty title, single-line summary, and body', () => {
    for (const guide of FORGE_GUIDES) {
      expect(guide.title.trim().length).toBeGreaterThan(0);
      expect(guide.summary.trim().length).toBeGreaterThan(0);
      expect(guide.summary).not.toContain('\n');
      expect(guide.body.trim().length).toBeGreaterThan(0);
      expect(guide.version).toBeGreaterThanOrEqual(1);
    }
  });

  it('no guide body contains a secret-shaped literal (public-route safety)', () => {
    for (const guide of FORGE_GUIDES) {
      expect(guide.body).not.toMatch(SECRET_SHAPE_RE);
    }
  });

  it('listGuides returns a body-free index', () => {
    const index = listGuides();
    expect(index.length).toBe(FORGE_GUIDES.length);
    for (const entry of index) {
      expect('body' in entry).toBe(false);
      expect(entry.slug).toBeTruthy();
      expect(entry.title).toBeTruthy();
      expect(entry.summary).toBeTruthy();
      expect(entry.version).toBeGreaterThanOrEqual(1);
    }
  });

  it('getGuide round-trips a known slug and returns undefined for an unknown one', () => {
    const known = FORGE_GUIDES[0];
    expect(known).toBeDefined();
    if (!known) return;
    expect(getGuide(known.slug)).toEqual(known);
    expect(getGuide('not-a-real-guide-slug')).toBeUndefined();
  });
});
