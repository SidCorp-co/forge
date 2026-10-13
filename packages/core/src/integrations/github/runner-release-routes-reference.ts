import { z } from 'zod';
import { describeOperation, fail, json } from '../../api-reference/describe.js';
import { tableRow } from '../../api-reference/rows.js';
import { runnerReleases } from '../../db/schema-runner-release.js';

const releaseSchema = tableRow(runnerReleases);

export const releaseAnswerSchema = z.object({ release: releaseSchema });
export const releaseListSchema = z.object({ releases: z.array(releaseSchema) });

const noProject = fail('NOT_FOUND', 'no such project, or the caller cannot see it');

export const startRelease = describeOperation({
  summary:
    'Start a runner release: resolve the commit, check the version, cut the tag, await the build',
  description:
    'Eight steps and no agent. The first five are reads; `cut_tag` is the one that cannot be taken back. A refusal carries the release row it left in `details`, and its message says which step stopped and what is now true on the repository.',
  responses: {
    202: json(releaseAnswerSchema, 'The release, started; the build is reported later'),
    400: fail('RUNNER_RELEASE_BAD_VERSION', 'the version names no tag'),
    403: fail('FORBIDDEN', 'the caller is not a project admin'),
    404: noProject,
    409: fail({
      RUNNER_RELEASE_NO_REPOSITORY: 'the project has no GitHub repository to act on',
      RUNNER_RELEASE_ALREADY_ATTEMPTED: 'this tag already has a release that cannot be run again',
    }),
    422: fail('RUNNER_RELEASE_STOPPED', 'a step refused, and the release is recorded as failed'),
  },
});

export const listReleases = describeOperation({
  summary: 'Every runner release the project has cut, newest first',
  description: 'At most fifty.',
  responses: { 200: json(releaseListSchema), 404: noProject },
});

export const readRelease = describeOperation({
  summary: 'One runner release, with its readings and its outcome',
  responses: {
    200: json(releaseAnswerSchema),
    404: fail('NOT_FOUND', 'no such project, or no such release on it'),
  },
});
