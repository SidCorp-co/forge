import { collectReleaseBlockers } from './blockers.js';
import { type CloseVerification, closeVerification, refusedVerifyBindings } from './channel.js';
import { isRefusal } from '../lib/refusal.js';
import type { VerifySource } from './plan.js';
import { readLiveState } from './verify.js';

export interface ServingDeployment {
  /** False where production declares no source probe: nothing was read, and nothing is claimed. */
  verified: boolean;
  identity: string | null;
  /** `unknown` only where nothing was read — never a quiet `up` (ISS-1321). */
  health: 'up' | 'down' | 'unknown';
  readings: string[];
  unhealthy: string[];
  unidentified: string[];
  disagreement: string[] | null;
  readAt: string;
  verifySource: VerifySource;
}

export type ServingRead =
  | { ok: true; deployment: ServingDeployment }
  | { ok: false; code: 'NO_PROJECT' }
  | { ok: false; code: 'RELEASE_PROBES_UNREADABLE'; detail: string };

// cm:guard the identity is DERIVED on every call and never stored — a commit copied onto a row is
// wrong the moment the next deploy lands, measured on forge-dev when prod moved ae8cdcbb0 -> 592637df9
// and every copied value went stale at once (ISS-1802)
// cm:edge contract -> packages/core/src/release-batch/blockers.ts — collectReleaseBlockers promises no
// outbound request and three callers rely on it; the probe read lives HERE so that promise holds
export async function readServingDeployment(projectId: string): Promise<ServingRead> {
  const report = await collectReleaseBlockers(projectId);
  if (!report.projectExists) return { ok: false, code: 'NO_PROJECT' };

  const channels = report.channels ?? [];
  let verification: CloseVerification;
  try {
    verification = closeVerification(channels);
  } catch (err) {
    if (!isRefusal(err, 'RELEASE_PROBES_UNREADABLE')) throw err;
    return {
      ok: false,
      code: 'RELEASE_PROBES_UNREADABLE',
      detail: `${refusedVerifyBindings(channels).join(', ')} declares only runtime probes that identify an artifact, and a release proves the commit it shipped. Declare a probe with \`identifies: "source"\` on the production environment, or remove them.`,
    };
  }
  if (verification.kind === 'unverified') {
    return {
      ok: true,
      deployment: {
        verified: false,
        identity: null,
        health: 'unknown',
        readings: [],
        unhealthy: [],
        unidentified: [],
        disagreement: null,
        readAt: new Date().toISOString(),
        verifySource: channels[0]?.verifySource ?? 'none',
      },
    };
  }

  const { cfg } = verification;
  const channel = channels.find((c) => c.verify === cfg);
  const state = await readLiveState(cfg);

  return {
    ok: true,
    deployment: {
      verified: true,
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
