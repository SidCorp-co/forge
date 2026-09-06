import { describe, expect, it } from 'vitest';
import { FORGE_GUIDES, getGuide, listGuides } from './registry.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
// cm:why `GET /api/guides` is fully unauthenticated, so a secret-shaped literal in a guide body is a real leak rather than a style problem — which is why a test, not review, is what stops one landing
const SECRET_SHAPE_RE = /password\s*[:=]|Bearer [A-Za-z0-9]{12,}|forge_pat_|crmk_/i;

describe('FORGE_GUIDES registry', () => {
  it('has at least the 6 seed guides required by AC4', () => {
    const slugs = new Set(FORGE_GUIDES.map((g) => g.slug));
    for (const required of [
      'project-settings-and-test-credentials',
      'issue-dependencies',
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

  // cm:guard keep this in step with prompt/facts/registry.test.ts, which asserts the same three things about the prompt — an agent reads the prompt and a human reads this guide, and the two disagreeing about who may write `waiting` is how ISS-163 became six interventions
  it('the lifecycle guide teaches the RFC 0002 park model and nothing of the deleted one', () => {
    const body = getGuide('pipeline-and-issue-lifecycle')?.body ?? '';
    expect(body).toContain('A human is needed');
    expect(body).toContain('needs_decision');
    expect(body).toContain('needs_resource');
    expect(body).toContain('job_held');
    expect(body).not.toContain('operator_unblock');
    expect(body).not.toContain('data.unblock');
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

describe('module-taxonomy-migration guide (ISS-595)', () => {
  const body = getGuide('module-taxonomy-migration')?.body ?? '';

  it('states an idempotency key for both passes', () => {
    expect(body).toContain('(projectId, label name)');
    expect(body).toContain('(issueId, labelId, isPrimary)');
  });

  it('orders a read-only dry run before the write passes', () => {
    const dryRun = body.indexOf('### Pass 0 — dry run, reads only');
    const create = body.indexOf('### Pass 1 — create the modules');
    const attribute = body.indexOf('### Pass 2 — attribute the issues');
    expect(dryRun).toBeGreaterThan(-1);
    expect(dryRun).toBeLessThan(create);
    expect(create).toBeLessThan(attribute);
    expect(body).toContain('Nothing in this pass writes');
  });

  it('forbids deleting the old comment tags the migration supersedes', () => {
    expect(body).toContain('**Do not delete the old tags.**');
  });

  it('warns that `labels` replaces the set rather than adding to it', () => {
    expect(body).toContain('REPLACES the set');
  });
});
