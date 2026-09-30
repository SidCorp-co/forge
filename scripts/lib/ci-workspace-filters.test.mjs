// A job ci.yml gates on a `changes` output must be selected by a change to any workspace package
// the packages it tests depend on, or that change skips it and a skipped job passes `ci-passed`.
// `@forge/observability` matched no filter until ISS-1364. The tested packages are read off each
// job's own `pnpm --filter` steps, so a job that starts testing another package is held to its
// dependencies without an edit here. A new workspace package or a new workspace import changes
// `pnpm-lock.yaml`, which selects `core`, the job that collects this file.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'ci.yml');

/** Each `changes` filter's entries, off the `filters: |` block of the paths-filter step. */
export function filtersOf(yaml) {
  const lines = yaml.split('\n');
  const at = lines.findIndex((l) => /^\s+filters: \|\s*$/.test(l));
  if (at === -1) throw new Error(`no \`filters: |\` block in ${WORKFLOW}`);
  const indent = lines[at].search(/\S/);
  const filters = {};
  let current = null;
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (line.search(/\S/) <= indent) break;
    const name = line.match(/^\s+([\w-]+):\s*$/);
    const entry = line.match(/^\s+- '([^']+)'\s*$/);
    if (name) filters[(current = name[1])] = [];
    else if (entry && current) filters[current].push(entry[1]);
    else throw new Error(`filters block line is neither a filter name nor a quoted entry: ${line}`);
  }
  return filters;
}

/** Every job gated on a `changes` output other than `proved`, with the packages it runs. */
export function filteredJobs(yaml) {
  const jobs = {};
  let job = null;
  for (const line of yaml.split('\n')) {
    const head = line.match(/^ {2}([\w-]+):\s*$/);
    if (head) {
      job = jobs[head[1]] = { outputs: [], packages: [] };
      continue;
    }
    if (!job || line.trim().startsWith('#')) continue;
    const gate = line.match(/^ {4}if: (.*)$/);
    if (gate) {
      for (const [, out] of gate[1].matchAll(/needs\.changes\.outputs\.([\w-]+)/g)) {
        if (out !== 'proved') job.outputs.push(out);
      }
    }
    for (const [, pkg] of line.matchAll(/pnpm --filter (\S+)/g)) job.packages.push(pkg);
  }
  return Object.fromEntries(Object.entries(jobs).filter(([, j]) => j.outputs.length > 0));
}

/** The workspace's packages by name, each with its directory and its workspace dependencies. */
export function workspacePackages(root) {
  const byName = {};
  for (const dir of readdirSync(join(root, 'packages'))) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    const deps = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    };
    const local = Object.entries(deps)
      .filter(([, spec]) => String(spec).startsWith('workspace:'))
      .map(([name]) => name);
    byName[manifest.name] = { dir, deps: local };
  }
  return byName;
}

/** Each tested package and every workspace package it reaches, the tested ones included. */
function reach(names, packages) {
  const seen = new Set();
  const stack = [...names];
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    const pkg = packages[name];
    if (!pkg) throw new Error(`\`pnpm --filter ${name}\` names no workspace package`);
    seen.add(name);
    stack.push(...pkg.deps);
  }
  return [...seen];
}

/** One line per job and package a change to that package would skip. */
export function unselected(yaml, packages) {
  const filters = filtersOf(yaml);
  const missing = [];
  for (const [name, job] of Object.entries(filteredJobs(yaml))) {
    for (const pkg of reach(job.packages, packages)) {
      const glob = `packages/${packages[pkg].dir}/**`;
      if (job.outputs.some((out) => (filters[out] ?? []).includes(glob))) continue;
      missing.push(
        `job \`${name}\` tests a package depending on ${pkg}, and none of its filters (${job.outputs.join(', ')}) lists '${glob}'`,
      );
    }
  }
  return missing;
}

describe('ci.yml changes filters cover the workspace graph', () => {
  const yaml = readFileSync(WORKFLOW, 'utf8');
  const packages = workspacePackages(ROOT);

  it('reads the jobs this rule is about, so a parse that found nothing cannot pass', () => {
    const jobs = filteredJobs(yaml);
    expect(jobs.web.packages).toContain('web-v2');
    expect(jobs.core.packages).toContain('@forge/core');
    expect(jobs['core-integration'].outputs).toEqual(['core']);
    expect(filtersOf(yaml).web).toContain('packages/web-v2/**');
    expect(packages['@forge/core'].deps).toContain('@forge/observability');
  });

  it('selects every job for a change to any workspace package its tested packages depend on', () => {
    expect(unselected(yaml, packages)).toEqual([]);
  });

  it('names the job and the package when a dependency drops out of a filter', () => {
    const planted = yaml.replace(
      /(\n\s+core:\n(?:\s+- '[^']+'\n)*?)\s+- 'packages\/observability\/\*\*'\n/,
      '$1',
    );
    expect(planted).not.toBe(yaml);
    const missing = unselected(planted, packages);
    expect(missing).toContain(
      "job `core` tests a package depending on @forge/observability, and none of its filters (core, scripts) lists 'packages/observability/**'",
    );
    expect(missing).toContain(
      "job `core-integration` tests a package depending on @forge/observability, and none of its filters (core) lists 'packages/observability/**'",
    );
  });

  it('refuses a filter line it cannot read rather than skipping it', () => {
    const broken = yaml.replace("- 'packages/web-v2/**'", '- packages/web-v2/**');
    expect(() => filtersOf(broken)).toThrow(/neither a filter name nor a quoted entry/);
  });
});
