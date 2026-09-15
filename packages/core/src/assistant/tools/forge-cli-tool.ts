/**
 * ISS-1009 — `forge` as one chat tool, in place of a wrapper per verb.
 *
 * The description is deliberately short: `DESCRIPTION_CAP` is 1024 and
 * `forge_issues` already loses 76% of its own text to it. The read forms the
 * model repeats every turn ARE carried (`forge-cli-forms.ts`), held to the
 * bundled `-h` by a whole-form test; everything else is `forge <verb> -h`,
 * one call away and the copy that cannot go stale (ISS-1041).
 */

import { z } from 'zod';
import type { ContextScopedMcpToolFactory } from '../../mcp/tools/lib.js';
import { runForgeCli } from './forge-cli.js';
import { admitVerb } from './forge-cli-argv.js';
import { readFormsLine } from './forge-cli-forms.js';

const input = z
  .object({
    argv: z
      .array(z.string())
      .min(1)
      .max(24)
      .describe('Arguments after `forge`, e.g. ["issue","--search","coolify"].'),
    body: z
      .string()
      .optional()
      .describe('Markdown body. Write `-` in argv where the file goes; it is substituted for you.'),
  })
  .strict();

const DESCRIPTION = [
  'Run the `forge` CLI as the person you are talking to, scoped to this project.',
  'This is the tracker: filing, reading, searching, comments, status, guides.',
  readFormsLine(),
  'For anything else start with `{"argv":["-h"]}` to see the verbs, then `forge <verb> -h` for its arguments —',
  'do NOT guess a flag. File with `{"argv":["new","-","--title","...","--category","bug"],"body":"..."}`',
  '— the `-` is where your body is substituted.',
  'it reads the body against the sections that category owes, refuses a filing that is missing one',
  'naming the heading, folds onto a near neighbour when it finds one, and takes `--with ISS-45` for',
  'a relates edge or `--new` to file anyway and say what it passed over.',
  'Ask it rather than guessing: `forge guide <slug>` is the method for anything here.',
].join(' ');

export const forgeCliTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge',
  description: DESCRIPTION,
  inputSchema: z.toJSONSchema(input) as Record<string, unknown>,
  handler: async (raw: Record<string, unknown>) => {
    const args = input.parse(raw);
    // cm:guard the verb is admitted BEFORE a credential is minted: a refused verb costs no token row and no revoke, and the refusal names what is open so the model's next call is a real one (ISS-1009).
    const closed = admitVerb(args.argv);
    if (closed) return { exitCode: 2, stdout: '', stderr: closed, _mcpIsError: true };
    const userId = ctx.principal?.userId;
    const projectId = ctx.boundProjectId;
    // cm:guard refused rather than defaulted: without a user there is no credential to mint and the only way to still run is a shared one, which is the borrowed authority this tool is built to avoid (ISS-1009).
    if (!userId || !projectId || !ctx.projectSlug) {
      throw new Error(
        'the forge CLI runs as a signed-in person on a bound project, and this turn names none',
      );
    }
    const out = await runForgeCli({
      argv: args.argv,
      body: args.body,
      userId,
      projectId,
      projectSlug: ctx.projectSlug,
    });
    // cm:guard stderr and the exit code are handed BACK rather than thrown: the CLI says what it refused and how to clear it — that refusal IS the answer the model needs, and turning it into a generic tool error deletes the one sentence that names the way out. `_mcpIsError` rides beside it on a non-zero exit so the audit record still reads the call as refused, which is what `detectStateConfab` partitions on (ISS-1009).
    return {
      exitCode: out.code,
      stdout: out.stdout,
      stderr: out.stderr,
      ...(out.code === 0 ? {} : { _mcpIsError: true }),
    };
  },
});
