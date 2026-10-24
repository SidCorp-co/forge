// The workspace packages a test collection loads from their dist builds, rebuilt before any test of
// the collection runs (ISS-587, REQ-74 BC-5). `@forge/contracts` exports only `./dist/*.js` and
// `@forge/observability` only `./dist/index.js`, and core's vitest configs alias neither to source, so
// a core test loads whatever was last built. A checkout rebased onto a base that changed either holds
// a dist older than its source, and a test of an unrelated change then fails ERR_MODULE_NOT_FOUND (or
// on a registry that no longer matches) for a reason the change never touched. Each collection
// declares what it loads (`direct-tests.mjs:VITEST_COLLECTIONS` `builds`); this rebuilds each one
// and holds its dist to its source, and where it cannot it refuses PACKAGE_BUILD_STALE before a
// single test starts. It never rebuilds on a guess and never runs the tests against the old build.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A source module the build emits: TypeScript under src/, never a declaration or a test file. */
const EMITTED = /^(?!.*\.d\.ts$)(?!.*\.test\.tsx?$).+\.(m?)tsx?$/;

/** The file paths under the directory `abs`, relative to it, sorted. */
function filesUnder(abs, rel = '') {
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(join(abs, entry.name), path));
    else out.push(path);
  }
  return out.sort();
}

/**
 * Where the package's dist does not match its source: the first source module under `<dir>/src`
 * whose emitted `.js` under `<dir>/dist` is missing or older than it, as a sentence naming both
 * repo-relative paths; null where every one is emitted and none is older.
 */
export function buildMismatch(root, dir) {
  const src = join(root, dir, 'src');
  if (!existsSync(src)) return `${dir}/src does not exist, so no build of it can be held to it`;
  for (const rel of filesUnder(src)) {
    const m = EMITTED.exec(rel);
    if (!m) continue;
    const out = rel.replace(/\.(m?)tsx?$/, `.${m[1]}js`);
    const emitted = join(root, dir, 'dist', out);
    if (!existsSync(emitted)) return `${dir}/dist/${out} is missing for ${dir}/src/${rel}`;
    if (statSync(emitted).mtimeMs < statSync(join(src, rel)).mtimeMs)
      return `${dir}/dist/${out} is older than ${dir}/src/${rel}`;
  }
  return null;
}

/** Each workspace package's directory by its name, read from `packages/<dir>/package.json`. */
function packageDirs(root) {
  const dirs = new Map();
  const base = join(root, 'packages');
  if (!existsSync(base)) return dirs;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(base, entry.name, 'package.json');
    if (!existsSync(manifest)) continue;
    const name = JSON.parse(readFileSync(manifest, 'utf8')).name;
    if (name) dirs.set(name, `packages/${entry.name}`);
  }
  return dirs;
}

/**
 * The builds the collections about to run owe, in the order first declared: each package once, with
 * the collections that load it.
 */
export function buildsOwed(collections) {
  const owed = new Map();
  for (const c of collections) {
    for (const name of c.builds ?? []) {
      if (!owed.has(name)) owed.set(name, { name, loadedBy: [] });
      owed.get(name).loadedBy.push(c.name);
    }
  }
  return [...owed.values()];
}

/** The last lines a failed build printed, for the refusal to carry. */
const tailOf = (r) =>
  `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error}` : ''}`
    .trim()
    .split('\n')
    .slice(-12)
    .map((l) => `    ${l}`)
    .join('\n');

/**
 * Rebuild each owed package with its own build script (`pnpm --filter <name> run build`), then hold
 * its dist to its source. Answers the builds made, or the refusal naming the first package that could
 * not be brought to its source: its dist, what does not match, the collections that load it, the
 * command and how it ended. `exec` runs one command as `direct-test-run.mjs:run` does.
 */
export function rebuildPackages(root, owed, { exec }) {
  const dirs = packageDirs(root);
  const built = [];
  for (const { name, loadedBy } of owed) {
    const loaders = loadedBy.join(', ');
    const dir = dirs.get(name);
    if (!dir) {
      return {
        built,
        refusal: `PACKAGE_BUILD_STALE: the tests of ${loaders} load ${name} from its build, and no package under packages/ is named ${name}; a collection's \`builds\` in scripts/lib/direct-tests.mjs names a package the checkout does not hold`,
      };
    }
    const before = buildMismatch(root, dir);
    const command = `pnpm --filter ${name} run build`;
    const r = exec(['pnpm', '--filter', name, 'run', 'build'], root, { capture: true });
    const after = r.ok ? buildMismatch(root, dir) : before;
    if (!r.ok || after) {
      const ended = `\`${command}\` exited ${r.status ?? r.error ?? 'without a status'}`;
      const why = r.ok
        ? `\`${command}\` exited 0 and its dist still does not match its source: ${after}`
        : before
          ? `its dist does not match its source (${before}), and ${ended}`
          : `${ended}, so no build of this source can be vouched for`;
      return {
        built,
        refusal:
          `PACKAGE_BUILD_STALE: the tests of ${loaders} load ${name} from ${dir}/dist; ${why}. ` +
          `No test ran: they would have run against a build that is not this source. Run \`${command}\` to see why it fails, fix it, and run again.` +
          (r.ok ? '' : `\n  what the build printed last:\n${tailOf(r)}`),
      };
    }
    built.push({ name, dir, was: before, durationMs: r.durationMs });
  }
  return { built, refusal: null };
}

/** The line a run prints for each build it made. */
export function describeBuilds(built) {
  return built.map(
    (b) =>
      `  built  ${b.name.padEnd(22)} ${(b.durationMs / 1000).toFixed(1).padStart(6)}s  ${b.was ? `its dist was stale: ${b.was}` : 'its dist already matched its source'}`,
  );
}
