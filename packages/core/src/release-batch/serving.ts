import { collectReleaseBlockers } from './blockers.js';
import type { ReleaseChannel } from './channel.js';
import { type LiveState, readLiveState } from './verify.js';

export interface ServingDeployment {
  identity: string | null;
  health: 'up' | 'down';
  readings: string[];
  unhealthy: string[];
  unidentified: string[];
  disagreement: string[] | null;
  readAt: string;
  verifySource: 'binding' | 'environments-live' | 'none';
}

export type ServingRead =
  | { ok: true; deployment: ServingDeployment }
  | { ok: false; code: 'NO_PROJECT' }
  | { ok: false; code: 'PROBES_UNDECLARED'; detail: string }
  | { ok: false; code: 'PROBE_URL_INVALID'; detail: string };

// cm:guard the identity is DERIVED on every call and never stored — a commit copied onto a row is
// wrong the moment the next deploy lands, measured on forge-dev when prod moved ae8cdcbb0 -> 592637df9
// and every copied value went stale at once (ISS-1802)
// cm:edge contract -> packages/core/src/release-batch/blockers.ts — collectReleaseBlockers promises no
// outbound request and three callers rely on it; the probe read lives HERE so that promise holds
export async function readServingDeployment(projectId: string): Promise<ServingRead> {
  const report = await collectReleaseBlockers(projectId);
  if (!report.projectExists) return { ok: false, code: 'NO_PROJECT' };

  const channel: ReleaseChannel | null = report.channels?.[0] ?? null;
  const cfg = channel?.verify ?? null;
  if (!cfg || cfg.probes.length === 0) {
    return {
      ok: false,
      code: 'PROBES_UNDECLARED',
      detail:
        'this project declares no verify probe, so there is no deployment to read. Declare one on the live deploy binding, or in `environments.live.commitUrl`.',
    };
  }

  let state: LiveState;
  try {
    state = await readLiveState(cfg);
  } catch (err) {
    return {
      ok: false,
      code: 'PROBE_URL_INVALID',
      detail: `a declared probe url could not be read as a url: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    deployment: {
      identity: state.identity,
      health: state.health,
      readings: state.readings,
      unhealthy: state.unhealthy,
      unidentified: state.unidentified,
      disagreement: state.disagreement,
      readAt: new Date().toISOString(),
      verifySource: channel?.verifySource ?? 'none',
    },
  };
}
