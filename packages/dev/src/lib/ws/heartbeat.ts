import { invoke } from "@/hooks/use-tauri-ipc";
import { Sentry } from "@/lib/sentry";

export type DeviceHeartbeat = {
  /** Idempotent: starts the 25 s loop (pings immediately) if not running. */
  start: () => void;
  /** Stops the loop; safe to call when never started. */
  stop: () => void;
};

/**
 * Periodic heartbeat to keep device.status = 'online' on the core.
 * /api/devices/heartbeat is the only path that flips status; without
 * this loop the device stays 'offline' and dispatcher leaves jobs
 * queued. 25s interval is well under the stale-detector grace window.
 *
 * Tauri-path only — the ping goes through the `heartbeat` Tauri command, so
 * starting it in the browser fallback would only accumulate failures.
 */
export function createDeviceHeartbeat(coreUrl: string): DeviceHeartbeat {
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // Track repeated heartbeat failures so a one-off transient blip
  // doesn't spam Sentry but a stuck loop (device revoked, server down,
  // keychain wiped) lands as one event per minute instead of being
  // silently swallowed forever.
  let heartbeatFailStreak = 0;

  async function pingHeartbeat() {
    try {
      const tok = await invoke<string | null>("load_device_token");
      if (!tok || !coreUrl) return;
      await invoke("heartbeat", { coreUrl: coreUrl, deviceToken: tok });
      heartbeatFailStreak = 0;
    } catch (err) {
      heartbeatFailStreak += 1;
      const msg = err instanceof Error ? err.message : String(err);
      // First fail = breadcrumb only (likely transient); 3rd+ fail =
      // Sentry event so on-call sees the runner stop heartbeating.
      // 401 always escalates immediately — token is invalid, the
      // device is invisible to the dispatcher.
      const unauthorized = /UNAUTHORIZED|401/.test(msg);
      if (unauthorized || heartbeatFailStreak >= 3) {
        Sentry.captureException(err instanceof Error ? err : new Error(msg), {
          level: unauthorized ? "error" : "warning",
          tags: {
            area: "desktop-runner",
            phase: "heartbeat-loop",
            outcome: unauthorized ? "unauthorized" : "transient-streak",
          },
          extra: { failStreak: heartbeatFailStreak, coreUrl },
        });
      }
    }
  }

  function start() {
    if (heartbeatTimer) return;
    void pingHeartbeat();
    heartbeatTimer = setInterval(() => void pingHeartbeat(), 25_000);
  }

  function stop() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  return { start, stop };
}
