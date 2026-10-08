// The audit's reading of a program a traced run started: git is held to its own policy, a Node
// tool is inside the trace, and anything native is outside it unless the declaration names it.

import { basename } from 'node:path';
import { gitFault } from './verify-memo-git.mjs';

const TRACED = new Set([
  'node',
  'nodejs',
  'pnpm',
  'npm',
  'npx',
  'corepack',
  'tsx',
  'tsc',
  'vitest',
  'archmap',
  'eslint',
]);
const SHELLS = new Set(['sh', 'bash', 'dash']);
/** Native programs that only transform what Node hands them, or read the machine and not the checkout. */
const FED = new Set(['esbuild', 'ldd']);
const SEGMENTS = /\s*(?:&&|\|\||[;|&\n])\s*/;

const firstWord = (text) =>
  basename((text.trim().split(/\s+/)[0] ?? '').replace(/^['"]|['"]$/g, ''));

/** Every program a started command runs: a shell's command string is split into its commands. */
export function programsOf(argv) {
  const [cmd, ...rest] = argv;
  const shell = SHELLS.has(basename(cmd));
  if (shell && rest[0] !== '-c') return [`${basename(cmd)} script`];
  const text = shell ? (rest[1] ?? '') : argv.length === 1 && /\s/.test(cmd) ? cmd : null;
  if (text === null) return [basename(cmd)];
  if (/`|\$\(|</.test(text))
    return [`${text.slice(0, 40)} (a substitution or an input redirection)`];
  return text.split(SEGMENTS).filter(Boolean).map(firstWord);
}

/** Why a program a traced run started is not covered by `decl`, or null where it is. */
export function spawnFault(argv, decl, state) {
  const direct = basename(argv[0]) === 'git';
  const programs = programsOf(argv);
  if (direct) return gitFault(argv, decl, state);
  const unseen = programs.find(
    (p) => !(TRACED.has(p) || FED.has(p) || (decl.blind ?? []).includes(p)),
  );
  if (!unseen) return null;
  return `ran \`${unseen}\`, native code whose reads the trace cannot see (name it in \`blind\`)`;
}
