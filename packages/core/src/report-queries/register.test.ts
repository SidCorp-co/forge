import { afterEach, describe, expect, it } from 'vitest';
import { registerReportQueries } from './register.js';
import { clearReportQueriesForTest, listReportQueries } from './registry.js';

afterEach(() => clearReportQueriesForTest());

describe('registerReportQueries', () => {
  it('registers the five Phase A queries, each declaring what it reads, under one shape', () => {
    registerReportQueries();
    const all = listReportQueries();
    expect(all.map((q) => q.descriptor.id).sort()).toEqual([
      'criteria-coverage',
      'progress-by-requirement',
      'release-readiness',
      'roadmap-eta',
      'workflow-status',
    ]);
    for (const q of all) {
      expect(q.reads.length, q.descriptor.id).toBeGreaterThan(0);
      expect(q.descriptor.permission, q.descriptor.id).toBe('project.read');
    }
  });

  it('refuses a second registration of the same set, naming the first duplicate', () => {
    registerReportQueries();
    expect(() => registerReportQueries()).toThrow(/is already registered/);
  });
});
