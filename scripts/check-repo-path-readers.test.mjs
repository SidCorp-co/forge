import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ANSWERED_AS_REPO_PATH, check, DECLARED, namesIn } from './check-repo-path-readers.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

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

// ISS-1236 r6, judge-140: launched through a symlinked checkout, or from one whose real path holds a
// space, the checker exited 0 printing nothing while a planted reader stood.
describe('check-repo-path-readers — launched from wherever the checkout is', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'repo-path-readers-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const tree = join(scratch, 'a checkout');
  const put = (rel, text) => {
    mkdirSync(dirname(join(tree, rel)), { recursive: true });
    writeFileSync(join(tree, rel), text);
  };
  for (const rel of ['check-repo-path-readers.mjs', 'lib/entrypoint.mjs']) {
    mkdirSync(dirname(join(tree, 'scripts', rel)), { recursive: true });
    copyFileSync(join(SCRIPTS, rel), join(tree, 'scripts', rel));
  }
  put('packages/core/src/lib/device-pool.ts', 'export const readDeviceBinding = () => null;\n');
  for (const rel of DECLARED.keys()) put(rel, '// repo_path_hint\n');
  symlinkSync(tree, join(scratch, 'linked'));
  const PLANT = 'packages/core/src/planted.ts';
  const run = (base) =>
    spawnSync(process.execPath, [join(base, 'scripts', 'check-repo-path-readers.mjs'), '--all'], {
      cwd: scratch,
      encoding: 'utf8',
    });

  for (const [how, base] of [
    ['through a symlinked checkout', join(scratch, 'linked')],
    ['from a real path holding a space', tree],
  ]) {
    it(`goes red naming a planted reader, ${how}, and green without it`, () => {
      put(PLANT, 'export const sql = "SELECT repo_path_hint FROM projects";\n');
      const red = run(base);
      expect(red.status).toBe(1);
      expect(red.stderr).toContain(`${PLANT}:1`);
      rmSync(join(tree, PLANT));
      const green = run(base);
      expect(green.status).toBe(0);
      expect(green.stdout).toMatch(/repo-path-readers: \d+ file\(s\) scanned/);
    });
  }
});

// ISS-1236 r6, judge-140: a read of the hint under the API's name, off a declared reader's answer,
// is invisible to a name search, and the README row did not say so.
describe('check-repo-path-readers — what it cannot see is said', () => {
  const row = readFileSync(join(SCRIPTS, 'README.md'), 'utf8')
    .split('\n')
    .find((line) => line.startsWith('| repo-path readers |'));

  it('names, in its README row, a read of `.repoPath` off an answer that carries the hint', () => {
    expect(row).toContain('a read of `.repoPath` off an answer that carries the hint');
    expect(row).toContain('ANSWERED_AS_REPO_PATH');
  });

  it('names every declared reader whose answer carries the hint as `repoPath`', () => {
    expect(ANSWERED_AS_REPO_PATH.length).toBeGreaterThan(0);
    for (const rel of ANSWERED_AS_REPO_PATH) {
      expect(DECLARED.has(rel), rel).toBe(true);
      expect(row, rel).toContain(`\`${rel}\``);
    }
  });

  it('declares forge-config.ts, which answers it as `config.repoPath`', () => {
    expect(DECLARED.get('packages/core/src/mcp/tools/forge-config.ts')).toMatch(/config\.repoPath/);
  });
});
