import { Hono } from 'hono';
import { z } from 'zod';
import { installRoutes, installTargetParamSchema } from '../install/routes.js';
import { describeOperation, json, raw } from './describe.js';
import { declaresInput } from './validator.js';

/** These routes answer `{ error }` and not the error envelope, which the install script and the runner updater read. */
export const installErrorSchema = z.object({ error: z.string() });

export const latestRunnerSchema = z.object({
  version: z.string(),
  commit: z
    .string()
    .optional()
    .describe('Left out, never null, where the release did not record its commit'),
  assets: z.record(z.string(), z.object({ url: z.string(), sha256: z.string() })),
});

const NOT_CONFIGURED = '`RUNNER_RELEASE_DIR` is not set on this server';

export const readInstallScript = describeOperation({
  summary: 'Read the shell script that installs the forge-runner binary',
  description:
    'No sign-in; meant for `curl ... | sh`. It downloads the build for the machine from `/install/bin/{target}` and records this server as the core URL. Where no release is published the script only prints that and exits non-zero.',
  responses: { 200: raw('text/x-shellscript; charset=utf-8', 'The install script') },
});

export const readLatestRunner = describeOperation({
  summary: 'Read the published runner release: its version, commit and a download for each target',
  description: 'No sign-in.',
  responses: {
    200: json(latestRunnerSchema, 'The release, with the sha256 of each build'),
    404: json(installErrorSchema, 'No release is published'),
    501: json(installErrorSchema, NOT_CONFIGURED),
  },
});

export const downloadRunnerBinary = describeOperation({
  summary: 'Download the forge-runner build for one target',
  description: 'No sign-in. `target` is a triple such as `x86_64-unknown-linux-gnu`.',
  responses: {
    200: raw('application/octet-stream', 'The binary'),
    404: json(installErrorSchema, 'The release has no build for this target'),
    501: json(installErrorSchema, NOT_CONFIGURED),
  },
});

/**
 * The install routes with their descriptors attached. The install module may depend on nothing
 * outside itself (`install-is-pure` in `.arch.json`), so the descriptors are mounted here, ahead of
 * its routes, by the one place that already composes both.
 */
export function describedInstallRoutes(routes: Hono = installRoutes): Hono {
  const described = new Hono();
  described.get('/install.sh', readInstallScript);
  described.get('/install/latest.json', readLatestRunner);
  described.get(
    '/install/bin/:target',
    downloadRunnerBinary,
    declaresInput('param', installTargetParamSchema),
  );
  described.route('/', routes);
  return described;
}
