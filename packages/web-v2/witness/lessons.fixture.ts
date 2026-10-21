// What a project that has been learning for a month holds (REQ-50): one confusion an agent raised,
// a proposal the steward grouped from two corrections, two lessons in use (one proposed for
// retirement, one that became a check after a repeat), a retired one, corrections still waiting,
// the month's read, and one chat's marks. Shared by the lessons witnesses.

import type { ChatLessonMarks, CorrectionView, LessonView, LessonsMonthView, LessonsResponse } from "@forge/contracts/lessons";

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
const ANA = { id: "u1", name: "Ana Pereira" };
const STEWARD = { id: "u9", name: "Steward" };

const correction = (id: string, reason: string, over: Partial<CorrectionView> = {}): CorrectionView => ({
  id,
  source: "suggestion_rejected",
  item: { kind: "suggestion", id: `s-${id}`, key: "REQ-12", title: "Discharge letters" },
  reason,
  by: ANA,
  agency: "human",
  at: ago(30),
  lessonKey: null,
  score: null,
  dismissed: false,
  ...over,
});

const can = (over: Partial<LessonView["can"]> = {}): LessonView["can"] => ({ approve: false, reject: false, edit: false, retire: false, keep: false, ...over });

const lesson = (n: number, sentence: string, over: Partial<LessonView>): LessonView => ({
  id: `l${n}`,
  key: `L-${n}`,
  number: n,
  sentence,
  scope: { kind: "project", areaId: null, areaName: null, itemKind: null },
  status: "approved",
  proposedBy: STEWARD,
  proposedAt: ago(400),
  approvedAt: ago(390),
  reason: null,
  corrections: [],
  repeats: 0,
  appliedCount: 0,
  lastAppliedAt: null,
  retire: null,
  supersedes: null,
  supersededBy: null,
  checkIssueKey: null,
  confusions: [],
  applications: [],
  can: can(),
  ...over,
});

const CONFUSION = {
  id: "cf1",
  lessonKey: "L-4",
  kind: "conflict" as const,
  other: { lessonKey: "L-2", ref: null },
  sides: {
    lesson: "Large type asks for 16 pt in every patient letter.",
    other: "The house style sets every letter in 11 pt, and the print template cannot hold two sizes.",
  },
  recommended: { resolution: "edit" as const, sentence: "Print patient letters in 16 pt; keep the house style for every other letter." },
  raisedBy: STEWARD,
  raisedAgency: "agent" as const,
  raisedAt: ago(5),
  decidedBy: null,
  decidedAt: null,
  resolution: null,
};

export const LESSONS: LessonsResponse = {
  canDecide: true,
  confusions: [CONFUSION],
  corrections: [
    correction("c7", "The ward list is sorted by name again; nurses read it by floor.", { source: "chat", item: { kind: "conversation", id: "cv1", key: "Chat", title: null }, score: 0.82 }),
    correction("c8", "The mockup drops the bed number from the handover card.", { source: "mockup_returned", item: { kind: "mockup", id: "m1", key: "MK-3", title: "Handover" }, at: ago(50) }),
  ],
  lessons: [
    lesson(5, "Name the ward and the bed in every handover a nurse reads.", {
      status: "proposed",
      approvedAt: null,
      corrections: [
        correction("c1", "The handover has no bed number.", { at: ago(60) }),
        correction("c2", "Which bed? The handover only says the ward.", { source: "verdict_failed", item: { kind: "issue", id: "i1", key: "ISS-88", title: "Handover screen" } }),
      ],
      can: can({ approve: true, reject: true, edit: true }),
    }),
    lesson(2, "Show the ward on the wristband print.", {
      appliedCount: 14,
      lastAppliedAt: ago(20),
      repeats: 1,
      checkIssueKey: "ISS-91",
      corrections: [correction("c3", "The wristband has no ward."), correction("c4", "Ward missing on the band again.", { at: ago(100) })],
      applications: [
        { id: "a1", lessonKey: "L-2", output: { kind: "chat_message", ref: "b6f1c2d0-0000" }, agent: STEWARD, at: ago(20), wrong: null },
        { id: "a2", lessonKey: "L-2", output: { kind: "issue", ref: "ISS-87" }, agent: STEWARD, at: ago(70), wrong: { by: ANA, at: ago(60), reason: "ISS-87 is the visitor badge, not a wristband." } },
      ],
      can: can({ edit: true, retire: true }),
    }),
    lesson(4, "Print patient letters in large type.", { status: "held", appliedCount: 3, lastAppliedAt: ago(48), corrections: [correction("c5", "Patients cannot read 11 pt.")], can: can({ retire: true }) }),
    lesson(3, "Greet the patient by first name in the portal.", {
      appliedCount: 2,
      lastAppliedAt: ago(800),
      retire: { reason: "unused", at: ago(2) },
      scope: { kind: "item_kind", areaId: null, areaName: null, itemKind: "requirement" },
      corrections: [correction("c6", "Use the first name.")],
      can: can({ edit: true, retire: true, keep: true }),
    }),
    lesson(1, "Sort wards alphabetically.", { status: "retired", reason: "Superseded by L-6: wards are read by floor.", can: can() }),
  ],
};

export const MONTH: LessonsMonthView = {
  month: "2026-10",
  corrections: { total: 23, bySource: { mockup_returned: 4, mockup_accepted: 1, suggestion_rejected: 9, design_returned: 2, revision_returned: 3, verdict_failed: 2, chat: 2 } },
  lessonsApproved: 3,
  repeats: 1,
  confusions: {
    raised: 2,
    decided: 1,
    open: 1,
    items: [
      { id: "cf0", lessonKey: "L-2", kind: "wrongly_applied", raisedAt: ago(60), decidedAt: ago(56), hours: 4 },
      { id: "cf1", lessonKey: "L-4", kind: "conflict", raisedAt: ago(5), decidedAt: null, hours: 5 },
    ],
  },
};

export const MARKS: ChatLessonMarks = {
  corrections: [{ id: "c7", messageId: "m-person", reason: "The ward list is sorted by name again; nurses read it by floor.", dismissed: false }],
  applied: [
    { id: "a1", messageId: "m-answer", lessonKey: "L-2", wrong: false },
    { id: "a3", messageId: "m-answer", lessonKey: "L-3", wrong: false },
  ],
};

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** Core as the lessons surfaces read it; any write stays pending, so a shot shows the state it acted on. */
export function stubLessonsCore(): void {
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://forge.test");
    if (init?.method && init.method !== "GET") return new Promise<Response>(() => {});
    if (url.pathname.endsWith("/lessons")) return json(LESSONS);
    if (url.pathname.endsWith("/lessons/month")) return json(MONTH);
    if (url.pathname.includes("/lessons/chat/")) return json(MARKS);
    return new Promise<Response>(() => {});
  };
}
