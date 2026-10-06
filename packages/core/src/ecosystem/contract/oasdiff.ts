import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { downloadReleaseAsset, releaseDownloadUrl } from '../../integrations/github/index.js';

const run = promisify(execFile);

export const OASDIFF_VERSION = '1.32.1';

const OASDIFF_RELEASES: Readonly<Record<string, string>> = {
  'linux-x64': '7c8939fc49b75ee11fec66a5b83b37a2fca6aee109fed85013b1ba2ac2a1ee7f',
  'linux-arm64': '32fff58a120f75a723d6c2422444691c37fa6813fed61d23f53dbcb604b30f6d',
  'darwin-x64': 'e4d74b7e2dfb9d4819e7fc720c905ec86547e4637ac270a2b0187c0f1fb7187e',
  'darwin-arm64': 'e4d74b7e2dfb9d4819e7fc720c905ec86547e4637ac270a2b0187c0f1fb7187e',
};

const IMAGE_OASDIFF = '/usr/local/bin/oasdiff';

function asset(platform: string): { name: string; sha256: string } {
  const sha256 = OASDIFF_RELEASES[platform];
  if (!sha256) {
    throw new Error(
      `oasdiff ${OASDIFF_VERSION} has no pinned release for ${platform}; pinned: ${Object.keys(OASDIFF_RELEASES).join(', ')}.`,
    );
  }
  const [os, arch] = platform.split('-');
  const goArch = arch === 'x64' ? 'amd64' : 'arm64';
  const name =
    os === 'darwin'
      ? `oasdiff_${OASDIFF_VERSION}_darwin_all.tar.gz`
      : `oasdiff_${OASDIFF_VERSION}_${os}_${goArch}.tar.gz`;
  return { name, sha256 };
}

function oasdiffPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OASDIFF_BIN && env.OASDIFF_BIN.length > 0 ? env.OASDIFF_BIN : IMAGE_OASDIFF;
}

const verified = new Map<string, Promise<string>>();

// a binary of another version measures with other checks, so a land is refused rather than measured by a differ nobody pinned
async function verify(bin: string): Promise<string> {
  if (!existsSync(bin)) {
    throw new Error(
      `oasdiff is not at ${bin}; the core image installs ${OASDIFF_VERSION} there, and anywhere else OASDIFF_BIN names it (fetch it with \`pnpm --filter @forge/core oasdiff:fetch\`).`,
    );
  }
  const { stdout } = await run(bin, ['--version'], { timeout: 10_000 });
  if (!stdout.includes(`version ${OASDIFF_VERSION}`)) {
    throw new Error(
      `${bin} reports "${stdout.trim()}", and core is pinned to oasdiff ${OASDIFF_VERSION}.`,
    );
  }
  return bin;
}

export function requireOasdiff(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const bin = oasdiffPath(env);
  const hit = verified.get(bin);
  if (hit) return hit;
  const pending = verify(bin);
  verified.set(bin, pending);
  pending.catch(() => verified.delete(bin));
  return pending;
}

export async function fetchOasdiff(
  dir: string,
  platform = `${process.platform}-${process.arch}`,
): Promise<string> {
  const { name, sha256 } = asset(platform);
  const target = join(dir, 'oasdiff');
  if (existsSync(target)) return verify(target);
  const url = releaseDownloadUrl('oasdiff/oasdiff', `v${OASDIFF_VERSION}`, name);
  const download = await downloadReleaseAsset(url, { timeoutMs: 120_000 });
  if (!download.ok) throw new Error(`GET ${url} answered HTTP ${download.status}`);
  const bytes = download.bytes;
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha256) {
    throw new Error(`${name} hashes ${got}; the pin is ${sha256}.`);
  }
  const work = await mkdtemp(join(tmpdir(), 'oasdiff-'));
  try {
    await writeFile(join(work, name), bytes);
    await run('tar', ['-xzf', join(work, name), '-C', work, 'oasdiff']);
    await mkdir(dir, { recursive: true });
    await chmod(join(work, 'oasdiff'), 0o755);
    await rename(join(work, 'oasdiff'), target);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return verify(target);
}

export interface OasdiffEntry {
  id: string;
  text: string;
  level: number;
  operation?: string;
  path?: string;
  section?: string;
}

const MAX_OUTPUT = 64 * 1024 * 1024;

// the specs are another project's bytes, so external $refs are never followed: a ref to a URL would be a request core makes on the provider's say-so
const SAFE = ['--allow-external-refs=false', '-f', 'json'];

// execFile's own message leads with the command line and the temporary paths; what a reader needs is oasdiff's stderr, with each file named for its role
function oasdiffFailure(err: unknown, files: Readonly<Record<string, string>>): Error {
  const e = err as { stderr?: unknown; message?: unknown };
  let text = typeof e.stderr === 'string' && e.stderr.trim() ? e.stderr : String(e.message ?? err);
  for (const [path, role] of Object.entries(files))
    text = text.split(`"${path}"`).join(role).split(path).join(role);
  // oasdiff tries JSON and then YAML; on a JSON artifact the YAML attempt repeats the JSON error
  if (text.includes('json error:')) text = text.replace(/, yaml error: [\s\S]*$/, '');
  return new Error(text.replace(/^Error:\s*/, '').trim());
}

export async function runOasdiff(
  base: string,
  revision: string,
): Promise<{ changelog: OasdiffEntry[]; structural: unknown }> {
  const bin = await requireOasdiff();
  const work = await mkdtemp(join(tmpdir(), 'oasdiff-run-'));
  try {
    const [a, b] = [join(work, 'base.json'), join(work, 'revision.json')];
    await writeFile(a, base);
    await writeFile(b, revision);
    const opts = { timeout: 120_000, maxBuffer: MAX_OUTPUT };
    const [log, diff] = await Promise.all([
      run(bin, ['changelog', a, b, ...SAFE], opts),
      run(bin, ['diff', a, b, ...SAFE], opts),
    ]).catch((err: unknown) => {
      throw oasdiffFailure(err, { [a]: 'the previous version', [b]: 'this version' });
    });
    const changelog = JSON.parse(log.stdout || '[]') as OasdiffEntry[];
    if (!Array.isArray(changelog)) throw new Error('oasdiff changelog printed no JSON array');
    return { changelog, structural: JSON.parse(diff.stdout || '{}') };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// a spec diffed against itself goes through the loader changelog uses, so an artifact that passes here is one a later version can be measured against; the answer is oasdiff's own words, null when it loads, and a differ that was killed or never ran is thrown rather than blamed on the artifact
export async function oasdiffLoadError(text: string): Promise<string | null> {
  const bin = await requireOasdiff();
  const work = await mkdtemp(join(tmpdir(), 'oasdiff-load-'));
  const file = join(work, 'artifact.json');
  try {
    await writeFile(file, text);
    try {
      await run(bin, ['diff', file, file, ...SAFE], { timeout: 120_000, maxBuffer: MAX_OUTPUT });
      return null;
    } catch (err) {
      const failure = oasdiffFailure(err, { [file]: 'the artifact' });
      if (typeof (err as { code?: unknown }).code !== 'number') throw failure;
      return failure.message;
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
