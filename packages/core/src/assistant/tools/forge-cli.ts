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
// cm:guard 180s, and a kill on it is REPORTED on stderr below rather than returned as an empty exit 1: `forge new` is several tracker calls in sequence, and measured 2026-09-15 with the tracker answering in 9s each the 60s cap fired and the model read "rejected without an error message" — a timeout the model cannot see is a refusal it invents a reason for (ISS-1009).
const TIMEOUT_MS = 180_000;
// cm:guard sized so the model reads the WHOLE of what the CLI said: `forge -h --full` and a `forge issue --full` body both run past 16k, and a cap that cuts them hands the model half a refusal with the clearing command in the half it lost. The context budget (`CHAT_CONTEXT_BUDGET_TOKENS`, 80k tokens) is the bound that actually matters, and it elides by age rather than by truncating one answer (ISS-1009).
const OUTPUT_CAP = 200_000;

// cm:guard the CLI is run from THIS package's own pinned `forge-plugin` and with THIS node, never from PATH: the container has no `forge` on PATH and no `sh` shim is needed — `plugin/bin/forge` is a shell wrapper whose whole job is `exec node src/cli.mjs`, so calling that entry directly is the same CLI at the same pinned SHA the shape reader already comes from (ISS-1009).
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

// cm:guard `execFile` with an ARGV ARRAY and never a shell string: the model composes these arguments, and one `;` through a shell is arbitrary execution on the box the door runs on. The fence on WHAT may be run is the credential below — the CLI refuses whatever that person could not do through any other door — and this line is the fence on HOW (ISS-1009).
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
// cm:guard the credential is MINTED PER CALL, bound to the project and revoked in the `finally`: a chat turn must reach exactly what the person speaking reaches, and a service token shared across rooms would let anyone who can type at the bot act with the bot's rights on every project it is in (ISS-1009).
export async function runForgeCli(input: ForgeCliRun): Promise<ForgeCliResult> {
  const cli = bundledCli();
  // cm:guard the default is THIS process on loopback, never the public hostname: the door is the API the CLI would be calling, so a public URL sends a turn out to DNS, TLS and the load balancer to reach the port it started from — and in a container that hairpin is the one hop most likely to be closed (ISS-1009).
  const url = process.env.FORGE_CLI_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}/mcp`;
  const dir = await mkdtemp(join(tmpdir(), 'forge-chat-'));
  let patId: string | null = null;
  try {
    // cm:guard the PERMISSIONS are the fence and the verb list is only the steering. `projects:write` is REQUIRED to file: `patResourceForPath` is mount-shaped and `/api/projects/<id>/issues` resolves to `projects`, so without it `forge new` was refused live on 2026-09-15 ("token lacks projects:write"). `knowledge:write` is REQUIRED for the neighbour check: the scope is method-shaped and `forge new` reads its neighbours through `POST /api/memory/search`, so with `knowledge:read` alone the semantic query 403'd and the filing went ahead "not whole" — measured 2026-09-15, ISS-1472 filed with the fold never tried. What either grant does not open is fenced by the person's own project role, which the server checks on every write, and by `admitVerb`, which refuses the knowledge writes before a token exists; pipeline, skills and schedules stay closed here, on a token that dies in ten minutes (ISS-1009).
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
      // cm:guard `pat_user_name_uniq` makes the name a key per user, so it carries entropy and not just the clock: two calls in one millisecond would otherwise fail the second turn on a constraint no reply could explain (ISS-1009).
      name: `chat turn ${new Date().toISOString()} ${randomBytes(4).toString('hex')}`,
      boundProjectId: input.projectId,
      expiresAt: new Date(Date.now() + PAT_TTL_MS),
    });
    patId = minted.row.id;

    await writeFile(join(dir, '.forge.json'), JSON.stringify({ slug: input.projectSlug }));
    const cfgDir = join(dir, 'config', 'forge');
    await mkdir(cfgDir, { recursive: true });
    // cm:guard `withheld` is what `forge doctor --job ba` would write on a terminal: it shapes what `forge -h` SHOWS the model, so the help it reads first is the reporter's seat and not the whole CLI (ISS-1009).
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
    // cm:guard a non-zero exit with NOTHING on either stream is logged in full, because the model is shown exactly that nothing: measured 2026-09-15, `forge new` returned 1 with empty stdout and stderr through this door and the reply said "rejected without returning an error message" (ISS-1009).
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
