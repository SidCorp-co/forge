import { describe, expect, it } from 'vitest';
import { DECLARED, readsIn } from './check-repo-path-readers.mjs';

// The fixtures are FIXTURE TEXT — source this checker parses, not source this file runs.
const reads = (source) => readsIn('packages/core/src/fixture.ts', source);

describe('check-repo-path-readers — a working directory is the device binding', () => {
  it('finds a drizzle select of the project path', () => {
    const found = reads(
      'const [p] = await db.select({ id: projects.id, repoPath: projects.repoPath }).from(projects);\n',
    );
    expect(found).toEqual([
      { rel: 'packages/core/src/fixture.ts', line: 1, how: 'projects.repoPath' },
    ]);
  });

  it('finds raw SQL through an alias of projects', () => {
    const found = reads(
      'const rows = await db.execute(sql`\n  SELECT p.repo_path\n  FROM jobs j\n  JOIN projects p ON p.id = j.project_id\n`);\n',
    );
    expect(found.map((r) => [r.line, r.how])).toEqual([[2, 'p.repo_path (projects)']]);
  });

  it('finds raw SQL naming the table', () => {
    expect(reads('sql`SELECT projects.repo_path FROM projects`;\n').map((r) => r.how)).toEqual([
      'projects.repo_path',
    ]);
  });

  it('passes the device binding, which is where a working directory comes from', () => {
    expect(
      reads(
        'await db.select({ repoPath: runners.repoPath }).from(runners);\n' +
          'sql`SELECT r.repo_path FROM jobs j LEFT JOIN runners r ON r.device_id = j.device_id`;\n',
      ),
    ).toEqual([]);
  });

  it('passes a comment that names the column', () => {
    expect(reads('// `projects.repoPath` is the bind-time default\n')).toEqual([]);
  });

  it('declares every reader with a reason', () => {
    for (const [rel, why] of DECLARED) {
      expect(rel).toMatch(/^packages\/core\/src\/.+\.ts$/);
      expect(why.length).toBeGreaterThan(10);
    }
  });
});
