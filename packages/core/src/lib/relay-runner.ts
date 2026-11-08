/**
 * The first forge-runner version that moves a checkout's origin to Forge's git relay (REQ-73 BC-5),
 * and whether a reported version is at or past it. Read by the git credential door
 * (`integrations/source-host/host-credential.ts`) and by the heartbeat, which latches a device that
 * reported one (`devices.relay_runner_at`, ISS-685).
 */
export const PRE_RELAY_RUNNER_AMNESTY = '0.18.0';

/** Whether a device's reported runner version (`a.b.c`) is at or past the relay; none is not. */
export function relayCapableRunner(version: string | null | undefined): boolean {
  const got = /^(\d+)\.(\d+)\.(\d+)$/.exec(version?.trim() ?? '');
  if (!got) return false;
  const floor = PRE_RELAY_RUNNER_AMNESTY.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = Number(got[i + 1]) - (floor[i] as number);
    if (d !== 0) return d > 0;
  }
  return true;
}
