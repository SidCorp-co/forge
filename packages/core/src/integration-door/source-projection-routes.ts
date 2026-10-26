/**
 * The source door for a binding no webhook reaches: what a commit's or a branch's checks say, and a
 * change request edited, closed or re-read by its number — each written onto Forge's projection by
 * the writers a delivery reaches (`integrations/source-host/read-projection.ts`), so the links a
 * description carries are derived by one rule and the checks are stored in the shape a hook stores.
 *
 * Reads ask membership; edit, close and refresh ask a writer, since each changes the host's request
 * or Forge's record of it. A write the host accepted whose projection then fails is REPORTED on the
 * answer rather than thrown: the change stands on the host by then, and an error would say it did not.
 */

import { SourceHostInputRefusal } from '../integrations/source-host/index.js';
import { zValidator } from '../middleware/zod-validator.js';
import { can, onHost, type Routes } from './source-door.js';
import { checksAt, project, projectAfterWrite } from './source-projection.js';
import {
  editBodySchema,
  numberParamSchema,
  refParamSchema,
  shaParamSchema,
} from './source-schemas.js';

export function registerSourceProjectionRoutes(routes: Routes): void {
  routes.get(
    '/:projectId/integrations/source/commits/:sha/checks',
    can('project.read'),
    zValidator('param', shaParamSchema),
    async (c) => {
      const { sha } = c.req.valid('param');
      return c.json(
        await onHost(c.req.param('projectId'), async (host) => {
          // a host filters checks by the whole sha, and the rollup counts by it, so a short one is
          // resolved first; one naming no commit is refused rather than answered `none`
          const commit = await host.readCommit(sha);
          if (!commit) {
            throw new SourceHostInputRefusal(
              `\`${sha}\` names no commit on ${host.fullName}, so there are no checks to read`,
            );
          }
          return checksAt(commit.sha, await host.readChecks(commit.sha));
        }),
      );
    },
  );
  routes.get(
    '/:projectId/integrations/source/branches/:ref/checks',
    can('project.read'),
    zValidator('param', refParamSchema),
    async (c) => {
      const { ref } = c.req.valid('param');
      return c.json(
        await onHost(c.req.param('projectId'), async (host) => {
          const sha = await host.branchHead(ref);
          return { ref, ...checksAt(sha, await host.readChecks(sha)) };
        }),
      );
    },
  );
  routes.patch(
    '/:projectId/integrations/source/change-requests/:number',
    can('project.write'),
    zValidator('param', numberParamSchema),
    zValidator('json', editBodySchema),
    async (c) => {
      const projectId = c.req.param('projectId');
      const { number } = c.req.valid('param');
      const { title, body } = c.req.valid('json');
      return c.json(
        await onHost(projectId, async (host) => {
          const edited = await host.updateChangeRequest({
            number,
            ...(title === undefined ? {} : { title }),
            ...(body === undefined ? {} : { body }),
          });
          return projectAfterWrite(host, projectId, edited, 'edit');
        }),
      );
    },
  );
  routes.post(
    '/:projectId/integrations/source/change-requests/:number/close',
    can('project.write'),
    zValidator('param', numberParamSchema),
    async (c) => {
      const projectId = c.req.param('projectId');
      const { number } = c.req.valid('param');
      return c.json(
        await onHost(projectId, async (host) =>
          projectAfterWrite(host, projectId, await host.closeChangeRequest({ number }), 'close'),
        ),
      );
    },
  );
  // nothing on the host changes here, so a projection that cannot be written is the answer's refusal
  routes.post(
    '/:projectId/integrations/source/change-requests/:number/refresh',
    can('project.write'),
    zValidator('param', numberParamSchema),
    async (c) => {
      const projectId = c.req.param('projectId');
      const { number } = c.req.valid('param');
      return c.json(
        await onHost(projectId, async (host) => {
          const read = await host.readChangeRequest(number);
          return { ...read, projection: await project(host, projectId, read) };
        }),
      );
    },
  );
}
