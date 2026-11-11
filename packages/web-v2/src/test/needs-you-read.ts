// A project's Needs you read as core serves it (`GET /projects/:id/needs-you`), each area's count the
// rail badge and an overview's Waiting on you figure read (ISS-1198), every other part empty.

import { NEEDS_YOU_AREAS, type NeedsYouAreaKey, type NeedsYouResponse } from "@forge/contracts/needs-you";

export function needsYouRead(you: Partial<Record<NeedsYouAreaKey, number>> = {}): NeedsYouResponse {
  return {
    generatedAt: "2026-11-11T00:00:00.000Z",
    areas: Object.fromEntries(NEEDS_YOU_AREAS.map((a) => [a, { you: you[a] ?? 0, acts: [] }])) as NeedsYouResponse["areas"],
    items: [],
    requirementsInDelivery: 0,
    untriagedFeedback: 0,
    decisions: 0,
  };
}
