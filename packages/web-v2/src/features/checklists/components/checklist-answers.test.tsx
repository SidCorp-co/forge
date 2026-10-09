// REQ-34 r2 BC-5, BC-9, BC-26 on the pages (ISS-457 criteria 1 and 3): a requirement and a feedback
// item show their checklist answers as properties, each with where it came from, and each gap as the
// question still to answer beside where it is answered; an assumed answer stays visible as one, and a
// later revision that answers it reads as the correction. Every question and gap here is the one the
// contract derives, read the way core serves it, so nothing in the page restates a question.
//
// @direct-test-of packages/web-v2/src/features/checklists/components/checklist-answers.tsx
// @direct-test-of packages/web-v2/src/features/checklists/components/item-checklists.tsx
// @direct-test-of packages/web-v2/src/features/checklists/hooks.ts

import {
  FEEDBACK_TRIAGE_CHECKLIST,
  REQUIREMENT_ACCEPTANCE_CHECKLIST,
  REQUIREMENT_READY_CHECKLIST,
} from "@forge/contracts/checklist-registry";
import type { ChecklistMove, ChecklistRead } from "@forge/contracts/checklist-read";
import {
  type Checklist,
  type ChecklistAnswer,
  checklistFormOf,
  evaluateChecklist,
  type RecordAnswers,
} from "@forge/contracts/checklists";
import { QueryClient } from "@tanstack/react-query";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequirementPage } from "@/features/requirements/components/requirement-detail";
import { type Call, fakeCore, HANG, renderWithQuery } from "@/test/render";
import { feedbackDetail } from "@/test/vi-chrome-feedback";
import { reqDetail } from "@/test/vi-chrome-requirements";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/projects/hop/requirements/REQ-1", useParams: () => ({ slug: "hop" }) }));

afterEach(() => vi.unstubAllGlobals());

const PROJECT = "7f1c1d1e-0000-4000-8000-000000000001";
const AT = "2026-10-09T10:00:00.000Z";

/** A record reader's answers, as core's reader gives them: these values, and a gap on the rest. */
function record(checklist: Checklist, values: Record<string, string>): RecordAnswers {
  return Object.fromEntries(
    checklist.questions
      .filter((q) => q.answeredBy.by === "record")
      .map((q) => [q.id, values[q.id] !== undefined ? { value: values[q.id] as string } : { gap: `It has none for ${q.id}.`, fix: "Write one." }]),
  );
}

function readOf(checklist: Checklist, now: RecordAnswers | null, moves: ChecklistMove[] = []): ChecklistRead {
  return {
    id: checklist.id,
    version: checklist.version,
    gates: checklist.gates,
    design: checklist.design,
    form: checklistFormOf(checklist),
    input: {},
    now: now ? evaluateChecklist(checklist, { given: {}, record: now }) : null,
    moves,
  };
}

const passed = (answers: ChecklistAnswer[], standing: ChecklistMove["standing"] = "passed"): ChecklistMove => ({
  at: AT,
  from: "draft",
  to: "agreed",
  gate: "requirement_ready",
  standing,
  checklist: standing === "passed" ? { id: "requirement_ready", version: 1 } : null,
  answers: standing === "passed" ? answers : null,
  refusals: null,
  actor: { type: "user", agency: "human", id: "u1" },
  source: "requirements",
  countsAsPassed: standing === "passed",
});

const READY_GIVEN = { problem: "Clinics lose the filter.", value: "They find a patient at once.", measured: "Fewer searches.", criteria: "1 criterion: BC-1", questions: "None open." };
const label = (checklist: Checklist, question: string) => checklistFormOf(checklist).fields.find((f) => f.name === question)?.label as string;

function requirementPage(reads: ChecklistRead[], revision: number | null, onTab = vi.fn()) {
  fakeCore((c: Call) => {
    if (c.path === `/projects/${PROJECT}/requirements/REQ-1/checklist`) return { body: { requirementId: "r1", key: "REQ-1", revision, checklists: reads } };
    return HANG;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(["requirement", PROJECT, "REQ-1"], reqDetail);
  renderWithQuery(<RequirementPage projectId={PROJECT} slug="hop" reqKey="REQ-1" tab="overview" onTab={onTab} />, client);
  return onTab;
}

const row = (section: HTMLElement, question: string) => within(section).getAllByTestId("checklist-row").find((r) => r.dataset.question === question) as HTMLElement;

describe("a requirement's checklists on its page", () => {
  it("shows each answer as a property with its source, each gap as a question beside where it is answered, and an unreached checklist not at all", async () => {
    const onTab = requirementPage([readOf(REQUIREMENT_READY_CHECKLIST, record(REQUIREMENT_READY_CHECKLIST, READY_GIVEN)), readOf(REQUIREMENT_ACCEPTANCE_CHECKLIST, null)], 1);
    const section = await screen.findByTestId("checklist");
    expect(section.dataset.checklist).toBe("requirement_ready");
    expect(section).toHaveTextContent("Requirement ready");
    expect(section).toHaveTextContent("2 open");

    const criteria = row(section, "criteria");
    expect(criteria.dataset.state).toBe("given");
    expect(criteria).toHaveTextContent(label(REQUIREMENT_READY_CHECKLIST, "criteria"));
    expect(criteria).toHaveTextContent("1 criterion: BC-1");
    expect(criteria).toHaveTextContent("From its business criteria");

    const who = row(section, "who");
    expect(who.dataset.state).toBe("gap");
    expect(within(who).getByTestId("checklist-gap")).toHaveTextContent("It has none for who. Write one.");
    expect(within(who).getByTestId("checklist-gap").textContent).not.toContain(label(REQUIREMENT_READY_CHECKLIST, "who"));
    await userEvent.setup().click(within(who).getByRole("button", { name: "Answer" }));
    expect(onTab).toHaveBeenCalledWith("revisions");
    // linking a workflow is not a revision, so no revision act stands beside its gap
    expect(within(row(section, "workflows")).queryByRole("button", { name: "Answer" })).toBeNull();

    const kind = row(section, "kind");
    expect(kind.dataset.state).toBe("assumed");
    expect(kind).toHaveTextContent("Not stated.");
    expect(kind).toHaveTextContent("Assumed");
    expect(kind).toHaveTextContent("Recommended answer");

    expect(screen.getAllByTestId("checklist")).toHaveLength(1);
  });

  it("keeps the agree's assumed answer visible, and reads the revision that answered it as the correction", async () => {
    const atAgree = evaluateChecklist(REQUIREMENT_READY_CHECKLIST, { given: {}, record: record(REQUIREMENT_READY_CHECKLIST, { ...READY_GIVEN, who: "Clinic clerk", workflows: "referral revision 2" }) });
    requirementPage(
      [
        readOf(REQUIREMENT_READY_CHECKLIST, record(REQUIREMENT_READY_CHECKLIST, { ...READY_GIVEN, who: "Clinic clerk", workflows: "referral revision 2", kind: "rule" }), [passed([...atAgree.answers])]),
        readOf(REQUIREMENT_ACCEPTANCE_CHECKLIST, record(REQUIREMENT_ACCEPTANCE_CHECKLIST, { verdicts: "Every current criterion passes.", evidence: "Each counted verdict cites its evidence." })),
      ],
      2,
    );
    const [ready, acceptance] = await screen.findAllByTestId("checklist");
    expect(ready?.dataset.standing).toBe("passed");
    expect(ready).toHaveTextContent("Passed");
    const kind = row(ready as HTMLElement, "kind");
    expect(kind.dataset.state).toBe("corrected");
    expect(kind).toHaveTextContent("Not stated.");
    expect(kind).toHaveTextContent("Assumed");
    expect(within(kind).getByTestId("checklist-correction")).toHaveTextContent("Corrected");
    expect(within(kind).getByTestId("checklist-correction")).toHaveTextContent("Now, from r2");
    expect(within(kind).getByTestId("checklist-correction")).toHaveTextContent("rule");
    // an assumed answer nothing has answered since stays as the move recorded it
    expect(row(ready as HTMLElement, "outOfScope").dataset.state).toBe("assumed");

    expect(acceptance?.dataset.checklist).toBe("requirement_acceptance");
    expect(acceptance).toHaveTextContent("1 open");
    expect(row(acceptance as HTMLElement, "shipped").dataset.state).toBe("gap");
  });

  it('reads "No checklist" where the agree was recorded before the checklist (BC-9)', async () => {
    requirementPage([readOf(REQUIREMENT_READY_CHECKLIST, record(REQUIREMENT_READY_CHECKLIST, READY_GIVEN), [passed([], "no_checklist")]), readOf(REQUIREMENT_ACCEPTANCE_CHECKLIST, null)], 1);
    const section = await screen.findByTestId("checklist");
    expect(section.dataset.standing).toBe("no_checklist");
    expect(section).toHaveTextContent("No checklist");
  });
});

describe("a feedback item's triage checklist on its page", () => {
  function feedbackPage(read: ChecklistRead) {
    const calls = fakeCore((c: Call) => {
      if (c.path === "/projects/p1/feedback/FB-2/checklist") return { body: { feedbackId: "f2", key: "FB-2", checklists: [read] } };
      return HANG;
    });
    renderWithQuery(feedbackDetail());
    return calls;
  }

  it("shows what the item's record answers, and each question the triage still answers, pointing at the triage form", async () => {
    feedbackPage(readOf(FEEDBACK_TRIAGE_CHECKLIST, record(FEEDBACK_TRIAGE_CHECKLIST, { kind: "bug", requirement: "REQ-1" })));
    const section = await screen.findByTestId("checklist");
    expect(section).toHaveTextContent("Feedback triage");
    const kind = row(section, "kind");
    expect(kind.dataset.state).toBe("given");
    const bug = checklistFormOf(FEEDBACK_TRIAGE_CHECKLIST).fields.find((f) => f.name === "kind")?.options.find((o) => o.value === "bug")?.label as string;
    expect(kind).toHaveTextContent(bug);
    const severity = row(section, "severity");
    expect(severity.dataset.state).toBe("gap");
    expect(within(severity).getByRole("link", { name: "Answer" })).toHaveAttribute("href", "#feedback-act");
  });

  it("once triaged, shows the answers the triage was judged by, each choice by its label", async () => {
    const answers: ChecklistAnswer[] = [
      { question: "kind", value: "bug", provenance: "given", source: "record:kind" },
      { question: "requirement", value: "REQ-1", provenance: "given", source: "record:requirementId" },
      { question: "criterion", value: "REQ-1 BC-2", provenance: "given", source: "mover" },
      { question: "severity", value: "high", provenance: "given", source: "mover" },
      { question: "reproduced", value: "Twice on the staging board.", provenance: "given", source: "mover" },
      { question: "route", value: "issue", provenance: "given", source: "mover" },
    ];
    feedbackPage(readOf(FEEDBACK_TRIAGE_CHECKLIST, record(FEEDBACK_TRIAGE_CHECKLIST, { kind: "bug", requirement: "REQ-1" }), [{ ...passed(answers), from: "new", to: "triaged", gate: "feedback_triage" }]));
    const section = await screen.findByTestId("checklist");
    expect(section.dataset.standing).toBe("passed");
    expect(within(section).queryAllByTestId("checklist-gap")).toEqual([]);
    const high = checklistFormOf(FEEDBACK_TRIAGE_CHECKLIST).fields.find((f) => f.name === "severity")?.options.find((o) => o.value === "high")?.label as string;
    expect(row(section, "severity")).toHaveTextContent(high);
    expect(row(section, "severity")).toHaveTextContent("Given in the move");
    expect(row(section, "reproduced")).toHaveTextContent("Twice on the staging board.");
  });
});
