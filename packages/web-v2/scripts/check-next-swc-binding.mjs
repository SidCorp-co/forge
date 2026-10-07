#!/usr/bin/env node

/**
 * Refuses, by package name and platform, a web-v2 install that has no native Next.js SWC binding.
 *
 * A missing or corrupt `@next/swc-<platform>` makes Next.js fall back to its wasm SWC, and the
 * build dies much later as "Turbopack is not supported ... native bindings are not available".
 * This runs right after the install in packages/web-v2/Dockerfile so the failure is at install
 * and names the package.
 *
 * It resolves the package the way next/dist/build/swc/index.js does (`@next/swc-${platform}-${arch}
 * [-musl|-gnu]`, resolved from next itself) and then loads the .node file, because a present but
 * unloadable binary is the same failure (release 0.4.0-dev.110: an "Exec format error" on a musl
 * .node file written by two concurrent pnpm installs).
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import process from 'node:process';

const { platform, arch } = process;
const TRIPLES = {
  linux: (libc) => `linux-${arch}-${libc}`,
  win32: () => `win32-${arch}-msvc`,
  darwin: () => `darwin-${arch}`,
};

function libc() {
  if (platform !== 'linux') return null;
  return process.report?.getReport?.().header?.glibcVersionRuntime ? 'gnu' : 'musl';
}

export function checkNextSwcBinding(from = import.meta.url) {
  const triple = TRIPLES[platform]?.(libc());
  if (!triple) {
    return `no @next/swc-* package is known for platform ${platform}/${arch}`;
  }
  const pkg = `@next/swc-${triple}`;
  let nextDir;
  try {
    nextDir = createRequire(from).resolve('next/package.json');
  } catch {
    return `next is not installed, so ${pkg} (needed on ${platform}/${arch}) cannot be checked`;
  }
  const requireFromNext = createRequire(nextDir);
  let file;
  try {
    file = requireFromNext.resolve(`${pkg}/next-swc.${triple}.node`);
  } catch {
    return `${pkg} is not installed for ${platform}/${arch}: pnpm skipped this optional dependency and next would fall back to wasm SWC`;
  }
  // A truncated .node can kill the process (SIGBUS) instead of throwing, so the load runs in a
  // child: a crash and an "Exec format error" both come back as a named refusal here.
  const load = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', file], {
    encoding: 'utf8',
  });
  if (load.status !== 0) {
    const how = load.signal ? `was killed by ${load.signal}` : (load.stderr.split('\n').find((line) => /Error/.test(line)) ?? 'failed');
    return `${pkg} is installed for ${platform}/${arch} but does not load (${how}): its .node file is corrupt or partial`;
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problem = checkNextSwcBinding();
  if (problem) {
    console.error(`check-next-swc-binding: ${problem}`);
    process.exit(1);
  }
  console.log('check-next-swc-binding: native SWC binding resolves and loads');
}
