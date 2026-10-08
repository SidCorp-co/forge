// JU-6 / JU-5 / the HOP link ask (2026-10-08): a requirement's page says what is still unclear and
// what it assumes, its answer box records an answer the requirement keeps as a decision, its
// Decisions tab rolls up the decisions on its issues beside the answers, and a person links an issue
// that already exists to it, with core's refusal shown by its name.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { RequirementQuestionView } from "@forge/contracts/requirements";
import { fakeCore, renderWithQuery } from "@/test/render";
import { LinkIssueControl } from "./link-issue";
import { RequirementDecisions } from "./requirement-decisions";
import { AssumptionsSection, UnclearSection } from "./requirement-unclear";

const question = (over: Partial<RequirementQuestionView>): RequirementQuestionView => ({
  id: "q1",
  prompt: "May a referral manager download the aggregate report?",
  status: "open",
  place: { kind: "requirement" },
  whoAnswers: "the clinic owner",
  blocking: true,
  round: 1,
  askedAt: "2026-10-07T10:00:00Z",
  answer: null,
  ...over,
});

const refusal = (code: string, detail: string) => ({
  status: 422,
  body: { error: { code: "REQUIREMENT_REFUSED", message: "refused", refusals: [{ code, path: "/issue", detail }] } },
});

describe("what a requirement still leaves unclear", () => {
  it("counts the open questions, flags the one the agree waits for, and says who answers and where it was asked", () => {
    renderWithQuery(
      <UnclearSection
        questions={[
          question({}),
          question({ id: "q2", prompt: "Who builds the lead to patient link?", blocking: false, whoAnswers: null, place: { kind: "issue", key: "ISS-81", title: "lead link" } }),
          question({ id: "q3", prompt: "Is consent a new purpose?", status: "answered", blocking: false, answer: { text: "Yes, its own purpose", at: "2026-10-07T11:00:00Z", by: "Dana" } }),
        ]}
        unclear={2}
        projectId="p1"
        reqKey="REQ-14"
        slug="hop"
      />,
    );
    const section = screen.getByTestId("requirement-unclear");
    expect(section).toHaveTextContent("Still unclear");
    expect(section).toHaveTextContent("2 open");
    const [first, second, third] = screen.getAllByTestId("unclear-question");
    expect(first).toHaveTextContent("Blocks the agree");
    expect(first).toHaveTextContent("Answered by the clinic owner");
    expect(first).toHaveTextContent("Asked on this requirement");
    expect(within(second as HTMLElement).queryByText("Blocks the agree")).toBeNull();
    expect(within(second as HTMLElement).getByRole("link", { name: "ISS-81" })).toHaveAttribute("href", "/projects/hop/issues/ISS-81");
    expect(within(second as HTMLElement).queryByTestId("unclear-answer")).toBeNull();
    expect(third).toHaveTextContent("Yes, its own purpose");
    expect(within(third as HTMLElement).queryByTestId("unclear-answer")).toBeNull();
  });

  it("answers a question asked of the requirement in words, on the round it was shown", async () => {
    const calls = fakeCore(() => ({ body: { id: "q1", status: "answered" } }));
    const user = userEvent.setup();
    renderWithQuery(<UnclearSection questions={[question({ round: 2 })]} unclear={1} projectId="p1" reqKey="REQ-14" slug="hop" />);
    await user.type(screen.getByRole("textbox", { name: "Your answer" }), "Only the owner");
    await user.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "POST", path: "/questions/q1/answer", body: { text: "Only the owner", round: 2 } }));
  });

  it("lists the assumptions with whose they are and how each is confirmed", () => {
    renderWithQuery(<AssumptionsSection assumptions={[{ text: "Every referral names one referrer.", owner: "the BA", confirmBy: "a count over last month" }]} revision={3} />);
    const row = screen.getByTestId("assumption");
    expect(row).toHaveTextContent("Every referral names one referrer.");
    expect(row).toHaveTextContent("Owned by the BA · Confirmed by: a count over last month");
  });
});

describe("a requirement's Decisions tab", () => {
  it("shows a decision made on one of its issues with that issue named, and the answers beside them", async () => {
    fakeCore((c) =>
      c.path === "/projects/p1/requirements/REQ-14/decisions"
        ? {
            body: {
              decisions: [
                {
                  id: "c1",
                  target: { scope: "issue", id: "i1", key: "ISS-110", title: "consent screen" },
                  intent: "decision",
                  body: null,
                  format: "markdown",
                  decision: { decision: "Referrer feedback is its own consent purpose", reason: "the owner said so" },
                  parentId: null,
                  author: { id: "u1", name: "Dana", agency: "human" },
                  withheld: false,
                  edited: false,
                  createdAt: "2026-10-07T10:00:00Z",
                  updatedAt: "2026-10-07T10:00:00Z",
                },
              ],
              answers: [
                { questionId: "q9", prompt: "Download the aggregate?", answer: "No", answeredAt: "2026-10-07T09:00:00Z", answeredBy: "Dana", place: { kind: "issue", key: "ISS-110", title: "consent screen" } },
              ],
            },
          }
        : undefined,
    );
    renderWithQuery(<RequirementDecisions projectId="p1" slug="hop" reqKey="REQ-14" />);
    const row = await screen.findByTestId("decision-row");
    expect(row).toHaveTextContent("Referrer feedback is its own consent purpose");
    expect(within(row).getByTestId("decision-target")).toHaveTextContent("ISS-110");
    expect(screen.getByTestId("requirement-answer")).toHaveTextContent("Download the aggregate?");
    expect(screen.getByTestId("requirement-answer")).toHaveTextContent("No");
  });
});

describe("linking an issue that already exists", () => {
  it("picks the issue by key or title and links it, with the plan adopted when asked", async () => {
    const calls = fakeCore((c) => {
      if (c.path.startsWith("/projects/p1/issues/search")) return { body: { items: [{ displayId: "ISS-136", title: "Referral list" }] } };
      if (c.path === "/projects/p1/requirements/REQ-5/issues") return { body: { key: "REQ-5", issues: [] } };
      return undefined;
    });
    const user = userEvent.setup();
    renderWithQuery(<LinkIssueControl projectId="p1" reqKey="REQ-5" />);
    await user.click(screen.getByTestId("link-issue-open"));
    await user.type(screen.getByRole("combobox", { name: "Issue to link" }), "Referral");
    await user.click(await screen.findByRole("option", { name: /ISS-136/ }));
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Link" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "POST", path: "/projects/p1/requirements/REQ-5/issues", body: { issue: "ISS-136", adoptPlan: true } }));
  });

  it("names core's refusal when the issue already delivers another requirement", async () => {
    fakeCore((c) => {
      if (c.path.startsWith("/projects/p1/issues/search")) return { body: { items: [{ displayId: "ISS-136", title: "Referral list" }] } };
      if (c.method === "POST") return refusal("REQUIREMENT_ISSUE_LINKED_ELSEWHERE", "ISS-136 already delivers REQ-2");
      return undefined;
    });
    const user = userEvent.setup();
    renderWithQuery(<LinkIssueControl projectId="p1" reqKey="REQ-5" />);
    await user.click(screen.getByTestId("link-issue-open"));
    await user.type(screen.getByRole("combobox", { name: "Issue to link" }), "ISS-136");
    await user.click(await screen.findByRole("option", { name: /ISS-136/ }));
    await user.click(screen.getByRole("button", { name: "Link" }));
    expect(await screen.findByTestId("link-issue-refusal")).toHaveTextContent("REQUIREMENT_ISSUE_LINKED_ELSEWHERE");
  });
});
