// web-v2 feature module: runners/devices. Types verified against
// `packages/core/src/devices/routes.ts` (GET /me/devices) and
// `packages/core/src/devices/login-routes.ts` (POST /devices/login/init).
import type { HealthKey } from "@/design";

/** A row of `GET /api/me/devices` (owner-scoped). */
export interface DeviceRow {
  id: string;
  name: string;
  platform: "macos" | "linux" | "windows";
  agentVersion: string | null;
  status: "online" | "offline" | "revoked";
  lastSeenAt: string | null;
  pairedAt: string | null;
  capabilities: unknown;
  /** Non-secret label set when a git push credential was provisioned (ISS-305). */
  gitCredentialRef: string | null;
  createdAt: string;
}

/** `POST /api/devices/login/init` response — a fresh pairing code + verify URL. */
export interface PairingCode {
  pairing_code: string;
  /** Relative verify URL, e.g. `/pair?code=XXX-XXXX`. */
  verify_url: string;
  expires_at: string;
}

/** Map a device's online/offline/revoked status to a kit health key. */
export function deviceHealth(status: DeviceRow["status"]): HealthKey {
  switch (status) {
    case "online":
      return "healthy";
    case "revoked":
      return "down";
    default:
      return "idle";
  }
}
