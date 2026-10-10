// REQ-34 r2 BC-5, BC-9, BC-26 on the requirement page (ISS-457 criteria 1 and 3): its ready and
// acceptance checklists show each answer as a property with its source, and each gap as the question
// still to answer beside the revision that answers it; an assumed answer stays visible as one, and a
// later revision that answers it reads as the correction. Every question here is the contract's.
//
// @direct-test-of packages/web-v2/src/features/checklists/components/checklist-answers.tsx
// @direct-test-of packages/web-v2/src/features/checklists/components/item-checklists.tsx
// @direct-test-of packages/web-v2/src/features/checklists/hooks.ts
// @direct-test-of packages/web-v2/src/features/checklists/api.ts
// @direct-test-of packages/web-v2/src/features/requirements/components/requirement-overview.tsx

import { REQUIREMENT_ACCEPTANCE_CHECKLIST, REQUIREMENT_READY_CHECKLIST } from "@forge/contracts/checklist-registry";
import type { ChecklistRead } from "@forge/contracts/checklist-read";
import { evaluateChecklist } from "@forge/contracts/checklists";
import { QueryClient } from "@tanstack/react-query";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { label, passed, readOf, record, row } from "@/test/checklist-reads";
import { type Call, fakeCore, HANG, renderWithQuery } from "@/test/render";
import { reqDetail } from "@/test/vi-chrome-requirements";
import { RequirementPage } from "./requirement-detail";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/projects/hop/requirements/REQ-1", useParams: () => ({ slug: "hop" }) }));

afterEach(() => vi.unstubAllGlobals());

const PROJECT = "7f1c1d1e-0000-4000-8000-000000000001";
const READY_GIVEN = { problem: "Clinics lose the filter.", value: "They find a patient at once.", measured: "Fewer searches.", criteria: "1 criterion: BC-1", questions: "None open." };
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

  it("says an agree recorded before the checklist judged nothing, under a heading that reads how it stands now (BC-9, FB-120)", async () => {
    requirementPage([readOf(REQUIREMENT_READY_CHECKLIST, record(REQUIREMENT_READY_CHECKLIST, READY_GIVEN), [passed([], "no_checklist")]), readOf(REQUIREMENT_ACCEPTANCE_CHECKLIST, null)], 1);
    const section = await screen.findByTestId("checklist");
    expect(section.dataset.standing).toBe("no_checklist");
    expect(section, "a heading must not deny the checklist drawn under it").not.toHaveTextContent("No checklist");
    expect(section).toHaveTextContent("2 open");
    expect(within(section).getByTestId("checklist-unrecorded")).toHaveTextContent("It moved on before this checklist existed");
    expect(row(section, "criteria").dataset.state).toBe("given");
  });

  it('reads "No checklist" where the agree was recorded before the checklist and nothing stands now (BC-9)', async () => {
    requirementPage([readOf(REQUIREMENT_READY_CHECKLIST, null, [passed([], "no_checklist")]), readOf(REQUIREMENT_ACCEPTANCE_CHECKLIST, null)], 1);
    const section = await screen.findByTestId("checklist");
    expect(section).toHaveTextContent("No checklist");
    expect(within(section).queryByTestId("checklist-unrecorded")).toBeNull();
  });
});

