import { describe, expect, it } from 'vitest';
import { DECLARED, readsIn } from './check-repo-path-readers.mjs';

// The fixtures are FIXTURE TEXT — source this checker parses, not source this file runs.
const reads = (source, relations) => readsIn('packages/core/src/fixture.ts', source, relations);

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

  it('follows the table into a selection that holds it (judge-128 plant G)', () => {
    const found = reads(
      "import { projects, runners } from '../db/schema.js';\n" +
        'const g = await db.select({ project: projects }).from(runners);\n' +
        'await db.select({ projects }).from(runners);\n' +
        'await db.select({ ...projects }).from(runners);\n' +
        'await db.update(runners).set({ name }).returning({ owner: projects });\n',
    );
    expect(found.map((r) => [r.line, r.how])).toEqual([
      [2, 'a whole row of projects (an object holding the table)'],
      [3, 'a whole row of projects (an object holding the table)'],
      [4, 'a whole row of projects (an object holding the table)'],
      [5, 'a whole row of projects (an object holding the table)'],
    ]);
  });

  it('follows the table through alias(), an import under another name and a variable (plants J, K)', () => {
    const found = reads(
      "import { alias } from 'drizzle-orm/pg-core';\n" +
        "import { projects as p } from '../db/schema.js';\n" +
        "import { projects } from '../db/schema.js';\n" +
        'const j = await db.select({ path: p.repoPath }).from(p);\n' +
        "const pp = alias(projects, 'pp');\n" +
        'const k = await db.select({ path: pp.repoPath }).from(pp);\n' +
        'const table = projects;\n' +
        'const m = table?.repo_path;\n',
    );
    expect(found.map((r) => [r.line, r.how])).toEqual([
      [4, 'p.repoPath (projects)'],
      [6, 'pp.repoPath (projects)'],
      [8, 'table.repo_path (projects)'],
    ]);
  });

  it('follows the table through a namespace import', () => {
    const found = reads(
      "import * as schema from '../db/schema.js';\n" +
        'const a = schema.projects.repoPath;\n' +
        "const b = schema['projects'].repoPath;\n" +
        'const { projects: t } = schema;\n' +
        'const c = t.repoPath;\n',
    );
    expect(found.map((r) => [r.line, r.how])).toEqual([
      [2, 'schema.projects.repoPath (projects)'],
      [3, "schema['projects'].repoPath (projects)"],
      [5, 't.repoPath (projects)'],
    ]);
  });

  it('finds the path read by bracket or destructuring off the table (plant I)', () => {
    const found = reads(
      "const i = projects['repoPath'];\n" +
        'const i2 = projects[`repo_path`];\n' +
        'const { repoPath } = projects;\n' +
        'const { repoPath: where } = projects;\n',
    );
    expect(found.map((r) => [r.line, r.how])).toEqual([
      [1, "projects['repoPath']"],
      [2, "projects['repo_path']"],
      [3, 'projects.repoPath (destructured)'],
      [4, 'projects.repoPath (destructured)'],
    ]);
  });

  it('finds SQL naming the table with a schema, quoted, or through a quoted alias (plant L)', () => {
    const found = reads(
      'sql`SELECT repo_path FROM public.projects WHERE id = ${id}`;\n' +
        'sql`SELECT x.repo_path FROM "public"."projects" AS x`;\n' +
        'sql`SELECT "p"."repo_path" FROM "projects" "p"`;\n' +
        'sql`SELECT "projects"."repo_path" FROM jobs`;\n' +
        'sql`SELECT ${pp}.repo_path FROM jobs`;\n',
    );
    expect(found.map((r) => [r.line, r.how])).toEqual([
      [1, 'repo_path (in SQL over projects)'],
      [2, 'x.repo_path (projects)'],
      [3, 'p.repo_path (projects)'],
      [4, 'projects.repo_path'],
    ]);
  });

  it('finds an interpolated alias of the table in SQL', () => {
    const found = reads(
      "const pp = alias(projects, 'pp');\n" + 'sql`SELECT ${pp}.repo_path FROM ${pp}`;\n',
    );
    expect(found.map((r) => [r.line, r.how])).toEqual([[2, 'projects.repo_path']]);
  });

  it('finds a whole row read through a join, a delete, or a relation that targets projects', () => {
    const found = reads(
      'await db.select().from(runners).innerJoin(projects, eq(projects.id, runners.projectId));\n' +
        'await db.delete(projects).where(eq(projects.id, id)).returning();\n' +
        'await db.query.jobs.findFirst({ with: { project: true } });\n' +
        'await db.query.jobs.findMany({ with: { project: { columns: { repoPath: true } } } });\n',
      new Set(['project']),
    );
    expect(found.map((r) => [r.line, r.how])).toEqual([
      [1, 'a whole row of projects'],
      [2, 'a whole row of projects'],
      [3, 'a whole row of projects (relation project)'],
      [4, 'a whole row of projects (relation project)'],
    ]);
  });

  it('passes a relation or relational read whose columns leave the path out', () => {
    expect(
      reads(
        'await db.query.jobs.findFirst({ with: { project: { columns: { id: true, slug: true } } } });\n' +
          'await db.query.jobs.findFirst({ with: { project: { columns: { repoPath: false } } } });\n' +
          'await db.query.projects.findFirst({ columns: { id: true } });\n' +
          'await db.query.jobs.findFirst({ with: { issue: true } });\n',
        new Set(['project']),
      ),
    ).toEqual([]);
  });

  it('passes a local variable that only shares the name, and a table that is not projects', () => {
    expect(
      reads(
        'function f(projects: Array<{ repoPath: string }>) { return projects[0].repoPath; }\n' +
          'const rows = await listProjects(); const projects = rows; projects.repoPath;\n' +
          "import { runners as r } from '../db/schema.js';\n" +
          'await db.select({ path: r.repoPath, all: r }).from(r);\n' +
          'sql`SELECT repo_path FROM projects_archive`;\n',
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
