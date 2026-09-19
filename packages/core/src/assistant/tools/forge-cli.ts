/**
 * ISS-1009 — the chat door drives the `forge` CLI instead of re-wrapping the
 * tracker verb by verb.
 *
 * The CLI already owns what a filing needs: the shape its category is read
 * against, the neighbours the tracker's own semantic search finds, the fold
 * onto one of them, `--with` for a relates edge and `--new` to file anyway and
 * say what it passed over. A second copy of any of that on this side is the
 * third reader ISS-1006 exists to remove.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mintPat, revokePat } from '../../auth/pat.js';
import { logger } from '../../logger.js';
import { chatWithheld, placeBody, stoppedMessage } from './forge-cli-argv.js';

/** How long the turn's credential lives. Minutes, because a turn is seconds. */
const PAT_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 180_000;
const OUTPUT_CAP = 200_000;

const require = createRequire(import.meta.url);
function bundledCli(): { bin: string; argv0: string[] } {
  const override = process.env.FORGE_CLI_PATH;
  if (override) return { bin: override, argv0: [] };
  const pkg = require.resolve('forge-plugin/package.json');
  return { bin: process.execPath, argv0: [join(dirname(pkg), 'plugin', 'src', 'cli.mjs')] };
}

export interface ForgeCliRun {
  readonly argv: readonly string[];
  /** Written to a file the argv may name as `-`, for a verb that takes a body. */
  readonly body?: string | undefined;
  readonly userId: string;
  readonly projectId: string;
  readonly projectSlug: string;
}

export interface ForgeCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

function run(bin: string, argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<ForgeCliResult>((resolve) => {
    execFile(
      bin,
      [...argv],
      { cwd, env, timeout: TIMEOUT_MS, maxBuffer: OUTPUT_CAP * 4 },
      (err, stdout, stderr) => {
        const e = err as { code?: number | string; killed?: boolean; signal?: string } | null;
        const killed = e?.killed === true || typeof e?.signal === 'string';
        const said = String(stderr).slice(0, OUTPUT_CAP);
        resolve({
          stdout: String(stdout).slice(0, OUTPUT_CAP),
          stderr: killed ? `${said}${said ? '\n' : ''}${stoppedMessage(TIMEOUT_MS / 1000)}` : said,
          code: typeof e?.code === 'number' ? e.code : e ? 1 : 0,
        });
      },
    );
  });
}

/**
 * One CLI call, as the chat user, scoped to the bound project.
 */
export async function runForgeCli(input: ForgeCliRun): Promise<ForgeCliResult> {
  const cli = bundledCli();
  const url = process.env.FORGE_CLI_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}/mcp`;
  const dir = await mkdtemp(join(tmpdir(), 'forge-chat-'));
  let patId: string | null = null;
  try {
    const minted = await mintPat({
      userId: input.userId,
      permissions: [
        'issues:read',
        'issues:write',
        'projects:read',
        'projects:write',
        'knowledge:read',
        'knowledge:write',
        'questions:read',
      ],
      name: `chat turn ${new Date().toISOString()} ${randomBytes(4).toString('hex')}`,
      boundProjectId: input.projectId,
      expiresAt: new Date(Date.now() + PAT_TTL_MS),
    });
    patId = minted.row.id;

    await writeFile(join(dir, '.forge.json'), JSON.stringify({ slug: input.projectSlug }));
    const cfgDir = join(dir, 'config', 'forge');
    await mkdir(cfgDir, { recursive: true });
    await writeFile(
      join(cfgDir, 'config.json'),
      JSON.stringify({ token: minted.plaintext, url, withheld: chatWithheld() }),
    );

    const bodyPath = join(dir, 'body.md');
    const argv = placeBody(input.argv, input.body, bodyPath);
    if (input.body) await writeFile(bodyPath, input.body);

    const out = await run(cli.bin, [...cli.argv0, ...argv], dir, {
      ...process.env,
      XDG_CONFIG_HOME: join(dir, 'config'),
      FORGE_SESSION_ID: `chat-${input.projectId}`,
    });
    if (out.code !== 0) {
      logger.warn(
        {
          argv: input.argv,
          code: out.code,
          stdout: out.stdout.slice(0, 2000),
          stderr: out.stderr.slice(0, 2000),
        },
        'forge-cli: non-zero exit',
      );
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    if (patId) {
      await revokePat(patId, input.userId).catch((err) =>
        logger.error({ err, patId }, 'forge-cli: could not revoke the turn credential'),
      );
    }
  }
}
