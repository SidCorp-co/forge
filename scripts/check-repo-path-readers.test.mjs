import { describe, expect, it } from 'vitest';
import { check, DECLARED, namesIn } from './check-repo-path-readers.mjs';

// The fixtures are FIXTURE TEXT — source this checker searches, not source this file runs.
const OUTSIDE = 'packages/core/src/fixture.ts';
const refused = (source) => check(new Map([[OUTSIDE, source]])).reads;

describe('check-repo-path-readers — the hint is read only by naming it', () => {
  it('refuses a Drizzle read of repoPathHint outside the declared readers, by file and line', () => {
    const found = refused(
      'import { projects } from "../db/schema.js";\nconst [p] = await db.select({ dir: projects.repoPathHint }).from(projects);\n',
    );
    expect(found).toEqual([
      {
        rel: OUTSIDE,
        line: 2,
        text: 'const [p] = await db.select({ dir: projects.repoPathHint }).from(projects);',
      },
    ]);
  });

  it('refuses raw SQL reading repo_path_hint, through an alias in a comma join', () => {
    const found = refused(
      'const rows = await db.execute(sql`\n  SELECT p.repo_path_hint\n  FROM runners r, projects p\n  WHERE r.project_id = p.id\n`);\n',
    );
    expect(found.map((r) => [r.rel, r.line])).toEqual([[OUTSIDE, 2]]);
  });

  it('refuses the column spelled in capitals or quoted', () => {
    expect(refused('sql`SELECT "REPO_PATH_HINT" FROM PROJECTS`;\n').map((r) => r.line)).toEqual([
      1,
    ]);
  });

  it('refuses a bracket read whose key is held by a variable built from the name', () => {
    const found = refused("const col = 'repoPathHint' as const;\nconst dir = projects[col];\n");
    expect(found.map((r) => r.line)).toEqual([1]);
  });

  it('refuses a field read off a whole row, whichever way the row was fetched', () => {
    const found = refused(
      'const [row] = await db.execute(sql`UPDATE projects SET name = $1 RETURNING *`);\nhand(row.repo_path_hint);\nconst [j] = await db.execute(sql`SELECT to_jsonb(p) AS j FROM projects p`);\nhand(j.j.repo_path_hint);\n',
    );
    expect(found.map((r) => r.line)).toEqual([2, 4]);
  });

  it('refuses a comment naming the hint, since the rule is the name and not its use', () => {
    expect(refused('// projects.repoPathHint is the default\n').map((r) => r.line)).toEqual([1]);
  });

  it("passes runners.repo_path and agent_sessions.repo_path, which are a device's and a session's", () => {
    expect(
      refused(
        'sql`SELECT r.repo_path FROM runners r`;\nconst p = runners.repoPath ?? agentSessions.repoPath;\n',
      ),
    ).toEqual([]);
  });

  it('passes a declared reader naming the hint', () => {
    const rel = 'packages/core/src/projects/projections.ts';
    expect(DECLARED.has(rel)).toBe(true);
    expect(check(new Map([[rel, 'repoPath: projects.repoPathHint,\n']]))).toEqual({
      reads: [],
      stale: [],
    });
  });

  it('refuses a declared reader that no longer names the hint, so the list cannot outlive its reason', () => {
    const rel = 'packages/core/src/projects/health-routes.ts';
    expect(check(new Map([[rel, 'export const nothing = 1;\n']])).stale).toEqual([rel]);
  });

  it('gives every declared reader a reason', () => {
    for (const [rel, reason] of DECLARED) {
      expect(rel.startsWith('packages/core/src/'), rel).toBe(true);
      expect(reason.length, rel).toBeGreaterThan(10);
    }
  });

  it('reports each line once however often it names the hint', () => {
    expect(namesIn(OUTSIDE, 'a.repoPathHint ?? b.repoPathHint\n')).toHaveLength(1);
  });
});
