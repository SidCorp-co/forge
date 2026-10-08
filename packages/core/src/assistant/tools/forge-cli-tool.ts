import { z } from 'zod';
import type { ContextScopedMcpToolFactory } from '../../lib/tool.js';
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
  'This is the tracker: reading, searching, comments, status, guides.',
  readFormsLine(),
  'Send one as it stands, `-` being where `body` is substituted; do NOT guess a flag.',
  '`-h` is for a verb whose form this description does not carry.',
  'It files no issue: a report or a wish is recorded with forge_feedback or forge_requirement_draft.',
].join(' ');

export const forgeCliTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge',
  reach: 'project',
  grant: {
    none: 'it runs the forge CLI under the turn token, whose own grant every door it reaches reads',
  },
  description: DESCRIPTION,
  inputSchema: z.toJSONSchema(input) as Record<string, unknown>,
  handler: async (raw: Record<string, unknown>) => {
    const args = input.parse(raw);
    const closed = admitVerb(args.argv);
    if (closed) return { exitCode: 2, stdout: '', stderr: closed, _mcpIsError: true };
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
