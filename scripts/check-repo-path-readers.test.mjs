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

  it('finds raw SQL naming the table with no alias, the column bare (judge-126 plant E)', () => {
    const found = reads(
      'const [row] = await db.execute(sql`\n  SELECT repo_path FROM projects WHERE id = ${projectId}\n`);\n',
    );
    expect(found.map((r) => [r.line, r.how])).toEqual([[2, 'repo_path (in SQL over projects)']]);
  });

  it('finds a bare column in SQL over projects whose expressions hold templates of their own', () => {
    const found = reads(
      'sql`SELECT id, ${flag ? sql`name` : sql`slug`}, repo_path\n  FROM projects\n  WHERE ${where}`;\n',
    );
    expect(found.map((r) => [r.line, r.how])).toEqual([[1, 'repo_path (in SQL over projects)']]);
  });

  it('finds a whole row read off projects, which hands the file repoPath (judge-126 plant F)', () => {
    const found = reads(
      'const [p] = await db\n  .select()\n  .from(projects)\n  .where(eq(projects.id, id));\nreturn p.repoPath;\n',
    );
    expect(found.map((r) => [r.line, r.how])).toEqual([[3, 'a whole row of projects']]);
  });

  it('finds the other whole-row shapes: relational query, returning(), SELECT * and alias.*', () => {
    const found = reads(
      'await db.query.projects.findFirst({ where: eq(projects.id, id) });\n' +
        'await db.update(projects).set({ name }).where(eq(projects.id, id)).returning();\n' +
        'sql`SELECT * FROM projects WHERE id = ${id}`;\n' +
        'sql`SELECT p.* FROM projects p JOIN jobs j ON j.project_id = p.id`;\n' +
        'const cols = getTableColumns(projects);\n',
    );
    expect(found.map((r) => [r.line, r.how])).toEqual([
      [1, 'a whole row of projects'],
      [2, 'a whole row of projects'],
      [3, 'a whole row of projects (SELECT *)'],
      [4, 'a whole row of projects (p.*)'],
      [5, 'a whole row of projects'],
    ]);
  });

  it('finds a read through the table drizzle interpolates, named or bare (review F1)', () => {
    const found = reads(
      'sql`SELECT ${projects}.repo_path FROM ${projects}`;\n' +
        'sql`SELECT projects.repo_path FROM ${table}`;\n' +
        'sql`SELECT repo_path FROM ${projects} WHERE id = ${id}`;\n',
    );
    expect(found.map((r) => [r.line, r.how])).toEqual([
      [1, 'projects.repo_path'],
      [2, 'projects.repo_path'],
      [3, 'repo_path (in SQL over projects)'],
    ]);
  });

  it('passes SQL over projects that names its columns, a count, and a bare column of another table', () => {
    expect(
      reads(
        'sql`SELECT p.slug, count(*) FROM projects p GROUP BY p.slug`;\n' +
          'sql`SELECT repo_path FROM runners WHERE device_id = ${id}`;\n' +
          'await db.select({ slug: projects.slug }).from(projects);\n' +
          'await db.update(projects).set({ name }).returning({ id: projects.id });\n',
      ),
    ).toEqual([]);
  });

  it('passes the device binding, which is where a working directory comes from', () => {
    expect(
      reads(
        'await db.select({ repoPath: runners.repoPath }).from(runners);\n' +
          'sql`SELECT r.repo_path FROM jobs j LEFT JOIN runners r ON r.device_id = j.device_id`;\n',
      ),
    ).toEqual([]);
  });

  it('reads past a URL in a string, which is not a comment', () => {
    const found = reads(
      "const endpoint = 'https://example.com'; const checkout = projects.repoPath;\n",
    );
    expect(found.map((r) => [r.line, r.how])).toEqual([[1, 'projects.repoPath']]);
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
