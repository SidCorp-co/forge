import type { ContractStandingDetail, ContractStandingRow } from "../types";

const project = (slug: string) => ({ id: `id-${slug}`, slug, name: slug });

export const row = (slug: string, over: Partial<ContractStandingRow> = {}): ContractStandingRow => ({
  ref: `hop/${slug}`,
  slug,
  provider: project("hop"),
  direction: "provided",
  title: `${slug} title`,
  summary: null,
  kind: "graphql",
  lifecycle: "production",
  current: { version: "1.6.0", recordedAt: "2026-09-12T00:00:00.000Z", classification: "non-breaking", approval: "approved", decidedAt: "2026-09-12T00:00:00.000Z" },
  pending: null,
  ours: "1.6.0",
  window: null,
  noticeDays: 30,
  consumers: { total: 1, current: 1, behind: 0 },
  waits: 0,
  openRequests: 0,
  state: "published",
  attentionGroup: "steady",
  waitingOn: { kind: "none", who: "Nobody", act: "every consumer is on 1.6.0", rule: "providedTurn: nothing is owed", ref: null },
  touchedAt: "2026-09-12T00:00:00.000Z",
  ...over,
});

export const breaking = row("discharge-summary", {
  state: "breaking_pending",
  attentionGroup: "waiting",
  current: { version: "2.0.0", recordedAt: "2026-10-01T00:00:00.000Z", classification: "breaking", approval: "approved", decidedAt: "2026-10-01T00:00:00.000Z" },
  ours: "2.0.0",
  window: { version: "2.0.0", dueAt: "2099-10-09T14:00:00.000Z", open: true },
  consumers: { total: 2, current: 1, behind: 1 },
  waitingOn: { kind: "project", who: "clinic-crm", act: "adopt 2.0.0 by 2099-10-09", rule: "providedTurn: a consumer owes", ref: "2.0.0" },
});

export const consumedYou = row("book-follow-up", {
  ref: "bookings/book-follow-up",
  provider: project("bookings"),
  direction: "consumed",
  title: "Book a follow-up visit in bookings",
  state: "breaking_pending",
  attentionGroup: "needs_you",
  current: { version: "2.0.0", recordedAt: "2026-10-02T00:00:00.000Z", classification: "breaking", approval: "approved", decidedAt: "2026-10-02T00:00:00.000Z" },
  ours: "1.4.0",
  window: { version: "2.0.0", dueAt: "2099-11-02T00:00:00.000Z", open: true },
  consumers: { total: 2, current: 0, behind: 2 },
  waits: 1,
  waitingOn: { kind: "you", who: "You", act: "adapt to 2.0.0 by 2099-11-02", rule: "consumedTurn: open breaking item", ref: "FB-37" },
});

export const detailOf = (r: ContractStandingRow, over: Partial<ContractStandingDetail> = {}): ContractStandingDetail => ({
  generatedAt: "2026-10-04T00:00:00.000Z",
  project: project("hop"),
  contract: r,
  versions: [
    { version: "2.0.0", recordedAt: "2026-10-02T00:00:00.000Z", classification: "breaking", approval: "approved", decidedAt: "2026-10-02T00:00:00.000Z", previous: "1.4.0", changes: [{ element: "Mutation.bookFollowUp.slotHint", kind: "removed", level: "breaking", text: "slotHint is removed" }], decisionReason: null },
    { version: "1.4.0", recordedAt: "2026-08-12T00:00:00.000Z", classification: "non-breaking", approval: "approved", decidedAt: "2026-08-12T00:00:00.000Z", previous: null, changes: [], decisionReason: null },
  ],
  consumers: [
    { project: project("hop"), builtAgainst: "1.4.0", adoption: "owes", self: true },
    { project: project("clinic-crm"), builtAgainst: "1.3.0", adoption: "owes", self: false },
  ],
  waits: [{ issue: "ISS-1402", title: "Publish contract to Autoflow", status: "in_progress", minVersion: "2.0.0", reason: "rollback", settled: false }],
  demand: [],
  requests: [
    {
      number: "HOP-CR-3",
      direction: "outgoing",
      counterpart: project("bookings"),
      requirement: { key: "REQ-31", title: "Version 2 with rollbackTo", status: "agreed", project: "bookings" },
      open: false,
      createdAt: "2026-09-30T00:00:00.000Z",
    },
  ],
  feedback: [{ key: "FB-37", title: "bookings/book-follow-up 2.0.0 is breaking", status: "new", version: "2.0.0", dueAt: "2099-11-02T00:00:00.000Z" }],
  measurements: null,
  module: { available: false, reason: "the interface document names no module for a publication" },
  ...over,
});
