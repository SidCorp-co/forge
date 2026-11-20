/**
 * The runner release line this core serves (ISS-1358): `main`'s releases, or the dev line's
 * prereleases a push to `dev` cuts. Read at the moment of use, never at import, so a value nothing
 * reads yet cannot stop a core from booting.
 */
import { env, type RunnerReleaseChannel, runnerReleaseChannel } from '../../../lib/env.js';

export type { RunnerReleaseChannel };

/** The channel RUNNER_RELEASE_CHANNEL names; throws naming the setting where it is neither line. */
export function servedRunnerChannel(): RunnerReleaseChannel {
  return runnerReleaseChannel(env.RUNNER_RELEASE_CHANNEL);
}

/** The branch a channel's releases are cut from, whose runner head a published build is judged against. */
export function channelBranch(channel: RunnerReleaseChannel): string {
  return channel === 'dev' ? 'dev' : 'main';
}

const DEV_VERSION = /^\d+\.\d+\.\d+-dev\.\d+$/;
const MAIN_VERSION = /^\d+\.\d+\.\d+$/;

/** The line a bare version belongs to, or null where it is on neither (`-rc.1`, a hand build's). */
export function channelOfVersion(version: string): RunnerReleaseChannel | null {
  if (MAIN_VERSION.test(version)) return 'main';
  if (DEV_VERSION.test(version)) return 'dev';
  return null;
}
