#!/usr/bin/env node
globalThis.__archmapEntry = true;
let main;
try {
  ({ main } = await import('./src/cli.mjs'));
  if (typeof main !== 'function') throw new Error('src/cli.mjs exports no main()');
} catch (e) {
  process.stderr.write(`archmap: this vendored copy could not load: ${e.message}\n`);
  process.stderr.write('archmap: it is incomplete or corrupt, so the gate did NOT run.\n');
  process.stderr.write('archmap: it cannot repair itself. From an archmap SOURCE checkout, run in\n');
  process.stderr.write('archmap: this repo:  node <archmap-checkout>/bin/archmap install --force\n');
  process.exit(2);
}

process.exitCode = main(process.argv);
globalThis.__archmapRan = true;
