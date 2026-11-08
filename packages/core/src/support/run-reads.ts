// A pipeline run's door to the project's declared production reads (ISS-707). A run read production
// through whatever credential its box held; it now names a read its project declares, and the read
// runs by the one declared-read path a room takes (`declared-read.ts`): on any online box of the
// project, with its credential a project secret handed to that process alone. Each read is kept on
// the run's issue as an `ops.read` activity: the run, the token's holder, the read, its arguments,
// its exit, and what it printed, cut of every secret and scrubbed, as a room's read is kept by session
// and turn. A run that is not live in this project, and a read the project does not declare, are
// refused by name with nothing asked of a box.

import type { SupportRead, SupportReadResult } from '@forge/contracts/support';
import { scrubLogText } from '@forge/observability';
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { listActiveBindingsForProjectProvider } from '../integrations/index.js';
import type { RocketChatBindingConfig } from '../integrations/rocketchat/index.js';
import { supportApiSecretsOf } from '../integrations/support-api/index.js';
import { recordActivityTx, resolveActor } from '../issues/index.js';
import { refused } from '../lib/refusal.js';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, noQuery, strictBody, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { projectReadBox, runDeclaredRead } from './declared-read.js';
import type { ReadArgs } from './ops-read-args.js';
import { no, type Outcome } from './outcome.js';
import { ownerSecretsOf } from './owner-credential.js';

const readParam = zValidator(
  'param',
  z.object({ id: z.uuid(), name: z.string().min(1).max(40) }),
  invalid('invalid path: a project uuid and a declared read name'),
);

const readBody = z.strictObject({
  run: z.uuid(),
  args: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

/** How much of each stream an audit row keeps. */
const AUDIT_CHARS = 8_000;

/** Every read the project declares: each on a grant of one of its channel bindings, by name. */
async function declaredReadsOf(projectId: string): Promise<SupportRead[]> {
  const out = new Map<string, SupportRead>();
  for (const { binding } of await listActiveBindingsForProjectProvider(projectId, 'rocketchat')) {
    const config = binding.config as RocketChatBindingConfig | null;
    for (const block of [config?.agent, config?.support]) {
      for (const read of block?.grants?.reads ?? [])
        if (!out.has(read.name)) out.set(read.name, read);
    }
  }
  return [...out.values()];
}

/** The run's issue, where the run is live in this project and works one. */
async function liveRunIssue(projectId: string, runId: string): Promise<string | null> {
  const [run] = await db
    .select({ issueId: pipelineRuns.issueId, status: pipelineRuns.status })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.projectId, projectId)))
    .limit(1);
  return run?.issueId && run.status === 'running' ? run.issueId : null;
}

async function scrubbedForProject(projectId: string, text: string): Promise<string> {
  const [apis, owner] = await Promise.all([
    supportApiSecretsOf(projectId).catch(() => []),
    ownerSecretsOf(projectId).catch(() => []),
  ]);
  return scrubLogText(text, [...apis, ...owner]);
}

/**
 * Run the project's declared read `name` for the live run `runId`: the outcome and the run's issue,
 * or null where the run is not a running run of this project working an issue.
 */
export async function runReadForRun(input: {
  projectId: string;
  runId: string;
  name: string;
  args: ReadArgs;
}): Promise<{ issueId: string; out: Outcome<SupportReadResult> } | null> {
  const issueId = await liveRunIssue(input.projectId, input.runId);
  if (!issueId) return null;
  const declared = await declaredReadsOf(input.projectId);
  const read = declared.find((r) => r.name === input.name);
  if (!read) {
    return {
      issueId,
      out: no(
        'SUPPORT_READ_UNDECLARED',
        '/name',
        `this project declares no read ${input.name}; it declares ${declared.map((r) => r.name).join(', ') || 'none'}. Nothing ran.`,
      ),
    };
  }
  const out = await runDeclaredRead({
    projectId: input.projectId,
    read,
    args: input.args,
    box: () => projectReadBox(input.projectId),
    scrub: (text) => scrubbedForProject(input.projectId, text),
  });
  return { issueId, out };
}

const cut = (text: string) => (text.length > AUDIT_CHARS ? text.slice(0, AUDIT_CHARS) : text);

/** `POST /:id/ops-reads/:name { run, args? }`. */
export function mountRunReadRoutes(routes: Hono<{ Variables: AuthVars }>): void {
  routes.post(
    '/:id/ops-reads/:name',
    readParam,
    requiresOnParam('project.write', 'id'),
    noQuery,
    strictBody(readBody, '{ run: the uuid of your running run, args?: { <parameter>: value } }'),
    async (c) => {
      const { id, name } = c.req.valid('param');
      const { run, args } = c.req.valid('json');
      const asked = await runReadForRun({ projectId: id, runId: run, name, args: args ?? {} });
      if (!asked) {
        return refused(
          c,
          [
            {
              code: 'PIPELINE_RUN_NOT_FOUND',
              path: '/run',
              detail: `run ${run} is not a running run of this project working an issue; a read is asked for the run you are`,
            },
          ],
          'SUPPORT_REFUSED',
        );
      }
      const { issueId, out } = asked;
      // kept on the run's issue whether it ran or was refused: who asked, for which run, what came back
      await recordActivityTx(db, {
        issueId,
        actor: resolveActor(c),
        action: 'ops.read',
        payload: {
          run,
          name,
          args: args ?? {},
          ...(out.ok
            ? {
                exitCode: out.value.exitCode,
                timedOut: out.value.timedOut,
                durationMs: out.value.durationMs,
                stdout: cut(out.value.stdout),
                stderr: cut(out.value.stderr),
              }
            : { refusals: out.refusals }),
        },
      });
      if (!out.ok) return refused(c, out.refusals, 'SUPPORT_REFUSED');
      return c.json({ read: out.value });
    },
  );
}
