import { existsSync, readdirSync, readFileSync } from 'node:fs';

// every export resolves to emitted dist — the core image runs Node 22, which cannot load a .ts export, so a src-pointing or unemitted entry crash-loops core at boot instead of failing here (2026-10-05)
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// A `*` subpath exports every module under src/, so each one must have been emitted.
const modules = readdirSync(new URL('../src/', import.meta.url))
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
  .map((f) => f.slice(0, -3));
const bad = [];
for (const [entry, target] of Object.entries(pkg.exports)) {
  const paths = typeof target === 'string' ? [target] : Object.values(target);
  for (const path of paths) {
    const resolved = path.includes('*') ? modules.map((m) => path.replace('*', m)) : [path];
    for (const p of resolved) {
      if (!p.startsWith('./dist/')) bad.push(`${entry} -> ${p}: points outside dist`);
      else if (!existsSync(new URL(`../${p}`, import.meta.url))) bad.push(`${entry} -> ${p}: not emitted`);
    }
  }
}
if (bad.length) {
  console.error(`@forge/contracts exports that do not resolve to emitted dist:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
