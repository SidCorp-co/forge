import { existsSync, readFileSync } from 'node:fs';

// cm:guard every export resolves to emitted dist — the core image runs Node 22, which cannot load a .ts export, so a src-pointing or unemitted entry crash-loops core at boot instead of failing here (2026-10-05)
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const bad = [];
for (const [entry, target] of Object.entries(pkg.exports)) {
  const paths = typeof target === 'string' ? [target] : Object.values(target);
  for (const path of paths) {
    if (!path.startsWith('./dist/')) bad.push(`${entry} -> ${path}: points outside dist`);
    else if (!existsSync(new URL(`../${path}`, import.meta.url))) bad.push(`${entry} -> ${path}: not emitted`);
  }
}
if (bad.length) {
  console.error(`@forge/contracts exports that do not resolve to emitted dist:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
