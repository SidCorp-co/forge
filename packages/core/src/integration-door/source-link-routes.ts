/**
 * ISS-705: which issues a change request delivers, and a person's correction of it. The binding is
 * the one an agent's verbs resolve; nothing is sent to the host. Reading asks membership; an unlink
 * or a relink asks a writer.
 */

import type { Context } from 'hono';
import type { z } from 'zod';
import {
  type ChangeRequestLinks,
  readChangeRequestLinks,
  relinkChangeRequestIssue,
  unlinkChangeRequestIssue,
} from '../integrations/source-host/index.js';
import { issueKeysAndTitles } from '../issues/index.js';
import { type AuthVars, restActor } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { changeRequestIssueOf } from './change-request-issue.js';
import { can, onHost, type Routes, refuse } from './source-door.js';
import { linkParamSchema, numberParamSchema } from './source-schemas.js';

/** The link state as a person reads it: issues by key, the primary first, no uuid on screen. */
async function linksAnswer(projectId: string, links: ChangeRequestLinks) {
  const ids = [...links.linked, ...links.unlinked].map((l) => l.issueId);
  const named = await issueKeysAndTitles(projectId, ids);
  const keyOf = (id: string) => named.get(id)?.key ?? id;
  return {
    number: links.number,
    state: links.state,
    primary: links.linked[0] ? keyOf(links.linked[0].issueId) : null,
    linked: links.linked.map((l) => ({
      issue: keyOf(l.issueId),
      title: named.get(l.issueId)?.title ?? null,
      linkedBy: l.linkedBy,
    })),
    unlinked: links.unlinked.map((u) => ({
      issue: keyOf(u.issueId),
      title: named.get(u.issueId)?.title ?? null,
      linkedBy: u.linkedBy,
      unlinkedAt: u.unlinkedAt,
    })),
  };
}

type LinksOutcome = Awaited<ReturnType<typeof readChangeRequestLinks>>;

async function answerLinks(projectId: string, outcome: LinksOutcome) {
  if (!outcome.ok) throw refuse(outcome.code, outcome.detail);
  return linksAnswer(projectId, outcome.links);
}

type LinkAct = typeof unlinkChangeRequestIssue;

/** An unlink or a relink of the issue the path names on the request it names. */
async function correctLink(
  c: Context<{ Variables: AuthVars }>,
  { number, issue }: z.infer<typeof linkParamSchema>,
  act: LinkAct,
): Promise<Awaited<ReturnType<typeof linksAnswer>>> {
  const projectId = c.req.param('projectId') ?? '';
  const host = await onHost(projectId, async (h) => h);
  const label = `${host.words.sigil}${number}`;
  const target = await changeRequestIssueOf(projectId, issue, label);
  const actor = restActor(c);
  return answerLinks(
    projectId,
    await act({
      bindingId: host.bindingId,
      number,
      label,
      issueId: target.id,
      issueKey: target.key,
      actor: { id: actor.id, agency: actor.agency },
    }),
  );
}

export function registerChangeRequestLinks(routes: Routes): void {
  routes.get(
    '/:projectId/integrations/source/change-requests/:number/issues',
    can('project.read'),
    zValidator('param', numberParamSchema),
    async (c) => {
      const projectId = c.req.param('projectId');
      const { number } = c.req.valid('param');
      const host = await onHost(projectId, async (h) => h);
      const label = `${host.words.sigil}${number}`;
      return c.json(
        await answerLinks(
          projectId,
          await readChangeRequestLinks({ bindingId: host.bindingId, number, label }),
        ),
      );
    },
  );
  routes.delete(
    '/:projectId/integrations/source/change-requests/:number/issues/:issue',
    can('project.write'),
    zValidator('param', linkParamSchema),
    async (c) => c.json(await correctLink(c, c.req.valid('param'), unlinkChangeRequestIssue)),
  );
  routes.put(
    '/:projectId/integrations/source/change-requests/:number/issues/:issue',
    can('project.write'),
    zValidator('param', linkParamSchema),
    async (c) => c.json(await correctLink(c, c.req.valid('param'), relinkChangeRequestIssue)),
  );
}
