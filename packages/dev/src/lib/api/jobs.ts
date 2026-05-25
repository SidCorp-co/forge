import { invoke } from "@/hooks/use-tauri-ipc";
import type { JobEventKind } from "@/lib/types";
import { getBaseUrl } from "./client";

export interface JobEventInput {
  kind: JobEventKind;
  data?: Record<string, unknown>;
  ts?: string;
}

// Job lifecycle endpoints in packages/core require device authentication
// (Authorization: Bearer <deviceToken>) — distinct from the user token
// that `request()` carries. Cache the token in module scope and reload on 401.
let cachedDeviceToken: string | null = null;

// Wipe the cached device token. The auth-store calls this on every login /
// logout / hydrate transition so a token paired with a previous coreUrl
// doesn't leak to a freshly-configured server.
export function clearDeviceTokenCache() {
  cachedDeviceToken = null;
}

// Back-compat alias for existing test imports.
export const _resetDeviceTokenCacheForTest = clearDeviceTokenCache;

async function deviceToken(): Promise<string> {
  if (cachedDeviceToken) return cachedDeviceToken;
  const tok = await invoke<string | null>("load_device_token");
  if (!tok) throw new Error("device token unavailable — pair the device first");
  cachedDeviceToken = tok;
  return tok;
}

async function deviceFetch(path: string, body: unknown): Promise<Response> {
  const tok = await deviceToken();
  const res = await fetch(`${getBaseUrl()}/api${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tok}`,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    cachedDeviceToken = null;
    throw new Error(`${path} 401 — device token rejected`);
  }
  if (!res.ok) {
    throw new Error(`${path} ${res.status} ${res.statusText}`);
  }
  return res;
}

const MAX_BATCH = 100;

export async function postJobEvents(jobId: string, events: JobEventInput[]): Promise<void> {
  if (events.length === 0) return;
  for (let i = 0; i < events.length; i += MAX_BATCH) {
    const chunk = events.slice(i, i + MAX_BATCH).map((e) => ({
      kind: e.kind,
      data: e.data ?? {},
      ...(e.ts ? { ts: e.ts } : {}),
    }));
    await deviceFetch(`/jobs/${jobId}/events`, { events: chunk });
  }
}

export async function completeJob(
  jobId: string,
  exitCode: number,
  opts?: { error?: string | null; summary?: string },
): Promise<void> {
  const body: Record<string, unknown> = { exitCode };
  if (opts?.error !== undefined) body.error = opts.error;
  if (opts?.summary !== undefined) body.summary = opts.summary;
  await deviceFetch(`/jobs/${jobId}/complete`, body);
}

export interface FailJobOpts {
  /** Stable identifier for the failure (e.g. `per_run_budget_exceeded`). */
  failureReason?: string;
  /** When set, the core dispatcher pins `classifierVersion=1` and the retry
   *  engine reads this directly — no re-classification. */
  failureKind?: "permanent" | "transient" | "unknown";
  /** Structured payload persisted to `jobs.failure_meta` (jsonb). */
  failureMeta?: Record<string, unknown>;
}

export async function failJob(
  jobId: string,
  error: string,
  opts?: FailJobOpts,
): Promise<void> {
  const body: Record<string, unknown> = { error };
  if (opts?.failureReason) body.failureReason = opts.failureReason;
  if (opts?.failureKind) body.failureKind = opts.failureKind;
  if (opts?.failureMeta) body.failureMeta = opts.failureMeta;
  await deviceFetch(`/jobs/${jobId}/fail`, body);
}
