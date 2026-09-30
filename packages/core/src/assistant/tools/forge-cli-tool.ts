import { z } from 'zod';
import { patGrantIsLegacy, patGrantIsStatedFull } from '../../auth/pat-permissions.js';
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
  'Send one as it stands, `-` being where `body` is substituted; do NOT guess a flag.',
  '`-h` is for a verb whose form this description does not carry.',
  '`new` reads the body against the sections that category owes, refuses a filing missing one',
  'naming the heading, folds onto a near neighbour when it finds one, and takes `--with ISS-45` for',
  'a relates edge or `--new` to file anyway and say what it passed over.',
].join(' ');

export const forgeCliTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge',
  description: DESCRIPTION,
  inputSchema: z.toJSONSchema(input) as Record<string, unknown>,
  handler: async (raw: Record<string, unknown>) => {
    const args = input.parse(raw);
    const closed = admitVerb(args.argv);
    if (closed) return { exitCode: 2, stdout: '', stderr: closed, _mcpIsError: true };
    // cm:guard the CLI's tracker verbs reach /mcp, where a token's grant is not read (tools
    // fence by role: `PAT_UNGRANTABLE['/mcp']`), so a person bounded by a named grant would
    // reach past it through here. Refused by name rather than run wider (ISS-17).
    if (ctx.grant && !patGrantIsLegacy(ctx.grant) && !patGrantIsStatedFull(ctx.grant)) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: `FORBIDDEN: the person asking reached Forge with an access token granted only ${ctx.grant.join(', ')}, and the forge CLI reaches the tracker through /mcp, which does not read a grant — so it is not run for them. Nothing was done; tell them to ask signed in, or with a token granted '*'.`,
        _mcpIsError: true,
      };
    }
    const token = ctx.turnToken;
    const projectId = ctx.boundProjectId;
    if (!token || !projectId || !ctx.projectSlug) {
      throw new Error(
        'the forge CLI runs under the token minted for the person this turn answers, on a bound project, and this turn holds neither',
      );
    }
    const out = await runForgeCli({
      argv: args.argv,
      body: args.body,
      token,
      projectId,
      projectSlug: ctx.projectSlug,
    });
    return {
      exitCode: out.code,
      stdout: out.stdout,
      stderr: out.stderr,
      ...(out.code === 0 ? {} : { _mcpIsError: true }),
    };
  },
});
