// The one path a declared production read runs by (ISS-871, ISS-707), whoever asks: a room's
// session (`ops-read.ts`), a pipeline run (`run-reads.ts`) or a script schedule's ops call
// (`schedules/script-ops.ts`). Its arguments are checked against the declaration, its credential is
// the project secret the declaration names, read from the vault and handed to the box for that one
// process, a secret the vault does not hold refuses it by name before the box is asked, and what it
// printed is cut of every secret value and scrubbed by the asker's own scrubber before anyone reads it.

import {
  SUPPORT_READ_TIMEOUT_DEFAULT_MS,
  type SupportRead,
  type SupportReadResult,
  type SupportReadSecret,
} from '@forge/contracts/support';
import { readProjectSecrets } from '../project-config/index.js';
import { runOpsRead } from '../runners/index.js';
import { type ReadArgs, readArgv } from './ops-read-args.js';
import { no, type Outcome } from './outcome.js';

type SecretEnv = { ok: true; env: Record<string, string> } | Extract<Outcome<never>, { ok: false }>;

/**
 * The variables a read's process is handed: each declared secret's value, or the refusal naming
 * every ref the vault does not hold (or cannot decrypt) under `SUPPORT_READ_SECRET_MISSING`.
 */
export async function secretEnvOf(
  projectId: string,
  name: string,
  secrets: readonly SupportReadSecret[] | undefined,
): Promise<SecretEnv> {
  const declared = secrets ?? [];
  if (declared.length === 0) return { ok: true, env: {} };
  const got = await readProjectSecrets(
    projectId,
    declared.map((d) => d.secret),
  );
  if (!got.ok) {
    const refs = got.refs.map((r) => r.replace('secret://', '')).join(', ');
    const held = got.code === 'SECRET_VALUE_MISSING' ? 'do not hold' : 'hold but cannot decrypt';
    return no(
      'SUPPORT_READ_SECRET_MISSING',
      '/name',
      `${name} declares the project secret ${refs}, which this project's secrets ${held}; a project admin writes it at PUT /api/projects/:id/secrets/<scope>/<name>. Nothing ran.`,
    ) as Extract<Outcome<never>, { ok: false }>;
  }
  return {
    ok: true,
    env: Object.fromEntries(declared.map((d) => [d.env, got.values.get(d.secret) as string])),
  };
}

/** `text` with every handed secret's value cut out, named by its variable. */
export function withoutSecrets(text: string, env: Record<string, string>): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (value) out = out.split(value).join(`[secret ${name}]`);
  }
  return out;
}

/**
 * Run `read` with `args` on the box `box` picks, for `projectId`: refused by name where an argument
 * does not fit, a secret is not held, no box can run it or the box could not; otherwise what it
 * printed, cut of its secrets and passed through `scrub`.
 */
export async function runDeclaredRead(input: {
  projectId: string;
  read: SupportRead;
  args: ReadArgs;
  box: () => Promise<Outcome<string>>;
  scrub: (text: string) => Promise<string>;
}): Promise<Outcome<SupportReadResult>> {
  const { read, scrub } = input;
  const argv = readArgv(read, input.args);
  if (!argv.ok) return argv;
  const env = await secretEnvOf(input.projectId, read.name, read.secrets);
  if (!env.ok) return env;
  const box = await input.box();
  if (!box.ok) return box;
  const ran = await runOpsRead({
    deviceId: box.value,
    projectId: input.projectId,
    name: read.name,
    argv: argv.value,
    timeoutMs: read.timeoutMs ?? SUPPORT_READ_TIMEOUT_DEFAULT_MS,
    ...(read.secrets ? { env: env.env } : {}),
  });
  if (!ran.ok) {
    // the box's words can name the program it could not run: scrubbed of the argv as of any secret
    const why = (await scrub(withoutSecrets(ran.why, env.env)))
      .split(read.argv[0] as string)
      .join(read.name);
    return no('SUPPORT_READ_FAILED', '/name', `${read.name} did not run: ${why}`);
  }
  return {
    ok: true,
    value: {
      ...ran.value,
      stdout: await scrub(withoutSecrets(ran.value.stdout, env.env)),
      stderr: await scrub(withoutSecrets(ran.value.stderr, env.env)),
    },
  };
}
