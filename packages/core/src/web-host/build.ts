import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  readWebHostManifest,
  WEB_HOST_MANIFEST,
  type WebHostManifest,
} from '@forge/contracts/web-host';

/** The web build core serves: its directory, the path it was built to be served under, its page and manifest. */
export interface WebBuild {
  dir: string;
  basePath: string;
  indexHtml: string;
  manifest: WebHostManifest;
  /** Every other file of the build, by its path under the base path (`/assets/index-3b_mgYcl.js`). */
  files: ReadonlySet<string>;
}

const BUILD_IT = 'build the web (`pnpm --filter web-v2 build`) or unset WEB_DIST_DIR';

/** Reads the build at boot, so a core told to serve a web it cannot find never starts. */
export function loadWebBuild(dir: string): WebBuild {
  const root = resolve(dir);
  const index = join(root, 'index.html');
  if (!existsSync(index)) throw new Error(`WEB_DIST_DIR=${root} holds no index.html: ${BUILD_IT}`);
  const at = join(root, WEB_HOST_MANIFEST);
  if (!existsSync(at))
    throw new Error(`WEB_DIST_DIR=${root} holds no ${WEB_HOST_MANIFEST}: ${BUILD_IT}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(at, 'utf8'));
  } catch (err) {
    throw new Error(`${at} is not JSON (${(err as Error).message}): ${BUILD_IT}`);
  }
  const manifest = readWebHostManifest(parsed);
  if ('refused' in manifest) throw new Error(`${at} is refused, ${manifest.refused}: ${BUILD_IT}`);
  const files = new Set(
    filesUnder(root)
      .map((f) => `/${relative(root, f).split(sep).join('/')}`)
      .filter((f) => f !== '/index.html' && f !== `/${WEB_HOST_MANIFEST}`),
  );
  return {
    dir: root,
    basePath: manifest.basePath,
    indexHtml: readFileSync(index, 'utf8'),
    manifest,
    files,
  };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  });
}
