// The stack a Forge previewing itself runs on demo data (REQ-39, REQ-41 BC-22), started by
// `pnpm preview:demo -- --port <port>` (scripts/preview-demo.mjs) in a run's worktree: a throwaway
// Postgres in a container of its own (the integration harness's own start and stop), core migrated
// and seeded with the demo world (./demo-world.ts) in demo mode, and serving on <port> the web it
// was built here (packages/web-v2, `vite build` into a scratch directory, while the database comes
// up). It runs until it is signalled or one of its parts dies, and then removes all of it: no
// container, process or listener of its own is left.
//
// What it starts never sees the environment it was started in beyond a short list (PATH, HOME, ...):
// a DATABASE_URL, a token or a core URL held by the box is not passed on, so nothing reaches any
// other database or API. Every stage is held to the start budget (FORGE_PREVIEW_DEADLINE, set by the
// bootstrap from FORGE_PREVIEW_START_SECONDS) and a stage still running past it is refused by name.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateDatabase } from './migrations.js';
import { startPostgres, stopPostgres } from './postgres-container.js';

const CORE_DIR = fileURLToPath(new URL('../..', import.meta.url));
const ROOT = join(CORE_DIR, '..', '..');
const WEB_DIR = join(ROOT, 'packages', 'web-v2');
const LANE = 'preview-demo';
const FORWARDED = [
  'PATH',
  'HOME',
  'USER',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
];

/** A stage that was still running when the start budget ended, or a part that died. Named, never absorbed. */
export class PreviewStartRefused extends Error {
  constructor(
    readonly stage: string,
    detail: string,
  ) {
    super(`preview:demo refused: stage "${stage}" ${detail}`);
  }
}

/** The environment a child gets: the short list the box passes on, then what the stack sets. */
export function childEnv(
  parent: NodeJS.ProcessEnv,
  set: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of FORWARDED) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...set };
}

/** Whether `name` is a container this stack could have started in a process that is gone. */
export function orphanedContainer(name: string, alive: (pid: number) => boolean): boolean {
  const m = new RegExp(`^forge-qa-${LANE}-\\d+-(\\d+)$`).exec(name);
  return m !== null && !alive(Number(m[1]));
}

function docker(args: string[]): string {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : '';
}

/** A stack killed without its teardown leaves its container; the next start removes only those. */
function reapOrphans(): void {
  const names = docker(['ps', '-a', '--filter', `name=forge-qa-${LANE}-`, '--format', '{{.Names}}'])
    .split('\n')
    .map((n) => n.trim())
    .filter(Boolean);
  for (const name of names) {
    if (orphanedContainer(name, (pid) => existsSync(`/proc/${pid}`))) {
      docker(['rm', '-f', '-v', name]);
      log(`removed ${name}, left by a stack that died without its teardown`);
    }
  }
}

function log(line: string): void {
  process.stdout.write(`[preview-demo] ${line}\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function descendants(pid: number): number[] {
  const out = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout;
  const kids = out.split('\n').filter(Boolean).map(Number);
  return kids.flatMap((k) => [...descendants(k), k]);
}

async function stopChild(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const tree = [...descendants(pid), pid];
  const signal = (s: NodeJS.Signals) => {
    for (const p of tree) {
      try {
        process.kill(p, s);
      } catch {}
    }
  };
  signal('SIGTERM');
  const gone = new Promise<void>((r) => child.once('exit', () => r()));
  await Promise.race([gone, sleep(3000)]);
  signal('SIGKILL');
}

interface Held {
  container: string | null;
  children: ChildProcess[];
  scratch: string | null;
}

/** Builds the web core serves into `outDir`; the child is held, so a teardown stops a build in flight. */
function buildWeb(outDir: string, held: Held): Promise<void> {
  const help = spawnSync('node', ['scripts/gen-help-content.mjs'], {
    cwd: WEB_DIR,
    encoding: 'utf8',
  });
  if (help.status !== 0) {
    return Promise.reject(new PreviewStartRefused('help', `failed: ${help.stderr || help.stdout}`));
  }
  const child = spawn(
    join(ROOT, 'node_modules', '.bin', 'vite'),
    ['build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'],
    { cwd: WEB_DIR, env: childEnv(process.env, {}), stdio: ['ignore', 'inherit', 'inherit'] },
  );
  held.children.push(child);
  return new Promise((resolve, reject) => {
    child.once('exit', (code, signal) =>
      code === 0
        ? resolve()
        : reject(new PreviewStartRefused('web build', `exited ${code ?? signal}`)),
    );
  });
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const at = args.indexOf('--port');
  const port = at >= 0 ? Number(args[at + 1]) : Number.NaN;
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new PreviewStartRefused(
      'arguments',
      `got --port ${JSON.stringify(args[at + 1])}; the valid shape is --port <1024-65535>`,
    );
  }
  const deadline = Number(process.env.FORGE_PREVIEW_DEADLINE ?? Date.now() + 120_000);
  const budgetSeconds = Math.round((deadline - Date.now()) / 1000);
  const t0 = Date.now();
  const timings: string[] = [];
  const within = async <T>(stage: string, work: (leftMs: number) => Promise<T>): Promise<T> => {
    const left = deadline - Date.now();
    const refusal = () =>
      new PreviewStartRefused(
        stage,
        `was still running when the start budget ended (${budgetSeconds}s from the start; FORGE_PREVIEW_START_SECONDS, the runner's PREVIEW_LIMITS.readyTimeoutSeconds); done before it: ${timings.join(', ') || 'none'}`,
      );
    if (left <= 0) throw refusal();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(refusal()), left);
    });
    const began = Date.now();
    try {
      const value = await Promise.race([work(left), late]);
      timings.push(`${stage} ${Math.round((Date.now() - began) / 100) / 10}s`);
      return value;
    } finally {
      clearTimeout(timer);
    }
  };

  const held: Held = { container: null, children: [], scratch: null };
  let tearing = false;
  const teardown = async (): Promise<void> => {
    if (tearing) return;
    tearing = true;
    await Promise.all(held.children.map(stopChild));
    if (held.container) {
      try {
        stopPostgres(held.container);
      } catch (e) {
        log(`the container ${held.container} could not be removed: ${(e as Error).message}`);
      }
    }
    if (held.scratch) rmSync(held.scratch, { recursive: true, force: true });
    log('stopped: container, core and the web build are gone');
  };

  // `on`, never `once`: a stop signals the whole group and the bootstrap relays it as well, so the
  // signal arrives twice, and the second one must not find the default action and end the teardown
  const dying = new Promise<string>((resolve) => {
    for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(s, () => resolve(s));
  });

  try {
    process.env.FORGE_QA_LANE = `${LANE}-${port}`;
    reapOrphans();
    held.scratch = mkdtempSync(join(tmpdir(), 'forge-preview-demo-'));
    const webDir = join(held.scratch, 'web');
    const built = buildWeb(webDir, held);
    // awaited at its own stage below; a build that fails sooner is reported there, not as unhandled
    built.catch(() => {});
    const pg = await within('postgres', (left) => startPostgres(Math.min(left, 60_000)));
    held.container = pg.name;
    const databaseUrl = pg.adminUrl;
    await within('migrate', () => migrateDatabase(databaseUrl));

    const secret = () => randomBytes(24).toString('hex');
    const coreSet = {
      NODE_ENV: 'development',
      LOG_LEVEL: 'warn',
      DATABASE_URL: databaseUrl,
      JWT_SECRET: secret(),
      DEVICE_TOKEN_PEPPER: secret(),
      PAT_PEPPER: secret(),
      PORT: String(port),
      WEB_DIST_DIR: webDir,
      APP_BASE_URL: `http://127.0.0.1:${port}`,
      CORS_ORIGINS: `http://127.0.0.1:${port}`,
      UPLOADS_DIR: join(held.scratch, 'uploads'),
      FORGE_DEMO_MODE: '1',
      FORGE_ENVIRONMENT: 'demo',
    };

    await within('seed', async () => {
      Object.assign(process.env, coreSet);
      const { seedDemoWorld } = await import('./demo-world.js');
      const { closeDb } = await import('../../src/db/client.js');
      try {
        const world = await seedDemoWorld();
        log(`seeded project ${world.project.slug}; the demo member is ${world.member.email}`);
      } finally {
        await closeDb();
      }
    });

    const exits: Promise<string>[] = [];
    const start = (
      name: string,
      cmd: string,
      argv: string[],
      cwd: string,
      set: Record<string, string>,
    ) => {
      const child = spawn(cmd, argv, {
        cwd,
        env: childEnv(process.env, set),
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      held.children.push(child);
      exits.push(new Promise((r) => child.once('exit', (c, s) => r(`${name} exited ${c ?? s}`))));
      return child;
    };
    const diedWhile = (): Promise<never> =>
      Promise.race(exits).then((what) => {
        throw new PreviewStartRefused('start', `${what} before it answered`);
      });

    await within('web build', () => built);
    start('core', process.execPath, ['--import', 'tsx', 'src/index.ts'], CORE_DIR, coreSet);
    await within('core', async () => {
      const up = async () => {
        for (;;) {
          try {
            if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
          } catch {}
          await sleep(250);
        }
      };
      await Promise.race([up(), diedWhile()]);
      // the page is the build core serves: a demo core sends sign-in home, so a redirect is an answer
      const page = await fetch(`http://127.0.0.1:${port}/login`, {
        redirect: 'manual',
        headers: { accept: 'text/html' },
      });
      if (page.status >= 400)
        throw new PreviewStartRefused('core', `answered ${page.status} on /login, not the web`);
    });

    log(
      `ready in ${Math.round((Date.now() - t0) / 100) / 10}s (${timings.join(', ')}): http://127.0.0.1:${port}, demo data in ${held.container}`,
    );
    const outcome = await Promise.race([dying, Promise.race(exits)]);
    log(`${outcome}: stopping`);
    await teardown();
    return /^SIG/.test(outcome) ? 0 : 1;
  } catch (e) {
    const chain: string[] = [];
    for (let err: unknown = e; err instanceof Error; err = err.cause) chain.push(err.message);
    console.error(chain.length > 0 ? chain.join('\n  caused by: ') : String(e));
    await teardown();
    return 3;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
