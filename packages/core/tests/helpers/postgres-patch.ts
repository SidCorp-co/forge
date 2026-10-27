import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** What every hunk of the root patch writes into the driver, so a copy without it can be told apart. */
const MARK = 'forge-core patch';

/** The postgres version the root `package.json` patches, and the patch file it applies. */
export function declaredPatch(root: string = ROOT): { version: string; patch: string } {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    pnpm?: { patchedDependencies?: Record<string, string> };
  };
  const entry = Object.entries(pkg.pnpm?.patchedDependencies ?? {}).find(([name]) =>
    name.startsWith('postgres@'),
  );
  if (!entry) throw new Error(`${join(root, 'package.json')} patches no postgres version`);
  return { version: entry[0].slice('postgres@'.length), patch: join(root, entry[1]) };
}

/** Each file the patch writes, and how many marked lines it adds there. */
export function markedLines(patchText: string): Map<string, number> {
  const files = new Map<string, number>();
  let file: string | null = null;
  for (const line of patchText.split('\n')) {
    const header = /^diff --git a\/(\S+) b\//.exec(line);
    if (header?.[1]) {
      file = header[1];
      files.set(file, 0);
    } else if (file && line.startsWith('+') && line.includes(MARK)) {
      files.set(file, (files.get(file) ?? 0) + 1);
    }
  }
  return files;
}

function isPostgresPackage(dir: string): boolean {
  const file = join(dir, 'package.json');
  return existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === 'postgres';
}

/** The directory of the postgres package this process loads. */
export function loadedPostgres(): string {
  let dir = dirname(createRequire(import.meta.url).resolve('postgres'));
  // A build directory carries a package.json of its own that says only its module type.
  while (!isPostgresPackage(dir)) {
    const up = dirname(dir);
    if (up === dir)
      throw new Error('no directory above the postgres this process loads is its package');
    dir = up;
  }
  return dir;
}

/**
 * Why the postgres at `dir` is not the patched driver the suites are written against, or null when
 * it is. A checkout whose install predates the patch otherwise runs every suite on the old driver,
 * whose failures this repository no longer has, without a word.
 */
export function postgresPatchRefusal(
  dir: string = loadedPostgres(),
  declared: { version: string; patch: string } = declaredPatch(),
): string | null {
  const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    version: string;
  };
  const short: string[] = [];
  if (version !== declared.version) {
    short.push(`it is version ${version}, and ${declared.patch} patches ${declared.version}`);
  } else {
    for (const [file, want] of markedLines(readFileSync(declared.patch, 'utf8'))) {
      const path = join(dir, file);
      const have = existsSync(path) ? readFileSync(path, 'utf8').split(MARK).length - 1 : 0;
      if (have < want) short.push(`${file} carries ${have} of the patch's ${want} marked lines`);
    }
  }
  if (short.length === 0) return null;
  return (
    `The postgres driver this process loads (${dir}) is not the one ${declared.patch} makes: ` +
    `${short.join('; ')}. Run pnpm install at the repository root, which applies the patch, ` +
    'and run again; the suites are written against the patched driver.'
  );
}
