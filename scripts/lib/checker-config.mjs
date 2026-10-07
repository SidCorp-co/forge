import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function manifestPath(root) {
  return join(root, '.forge', 'conformance.json');
}

/** @returns `{manifest}` — `{}` for an absent file when `required` is false — or `{error}` */
export function readManifest(root, { required = true } = {}) {
  const path = manifestPath(root);
  if (!required && !existsSync(path)) return { manifest: {} };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return { error: `${path} could not be read: ${err.code ?? err.message}` };
  }
  try {
    return { manifest: JSON.parse(raw) };
  } catch (err) {
    return { error: `${path} is not valid JSON: ${err.message}` };
  }
}

/** A checker's block of the manifest laid over its defaults; an unreadable manifest is `die`d on. */
export function checkerConfig(root, name, defaults, die) {
  const { manifest, error } = readManifest(root, { required: false });
  if (error) die(error);
  return { ...defaults, ...(manifest.checkers?.[name] ?? {}) };
}

/** The `scopes` array a biome checker registers against, fail-closed on every way it can be absent. */
export function scopeConfig(root, key) {
  const { manifest, error } = readManifest(root);
  if (error) return { error };
  const scopes = manifest?.checkers?.[key]?.scopes;
  const path = manifestPath(root);
  if (!Array.isArray(scopes)) {
    return { error: `${path} declares no checkers['${key}'].scopes array` };
  }
  if (scopes.length === 0) {
    return { error: `${path} declares an empty ${key} scope list — nothing would be measured` };
  }
  return { scopes };
}

/** A checker's block merged over its built-in defaults, per the manifest's degrade-to-defaults contract. */
export function tunedConfig(root, key, defaults) {
  const { manifest, error } = readManifest(root, { required: false });
  if (error) return { error };
  return { config: { ...defaults, ...(manifest?.checkers?.[key] ?? {}) } };
}

/** @returns `{mode}` for a recognised mode, `{error}` otherwise — the caller exits 2. */
export function parseMode(argv, allowed, script) {
  const mode = argv[2] ?? '--all';
  if (!allowed.includes(mode)) return { error: `usage: ${script} [${allowed.join('|')}]` };
  return { mode };
}

/** @returns `{files: Set<string>}` of repo-relative staged paths, or `{error}` */
export function stagedFiles(root) {
  const staged = gitPaths(root, ['diff', '--cached', '--name-only', '--diff-filter=ACM']);
  if (staged === null) return { error: 'git diff --cached failed — cannot tell what is staged' };
  return { files: new Set(staged) };
}

/** Paths git lists with `-z`: NUL-separated and unquoted, so a non-ASCII name reads as the tree holds it. */
function gitPaths(root, args) {
  try {
    return execFileSync('git', [...args, '-z'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\0')
      .filter(Boolean);
  } catch {
    return null;
  }
}
