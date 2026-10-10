// REQ-34 r2 BC-5 on the feedback page (ISS-457 criterion 1): its triage checklist shows what the
// item's record answers as properties, and each question the triage still answers beside the triage
// form; once triaged, the answers the triage was judged by, each choice by the contract's label.
//
// @direct-test-of packages/web-v2/src/features/checklists/components/item-checklists.tsx

import { FEEDBACK_TRIAGE_CHECKLIST } from "@forge/contracts/checklist-registry";
import type { ChecklistRead } from "@forge/contracts/checklist-read";
import type { ChecklistAnswer } from "@forge/contracts/checklists";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { optionLabel, passed, readOf, record, row } from "@/test/checklist-reads";
import { type Call, fakeCore, HANG, renderWithQuery } from "@/test/render";
import { feedbackDetail } from "@/test/vi-chrome-feedback";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/projects/hop/feedback/FB-2", useParams: () => ({ slug: "hop" }) }));

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("a feedback item's triage checklist on its page", () => {
  /** Where an answer came from is agent text, drawn in the developer view (REQ-43 BC-7). */
  function feedbackPage(read: ChecklistRead, view: "person" | "developer" = "person") {
    window.history.replaceState(null, "", view === "developer" ? "/?view=developer" : "/");
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
    expect(kind).toHaveTextContent(optionLabel(FEEDBACK_TRIAGE_CHECKLIST, "kind", "bug"));
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
      { question: "route", value: "issue", provenance: "given", source: "derived:short-form" },
    ];
    feedbackPage(readOf(FEEDBACK_TRIAGE_CHECKLIST, record(FEEDBACK_TRIAGE_CHECKLIST, { kind: "bug", requirement: "REQ-1" }), [{ ...passed(answers), from: "new", to: "triaged", gate: "feedback_triage" }]), "developer");
    const section = await screen.findByTestId("checklist");
    expect(section.dataset.standing).toBe("passed");
    expect(within(section).queryAllByTestId("checklist-gap")).toEqual([]);
    expect(row(section, "severity")).toHaveTextContent(optionLabel(FEEDBACK_TRIAGE_CHECKLIST, "severity", "high"));
    expect(row(section, "severity")).toHaveTextContent("Given in the move");
    expect(row(section, "reproduced")).toHaveTextContent("Twice on the staging board.");
    // the short form gave the route; the triager sent none, so it is not read as theirs
    expect(row(section, "route")).toHaveTextContent("Derived by the short-form rule");
    expect(row(section, "route")).not.toHaveTextContent("Given in the move");
  });

  it("keeps the checklist under Activity for a reader past triage, not at the top (REQ-43 BC-8)", async () => {
    const past = { phase: "planned", can: { triage: false, drop: false, verify: false, reopen: false, askVerify: false, redact: false, retarget: false, snooze: false, message: false, tellShipped: false, note: false, attach: false } } as const;
    fakeCore((c: Call) => (c.path === "/projects/p1/feedback/FB-2/checklist" ? { body: { feedbackId: "f2", key: "FB-2", checklists: [readOf(FEEDBACK_TRIAGE_CHECKLIST, record(FEEDBACK_TRIAGE_CHECKLIST, { kind: "bug" }))] } } : HANG));
    const top = renderWithQuery(feedbackDetail(past));
    await screen.findAllByText("Muc FB-2");
    expect(screen.queryByTestId("checklist")).toBeNull();
    top.unmount();
    window.history.replaceState(null, "", "/?tab=activity");
    renderWithQuery(feedbackDetail(past));
    const activity = await screen.findByTestId("view-activity");
    expect(await within(activity).findByTestId("checklist")).toHaveTextContent("Feedback triage");
  });

  it("leaves where each answer came from to the developer view (REQ-43 BC-7)", async () => {
    feedbackPage(readOf(FEEDBACK_TRIAGE_CHECKLIST, record(FEEDBACK_TRIAGE_CHECKLIST, { kind: "bug", requirement: "REQ-1" })));
    const section = await screen.findByTestId("checklist");
    expect(row(section, "kind")).toHaveTextContent(optionLabel(FEEDBACK_TRIAGE_CHECKLIST, "kind", "bug"));
    expect(within(section).queryByTestId("checklist-source")).toBeNull();
  });
});
