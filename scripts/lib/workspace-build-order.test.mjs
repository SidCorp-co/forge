// @gate-input whole-tree — its input is every workspace manifest, and it runs pnpm and turbo over the workspace
// @direct-test-of packages/contracts/package.json
// @direct-test-of packages/core/package.json
// @direct-test-of packages/observability/package.json
// @direct-test-of packages/web-v2/package.json
// @direct-test-of turbo.json
// @direct-test-of packages/core/Dockerfile
// @direct-test-of .github/actions/setup-workspace/action.yml
//
// The workspace builds in the order its manifests declare, and nowhere else orders it (ISS-137).
// `@forge/contracts` once declared `@forge/core` while core declared contracts: neither pnpm nor
// turbo could order the two, so `pnpm --filter "@forge/core..." build` started both at once, and
// the Dockerfile, the setup-workspace action and a turbo.json pin each imposed the order by hand.
// Contracts reads core for types only, through tsconfig `paths`, as web-v2 does.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function manifests() {
  const out = new Map();
  for (const dir of readdirSync(join(ROOT, 'packages'))) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf8'));
    } catch (e) {
      if (e?.code === 'ENOENT') continue;
      throw e;
    }
    out.set(pkg.name, pkg);
  }
  return out;
}

/** Each workspace package's workspace dependencies, over every dependency field pnpm and turbo read. */
function workspaceGraph() {
  const pkgs = manifests();
  const graph = new Map();
  for (const [name, pkg] of pkgs) {
    const deps = new Set();
    for (const field of DEP_FIELDS) {
      for (const dep of Object.keys(pkg[field] ?? {})) if (pkgs.has(dep)) deps.add(dep);
    }
    graph.set(name, deps);
  }
  return graph;
}

/** Every cycle the graph holds, each written `a -> b -> a`. */
function cycles(graph) {
  const found = [];
  const walk = (start, at, path) => {
    for (const next of graph.get(at) ?? []) {
      if (next === start) found.push([...path, start].join(' -> '));
      else if (!path.includes(next) && next > start) walk(start, next, [...path, next]);
    }
  };
  for (const name of [...graph.keys()].sort()) walk(name, name, [name]);
  return found;
}

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env, NO_COLOR: '1', TURBO_TELEMETRY_DISABLED: '1' },
  });
  if (r.error) throw r.error;
  return r;
}

describe('the workspace build order is declared, never imposed by hand', () => {
  it('no workspace package declares, in any dependency field, a package that leads back to it', () => {
    const graph = workspaceGraph();
    expect(graph.get('@forge/contracts')).toBeDefined();
    expect([...graph.get('@forge/contracts')]).not.toContain('@forge/core');
    expect(cycles(graph)).toEqual([]);
  });

  it('a recursive run over core and its dependencies finishes contracts before core starts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'build-order-'));
    try {
      const log = join(dir, 'log.jsonl');
      const step =
        "const fs=require('node:fs');const n=require('./package.json').name;const s=Date.now();" +
        'setTimeout(()=>fs.appendFileSync(process.env.ORDER_LOG,JSON.stringify({n,s,e:Date.now()})+"\\n"),400)';
      const r = run(
        'pnpm',
        ['--filter', '@forge/core...', '--workspace-concurrency=4', 'exec', 'node', '-e', step],
        { ORDER_LOG: log },
      );
      expect(r.status, r.stderr).toBe(0);
      const ran = Object.fromEntries(
        readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
          .map((x) => [x.n, x]),
      );
      expect(Object.keys(ran).sort()).toEqual([
        '@forge/contracts',
        '@forge/core',
        '@forge/observability',
      ]);
      expect(ran['@forge/contracts'].e).toBeLessThanOrEqual(ran['@forge/core'].s);
      expect(ran['@forge/observability'].e).toBeLessThanOrEqual(ran['@forge/core'].s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('turbo orders core after contracts from the manifests alone, and reports no cycle', () => {
    const turbo = JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8'));
    expect(Object.keys(turbo.tasks).filter((t) => t.startsWith('@forge/'))).toEqual([]);
    const r = run('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@forge/core', '--dry=json']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/circular/i);
    const core = JSON.parse(r.stdout).tasks.find((t) => t.taskId === '@forge/core#build');
    expect(core.dependencies).toContain('@forge/contracts#build');
  });

  it.each([['packages/core/Dockerfile'], ['.github/actions/setup-workspace/action.yml']])(
    '%s builds no single workspace package ahead of another by hand',
    (file) => {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const handBuilt = text
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .filter((l) => /pnpm --filter @forge\/(contracts|observability) (run )?build/.test(l));
      expect(handBuilt).toEqual([]);
    },
  );
});
