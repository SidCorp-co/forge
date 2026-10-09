// Test fixtures: a preview as core answers it, parsed by the contract's own schema so a fixture that
// drifts from `previewRecordSchema` fails here rather than drawing a shape core never sends.

import { type PreviewRecord, previewRecordSchema } from "@forge/contracts/preview";

export const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
export const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
export const PREVIEW_ID = "33333333-3333-4333-8333-333333333333";
export const HOST = "https://p-abcdefghijklmnop.preview.localhost:8443/";

export function previewOf(over: Partial<PreviewRecord> = {}): PreviewRecord {
  return previewRecordSchema.parse({
    id: PREVIEW_ID,
    projectId: PROJECT_ID,
    issueId: ISSUE_ID,
    sessionId: "44444444-4444-4444-8444-444444444444",
    deviceId: "55555555-5555-4555-8555-555555555555",
    url: HOST,
    state: "live",
    reason: null,
    detail: null,
    command: "pnpm run dev -- --port {port}",
    port: 3100,
    idleMinutes: 30,
    approvedPatchId: null,
    approvedBy: null,
    createdBy: "66666666-6666-4666-8666-666666666666",
    createdAt: "2026-10-09T10:00:00.000Z",
    liveAt: "2026-10-09T10:00:05.000Z",
    lastViewedAt: null,
    closedAt: null,
    ...over,
  });
}
