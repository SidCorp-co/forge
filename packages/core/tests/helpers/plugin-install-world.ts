import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { expect } from 'vitest';

import { writeTar } from '../../src/lib/tar.js';

// The machine `install-plugin.sh` runs on in `src/devices/install-plugin.test.ts`: the served script
// fetched from the install routes on loopback, beside a stand-in for the token-gated archive route
// answering an archive core's own tar wrote; `sh`, `curl`, `tar` and `node` for real, in a scratch
// HOME. `claude` is a stand-in that keeps its marketplaces and plugins in the box's own files, and
// the plugin's link-cli places a stand-in `forge`; both log every call. The PATH holds only the
// stand-ins, this Node and the system directories, so no real Claude Code on the machine is reached.

export const TOKEN = `forge_pat_dev_${'ab'.repeat(32)}`;
export const MARKETPLACE = 'forge-local';
export const VERSION = '9.9.9-test';
const DEADLINE_MS = 20_000;

/** A path past the 100 bytes a ustar name holds, so the archive carries it in a pax header. */
export const LONG = `plugin/skills/issue-flow/references/${'a-reference-whose-name-is-long-'.repeat(3)}.md`;

const LINK_CLI = `import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const bin = join(homedir(), '.local', 'bin');
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, 'forge'), '#!/bin/sh\\necho "$*" >>"$FORGE_STUB_LOG"\\nexit "$FORGE_DOCTOR_EXIT"\\n');
chmodSync(join(bin, 'forge'), 0o755);
writeFileSync(process.env.LINK_STUB_LOG, process.argv[2] + '\\n', { flag: 'a' });
`;

const CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.CLAUDE_STUB_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'claude.log'), JSON.stringify(args) + '\\n');
const said = args.join(' ');
if (process.env.CLAUDE_STUB_FAIL && said.startsWith(process.env.CLAUDE_STUB_FAIL)) {
  process.stderr.write('stand-in claude refused: ' + said + '\\n');
  process.exit(3);
}
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const write = (f, v) => fs.writeFileSync(path.join(dir, f), JSON.stringify(v));
const markets = read('marketplaces.json');
const plugins = read('plugins.json');
if (said === 'plugin marketplace list --json') return void process.stdout.write(JSON.stringify(markets));
if (said === 'plugin list --json') return void process.stdout.write(JSON.stringify(plugins));
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  const loc = args[3];
  const name = JSON.parse(fs.readFileSync(path.join(loc, '.claude-plugin', 'marketplace.json'), 'utf8')).name;
  write('marketplaces.json', [...markets, { name, source: 'directory', path: loc, installLocation: loc }]);
  return;
}
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'update') return;
if (args[0] === 'plugin' && (args[1] === 'install' || args[1] === 'update')) {
  const [plugin, market] = args[2].split('@');
  const loc = markets.find((m) => m.name === market).installLocation;
  const version = JSON.parse(fs.readFileSync(path.join(loc, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const installPath = path.join(process.env.HOME, '.claude', 'plugins', 'cache', market, plugin, version);
  fs.cpSync(path.join(loc, 'plugin'), installPath, { recursive: true });
  write('plugins.json', [...plugins.filter((p) => p.id !== args[2]), { id: args[2], version, installPath }]);
  return;
}
process.stderr.write('stand-in claude does not know: ' + said + '\\n');
process.exit(2);
`;

/** The archive the stand-in route serves: the marketplace and the plugin, as core cuts them. */
export function pluginArchive(version = VERSION): Buffer {
  const file = (path: string, data: string, mode = 0o644) => ({
    path,
    kind: 'file' as const,
    mode,
    mtime: 1_700_000_000,
    data: Buffer.from(data),
  });
  return gzipSync(
    writeTar([
      file('.claude-plugin/marketplace.json', JSON.stringify({ name: MARKETPLACE })),
      file('plugin/.claude-plugin/plugin.json', JSON.stringify({ name: 'forge', version })),
      file('plugin/hooks/link-cli.mjs', LINK_CLI),
      file('plugin/bin/forge', '#!/bin/sh\n', 0o755),
      file(LONG, 'long\n'),
    ]),
  );
}

export interface PluginInstall {
  code: number | null;
  stdout: string;
  stderr: string;
  home: string;
  /** Each claude call, its argv after `claude`. */
  claude: string[][];
  /** Each call of the forge the plugin's link-cli placed, its argv joined. */
  forge: string[];
  /** The root each link-cli call was handed. */
  linked: string[];
}

export interface PluginInstallOptions {
  args?: string[];
  /** Marketplaces Claude Code already has before the script runs. */
  marketplaces?: Array<{ name: string; installLocation: string }>;
  /** A claude call, by its leading words, that fails. */
  claudeFails?: string;
  /** What the placed forge exits with: its doctor's answer. */
  doctorExit?: number;
  /** Leave `claude` off the PATH. */
  noClaude?: boolean;
}

export interface PluginInstallWorld {
  base: string;
  /** What the stand-in archive route answers, in place of the archive. */
  refusal: { status: 401 | 503; body: Record<string, string> } | null;
  /** The bearer the archive route last saw. */
  bearer: string | null;
  /** Run the served script on the box `name`, whose HOME is kept between runs. */
  install(name: string, options?: PluginInstallOptions): Promise<PluginInstall>;
  close(): Promise<void>;
}

export async function pluginInstallWorld(routes: () => Promise<Hono>): Promise<PluginInstallWorld> {
  const root = await mkdtemp(join(tmpdir(), 'install-plugin-'));
  const installRoutes = await routes();
  const archive = pluginArchive();

  const app = new Hono();
  app.get('/api/install/plugin.tar.gz', (c) => {
    w.bearer = c.req.header('authorization') ?? null;
    if (w.refusal) return c.json(w.refusal.body, w.refusal.status);
    if (w.bearer !== `Bearer ${TOKEN}`) {
      return c.json({ code: 'INVALID_TOKEN', message: 'invalid personal access token' }, 401);
    }
    return c.body(new Uint8Array(archive), 200, { 'content-type': 'application/gzip' });
  });
  app.route('/api', installRoutes);

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const tools = join(root, 'tools');
  await mkdir(tools);
  await symlink(process.execPath, join(tools, 'node'));
  const shim = join(root, 'shim');
  await mkdir(shim);
  await writeFile(join(shim, 'claude'), CLAUDE);
  await chmod(join(shim, 'claude'), 0o755);

  async function install(
    name: string,
    { args = [], marketplaces, claudeFails, doctorExit = 0, noClaude }: PluginInstallOptions = {},
  ): Promise<PluginInstall> {
    const box = join(root, name);
    const home = join(box, 'home');
    const scratch = join(box, 'tmp');
    const state = join(box, 'claude');
    await mkdir(home, { recursive: true });
    await mkdir(scratch, { recursive: true });
    await mkdir(state, { recursive: true });
    for (const f of ['forge.log', 'link.log']) await writeFile(join(box, f), '', { flag: 'a' });
    await writeFile(join(state, 'claude.log'), '', { flag: 'a' });
    if (marketplaces) {
      await writeFile(
        join(state, 'marketplaces.json'),
        JSON.stringify(
          marketplaces.map((m) => ({ ...m, source: 'directory', path: m.installLocation })),
        ),
      );
    }
    for (const f of ['marketplaces.json', 'plugins.json']) {
      await writeFile(join(state, f), '[]', { flag: 'wx' }).catch(() => undefined);
    }
    const before = (await readFile(join(state, 'claude.log'), 'utf8'))
      .split('\n')
      .filter(Boolean).length;
    const forgeBefore = (await readFile(join(box, 'forge.log'), 'utf8'))
      .split('\n')
      .filter(Boolean).length;
    const linkBefore = (await readFile(join(box, 'link.log'), 'utf8'))
      .split('\n')
      .filter(Boolean).length;

    const script = await (await fetch(`${base}/api/install-plugin.sh`)).text();
    await writeFile(join(box, 'install-plugin.sh'), script);
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      TMPDIR: scratch,
      PATH: `${noClaude ? '' : `${shim}:`}${tools}:/usr/bin:/bin`,
      CLAUDE_STUB_DIR: state,
      ...(claudeFails ? { CLAUDE_STUB_FAIL: claudeFails } : {}),
      FORGE_STUB_LOG: join(box, 'forge.log'),
      FORGE_DOCTOR_EXIT: String(doctorExit),
      LINK_STUB_LOG: join(box, 'link.log'),
    };
    const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        // Its own session, so it has no terminal to prompt on, and the deadline reaches its children.
        const child = spawn('sh', [join(box, 'install-plugin.sh'), ...args], {
          env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        const deadline = setTimeout(() => {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
        }, DEADLINE_MS);
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('error', reject);
        child.on('close', (code) => {
          clearTimeout(deadline);
          resolve({ code, stdout, stderr });
        });
      },
    );
    // The script fetched into its own scratch, and removes it on every exit, the token's header too.
    expect(await readdir(scratch)).toEqual([]);
    const lines = async (f: string, from: number) =>
      (await readFile(f, 'utf8')).split('\n').filter(Boolean).slice(from);
    return {
      ...run,
      home,
      claude: (await lines(join(state, 'claude.log'), before)).map(
        (l) => JSON.parse(l) as string[],
      ),
      forge: await lines(join(box, 'forge.log'), forgeBefore),
      linked: await lines(join(box, 'link.log'), linkBefore),
    };
  }

  const w: PluginInstallWorld = {
    base,
    refusal: null,
    bearer: null,
    install,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
  return w;
}
