#!/usr/bin/env node
// `pnpm preview:demo -- --port <port>`: Forge previewing itself on DEMO data (REQ-39, REQ-41 BC-22).
// The runner starts it as a preview's command in a run's worktree (`{port}` filled), and it brings up
// an isolated stack there: a throwaway Postgres, and core migrated, seeded with a small demo project
// and serving the web it builds on `<port>`. Nothing it starts reaches any other database or API.
//
// This file is the bootstrap, the part that must run before any dependency is installed: it dates the
// start budget, installs and builds a checkout that has neither, and hands over to
// packages/core/tests/helpers/demo-stack.ts, which owns the stack and its teardown.
//
// The budget is FORGE_PREVIEW_START_SECONDS, which core sends with the start as the runner's own
// PREVIEW_LIMITS.readyTimeoutSeconds (120s; 120 here only for a manual run): a stage still running when it ends is refused by name
// and the stack is torn down, rather than left for the runner to report that nothing answered.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const startedAt = Date.now();
const { FORGE_PREVIEW_START_SECONDS: given } = process.env;
const seconds = Number(given ?? '120');
if (!Number.isFinite(seconds) || seconds <= 0) {
  console.error(
    `preview:demo refused: FORGE_PREVIEW_START_SECONDS is ${JSON.stringify(given)}, a positive number of seconds is the valid shape`,
  );
  process.exit(2);
}
const deadline = startedAt + seconds * 1000;

const args = process.argv.slice(2).filter((a) => a !== '--');
const at = args.indexOf('--port');
const port = at >= 0 ? Number(args[at + 1]) : Number.NaN;
if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  console.error(
    `preview:demo refused: --port is ${JSON.stringify(args[at + 1])}; the preview command is \`pnpm preview:demo -- --port {port}\`, with the port the runner picked (1024-65535)`,
  );
  process.exit(2);
}

/** Runs `cmd` in `cwd` until it exits or the start budget ends; the stage is named in the refusal. */
function stage(name, cmd, cmdArgs, cwd) {
  return new Promise((resolve) => {
    console.log(`[preview-demo] ${name}: ${cmd} ${cmdArgs.join(' ')}`);
    const child = spawn(cmd, cmdArgs, { cwd, stdio: 'inherit' });
    const left = deadline - Date.now();
    const timer = setTimeout(
      () => {
        child.kill('SIGKILL');
        console.error(
          `preview:demo refused: stage "${name}" was still running ${seconds}s after the start (FORGE_PREVIEW_START_SECONDS, the runner's PREVIEW_LIMITS.readyTimeoutSeconds); this checkout's ${name} is the thing to speed up`,
        );
        process.exit(3);
      },
      Math.max(left, 1),
    );
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      console.error(`preview:demo refused: stage "${name}" exited ${code ?? signal}`);
      process.exit(4);
    });
  });
}

if (!existsSync(join(root, 'node_modules', '.bin', 'tsx'))) {
  await stage('install', 'pnpm', ['install', '--frozen-lockfile'], root);
}
if (!existsSync(join(root, 'packages', 'contracts', 'dist'))) {
  await stage(
    'build',
    join(root, 'node_modules', '.bin', 'turbo'),
    ['run', 'build', '--filter=@forge/core^...', '--output-logs=errors-only'],
    root,
  );
}

// the stack: one child in this group, so a signal to the group (the runner's stop) reaches it too
// node with tsx as its loader, never the `tsx` command: that wrapper exits on SIGTERM while the
// process it relayed the signal to is still tearing the stack down, which hands the runner a leader
// that is gone and a group to kill half way through
const stack = spawn(
  process.execPath,
  ['--import', 'tsx', join('tests', 'helpers', 'demo-stack.ts'), '--port', String(port)],
  {
    cwd: join(root, 'packages', 'core'),
    stdio: 'inherit',
    env: { ...process.env, FORGE_PREVIEW_DEADLINE: String(deadline) },
  },
);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => stack?.kill(signal));
}
stack?.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
