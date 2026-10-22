// The steward's acts and questions in each item's Activity, witnessed as drawn (REQ-48 BC-12): on a
// requirement, a feedback item and an issue, every act the steward took says what it did, with Undo
// for a project writer where a door undoes it, how to override it where none does, or Undone; and a
// question the steward asked says "Asked by Steward". The issue is the draft the steward asked about,
// its question answered "keep", so its standing still asks a person to take it on or drop it and no
// question is open. Every read is answered, so each shot is of a settled page; at 390 px nothing
// scrolls sideways.
//
//   pnpm --filter web-v2 witness witness/steward-acts.witness.tsx --out <dir>

import { issueMovesFrom } from "@forge/contracts/issue-machine";
import type { QueryKey } from "@tanstack/react-query";
import { STEWARD_DECISION_OPTION_IDS, type StewardActRecord, stewardDecisionLabel } from "@forge/contracts/steward";
import { FeedbackItemScreen } from "@/features/feedback";
import { IssueDetailScreen } from "@/features/issues/components/issue-detail-screen";
import { RequirementScreen } from "@/features/requirements/components/requirement-screen";
import { say, waitingOn } from "@/test/said";
import { detailQueries } from "@/test/vi-chrome-issues";
import { Seeded } from "@/test/vi-chrome-requirements";
import { FP, fbSeeds, has, ISSUE_CRITERIA, lacks, mountSurfaces, REQ_PROJECT, reqSeeds, type Surface } from "./steward.fixture";

const AT = "2026-10-21T08:00:00.000Z";

const act = (id: string, did: string, over: Partial<StewardActRecord> = {}): StewardActRecord =>
  ({
    id,
    runId: "r1",
    door: "POST /api/questions",
    did,
    says: { did: { text: did } },
    wrote: null,
    undo: null,
    override: null,
    undoneAt: null,
    undoneBy: null,
    at: AT,
    ...over,
  }) as unknown as StewardActRecord;

const ACTS: StewardActRecord[] = [
  act("a1", "Asked the owner whether to keep the draft or drop it.", { undo: { door: "POST /api/questions/q1/void", body: null }, at: "2026-10-21T08:30:00.000Z" }),
  act("a2", "Wrote the note: ISS-498 was sent back on 14 Oct and no master serves forge-dev.", {
    door: "PUT /api/projects/p/steward-notes/requirement/REQ-1",
    override: "Write the note yourself; yours replaces it.",
    at: "2026-10-21T08:20:00.000Z",
  }),
  act("a3", "Commented on the item with the stuck cause.", { door: "POST /api/issues/i1/comments", undo: { door: "DELETE /api/comments/c1", body: null }, undoneAt: "2026-10-21T09:00:00.000Z", undoneBy: "u1" }),
];

const ISS_1 = { kind: "issue" as const, draft: true };
const KEEP = { id: STEWARD_DECISION_OPTION_IDS.keep, label: stewardDecisionLabel("keep", ISS_1) };
const DROP = { id: STEWARD_DECISION_OPTION_IDS.drop, label: stewardDecisionLabel("drop", ISS_1) };
const QUESTION = {
  id: "q1",
  projectId: "p1",
  issueId: "i1",
  status: "answered",
  blockerKind: "human",
  steps: [
    {
      round: 1,
      prompt: "ISS-1 has been a draft for 16 days. Keep it as a draft, or drop it?",
      askedAt: AT,
      answerShape: "choice",
      options: [KEEP, DROP].map((o) => ({ ...o, authority: "writer", bindsTo: "this_call", executedBy: "core" })),
      recommendedOptionId: KEEP.id,
      chosenOptionId: KEEP.id,
      answeredAt: "2026-10-21T08:40:00.000Z",
      answeredBy: "u1",
    },
  ],
  round: 1,
  prompt: "ISS-1 has been a draft for 16 days. Keep it as a draft, or drop it?",
  askedAt: AT,
  maxRounds: 3,
  voidReason: null,
  endedReason: null,
  parkDeadlineAt: null,
  createdAt: AT,
  updatedAt: AT,
  answerShape: "choice",
  options: [],
  recommendedOptionId: KEEP.id,
  needed: "",
  locked: false,
  asker: { id: "s1", name: "Steward", kind: "agent" },
};

// the fixture's core answers every read it seeds; the steward's acts, the issue's questions and the
// viewer's projects (a member of each, so Undo is offered) are answered here, over it
const fixtureFetch = window.fetch;
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://forge.test");
  const path = url.pathname.replace(/^\/api/, "");
  if (/^\/projects\/[^/]+\/steward-acts$/.test(path)) return json({ acts: ACTS });
  if (path === "/questions" && url.searchParams.get("issueId")) return json({ questions: [QUESTION] });
  if (path === "/projects") return json([REQ_PROJECT, FP, "p1"].map((id) => ({ id, slug: "hop", name: "Hop", orgId: null, orgRole: null, role: "member" })));
  return fixtureFetch(input, init);
};

const buttons = () => [...document.querySelectorAll<HTMLElement>("[data-witness=page] button, [data-witness=page] [role=tab]")];

/** Open the Activity tab, then the fold whose trigger reads `fold` where one is named, each once. */
const openActivity = (fold?: string) => () => {
  const tab = buttons().find((b) => b.textContent?.trim() === "Activity");
  if (tab && tab.getAttribute("aria-selected") !== "true") tab.click();
  if (!fold) return;
  setTimeout(() => {
    const trigger = buttons().find((b) => b.textContent?.startsWith(fold));
    if (trigger && !trigger.hasAttribute("data-panel-open")) trigger.click();
  }, 200);
};

const actsDrawn = (): string[] => [
  ...has("an act", "Asked the owner whether to keep the draft or drop it."),
  ...has("an override", "Override: Write the note yourself; yours replaces it."),
  ...has("an undone act", "Undone"),
  ...(document.querySelectorAll("[data-testid=steward-act-undo]").length === 1 ? [] : ["exactly one act offers Undo"]),
];

/**
 * The issue page's reads with ISS-1 the draft the steward asked about: the question answered "keep",
 * so the draft still waits on a person to take it on or drop it (core's `issues/standing.ts`
 * `personTurn` for a draft), with nothing parked, blocked, merged, running or waiting for a release,
 * and none of its criteria judged.
 */
const draftIssueQueries = (): [QueryKey, unknown][] =>
  detailQueries().map(([k, v]): [QueryKey, unknown] => {
    if (k[0] === "issue" && k[1] === "i1" && (k.length === 2 || k[2] === FP)) {
      const { mergeMark: _m, pipelineHealth: _p, ...issue } = v as Record<string, unknown>;
      return [k, { ...issue, status: "draft", agentStatus: null, agentSessions: [], workState: null, waitingOnPersonSince: null, mergedAt: null, landingShape: null, liveReach: null, shippedIn: null, releaseNotes: null }];
    }
    if (k[0] === "issue" && k[2] === "criteria") return [k, { criteria: ISSUE_CRITERIA, retired: [] }];
    if (k[0] === "release-roster") return [k, { ...(v as object), issues: [] }];
    if (k[0] === "issues" && k[1] === "standing") {
      const d = v as { standing: Record<string, unknown> };
      return [
        k,
        {
          ...d,
          status: "draft",
          blocker: null,
          steps: [],
          stepOutcomes: [],
          standing: {
            ...d.standing,
            state: "draft",
            step: null,
            stepStartedAt: null,
            moves: issueMovesFrom("draft", null, false),
            tone: "you",
            attentionGroup: "needs_you",
            waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("issues.standing.act.takeOnOrDrop"), rule: say("issues.rule.draft") }),
            criteria: { total: ISSUE_CRITERIA.length, met: 0, failing: 0, skipped: 0 },
            blocks: [],
            lease: null,
            inFlight: false,
            branch: null,
            headSha: null,
          },
        },
      ];
    }
    return [k, v];
  });

const SURFACES: Surface[] = [
  {
    name: "requirement-activity",
    path: "/projects/hop/requirements/REQ-1",
    render: () => (
      <Seeded data={reqSeeds()}>
        <RequirementScreen projectId={REQ_PROJECT} slug="hop" reqKey="REQ-1" />
      </Seeded>
    ),
    open: openActivity("Steward's acts"),
    check: actsDrawn,
  },
  {
    name: "feedback-activity",
    path: "/projects/hop/feedback/FB-2",
    render: () => (
      <Seeded data={fbSeeds()}>
        <FeedbackItemScreen projectId={FP} slug="hop" fbKey="FB-2" />
      </Seeded>
    ),
    open: openActivity(),
    check: actsDrawn,
  },
  {
    name: "issue-activity",
    path: "/projects/hop/issues/ISS-1",
    render: () => (
      <Seeded data={draftIssueQueries()}>
        <IssueDetailScreen projectId={FP} slug="hop" id="i1" />
      </Seeded>
    ),
    open: () => document.querySelector<HTMLElement>("[data-testid=details-activity] > button:not([data-panel-open])")?.click(),
    check: () => [
      ...actsDrawn(),
      ...has("the question", "Asked by Steward"),
      ...has("the draft's standing", "take on or drop"),
      ...lacks("a question owed where none is open", "No questions"),
    ],
  },
];

mountSurfaces(SURFACES);
