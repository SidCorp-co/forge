// ISS-585 (REQ-33 BC-2) on the issue page: a decision record in the history reads as its own words,
// its writer or a project admin withdraws it with a reason, and a withdrawn one stays marked beside its
// withdrawal. A comment's author, or a project admin, corrects what the comment is for in place.
// @direct-test-of packages/web-v2/src/features/issues/components/activity-feed.tsx
// @direct-test-of packages/web-v2/src/features/issues/components/comment-thread.tsx
// @direct-test-of packages/web-v2/src/features/issues/components/activity-decision.tsx
// @direct-test-of packages/web-v2/src/features/issues/components/use-issue-project.ts
// @direct-test-of packages/web-v2/src/features/issues/detail-api.ts

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { ActivityItem, CommentNode } from "../types";
import { ActivityFeed } from "./activity-feed";
import { CommentThread } from "./comment-thread";
import { useIssueViewer } from "./use-issue-project";

vi.mock("./body-editor", () => ({
  BodyEditor: ({ placeholder, value, onChange }: { placeholder: string; value: string; onChange: (v: string) => void }) => (
    <textarea placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

afterEach(() => vi.unstubAllGlobals());

const decision = (id: string, actorId = "u1"): ActivityItem => ({
  id,
  issueId: "i1",
  action: "record.decision",
  actorType: "user",
  actorId,
  payload: { fields: [{ key: "decision", value: `Hold ISS-7 (${id})` }, { key: "why", value: "two runs on it" }] },
  createdAt: "2026-10-25T00:00:00Z",
});

const withdrawal = (of: string): ActivityItem => ({
  id: `w-${of}`,
  issueId: "i1",
  action: "record.withdrawal",
  actorType: "user",
  actorId: "u1",
  payload: { withdraws: of, fields: [{ key: "withdraws", value: of }, { key: "reason", value: "A probe" }] },
  createdAt: "2026-10-25T01:00:00Z",
});

const mine = { issueId: "i1", may: (item: ActivityItem) => item.actorId === "u1" };

describe("a decision in the issue's history", () => {
  it("reads as its words; a withdrawn one is marked, offers no withdraw, and its withdrawal gives the reason", () => {
    fakeCore(() => undefined);
    renderWithQuery(<ActivityFeed items={[withdrawal("d1"), decision("d1"), decision("d2")]} withdraw={mine} />);
    const [gone, standing] = screen.getAllByTestId("activity-decision") as [HTMLElement, HTMLElement];
    expect(gone).toHaveTextContent("Hold ISS-7 (d1)");
    expect(within(gone).getByText("Withdrawn")).toBeInTheDocument();
    expect(within(gone).queryByRole("button", { name: "Withdraw" })).toBeNull();
    expect(within(standing).getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
    expect(screen.getByTestId("activity-withdrawal")).toHaveTextContent("Decision withdrawn");
    expect(screen.getByTestId("activity-withdrawal")).toHaveTextContent("A probe");
  });

  it("offers no withdraw on another writer's decision to a reader who does not admin the project", () => {
    fakeCore(() => undefined);
    renderWithQuery(<ActivityFeed items={[decision("d3", "u2")]} withdraw={mine} />);
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
  });

  it("sends the reason to the withdraw route, and cannot be sent without one", async () => {
    const calls = fakeCore((c) => (c.method === "POST" ? { status: 201, body: {} } : undefined));
    const user = userEvent.setup();
    renderWithQuery(<ActivityFeed items={[decision("d1")]} withdraw={mine} />);
    await user.click(screen.getByRole("button", { name: "Withdraw" }));
    const form = screen.getByTestId("withdraw-decision");
    const send = within(form).getByRole("button", { name: "Withdraw decision" });
    expect(send).toBeDisabled();
    await user.type(within(form).getByRole("textbox", { name: "Reason" }), " A probe, not a ruling ");
    await user.click(send);
    await waitFor(() =>
      expect(calls).toContainEqual({ method: "POST", path: "/issues/i1/events/d1/withdraw", body: { reason: "A probe, not a ruling" } }),
    );
  });

  it("shows core's refusal where the act was made", async () => {
    fakeCore(() => ({
      status: 409,
      body: { error: { code: "EVENT_ALREADY_WITHDRAWN", message: "refused", refusals: [{ code: "EVENT_ALREADY_WITHDRAWN", path: "/eventId", detail: "a decision is withdrawn once" }] } },
    }));
    const user = userEvent.setup();
    renderWithQuery(<ActivityFeed items={[decision("d1")]} withdraw={mine} />);
    await user.click(screen.getByRole("button", { name: "Withdraw" }));
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "again");
    await user.click(screen.getByRole("button", { name: "Withdraw decision" }));
    expect(await screen.findByTestId("withdraw-refusal")).toHaveTextContent("a decision is withdrawn once");
  });
});

const question = {
  id: "c1",
  body: "Is the hold still needed?",
  intent: "question",
  createdAt: "2026-10-25T00:00:00Z",
  authorId: "u1",
  replies: [],
  attachments: [],
} as unknown as CommentNode;

const noOpenQuestion = (c: { method: string; path: string }) =>
  c.method === "GET" && c.path.startsWith("/questions?") ? { body: { questions: [] } } : undefined;

describe("a comment's intent on the issue page", () => {
  it("is corrected in place by its author: the same comment is patched with the new intent", async () => {
    const calls = fakeCore((c) => noOpenQuestion(c) ?? (c.method === "PATCH" ? { body: { ...question, intent: "note" } } : undefined));
    const user = userEvent.setup();
    renderWithQuery(<CommentThread issueId="i1" comments={[question]} members={[]} viewer={{ userId: "u1", canManage: false }} />);
    await user.click(screen.getByRole("combobox", { name: "Comment type" }));
    await user.click(await screen.findByRole("option", { name: "Note" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "PATCH", path: "/comments/c1", body: { intent: "note" } }));
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("is offered to a project admin on someone else's comment, and to nobody else", () => {
    fakeCore(noOpenQuestion);
    const { unmount } = renderWithQuery(
      <CommentThread issueId="i1" comments={[question]} members={[]} viewer={{ userId: "u2", canManage: false }} />,
    );
    expect(screen.queryByRole("combobox", { name: "Comment type" })).toBeNull();
    unmount();
    renderWithQuery(<CommentThread issueId="i1" comments={[question]} members={[]} viewer={{ userId: "u2", canManage: true }} />);
    expect(screen.getByRole("combobox", { name: "Comment type" })).toBeInTheDocument();
  });

  it("is not offered on a read-only page", () => {
    fakeCore(noOpenQuestion);
    renderWithQuery(<CommentThread issueId="i1" comments={[question]} members={[]} readOnly viewer={{ userId: "u1", canManage: true }} />);
    expect(screen.queryByRole("combobox", { name: "Comment type" })).toBeNull();
  });
});

describe("who reads the issue page", () => {
  function Viewer({ projectId }: { projectId: string }) {
    const viewer = useIssueViewer(projectId);
    return <span data-testid="viewer">{viewer.canManage ? "admin" : "not admin"}</span>;
  }

  it("admins the project only where their role there is admin", async () => {
    fakeCore((c) => (c.path.startsWith("/projects") ? { body: [{ id: "p1", role: "admin" }, { id: "p2", role: "member" }] } : undefined));
    const { unmount } = renderWithQuery(<Viewer projectId="p1" />);
    await waitFor(() => expect(screen.getByTestId("viewer")).toHaveTextContent(/^admin$/));
    unmount();
    renderWithQuery(<Viewer projectId="p2" />);
    await waitFor(() => expect(screen.getByTestId("viewer")).toHaveTextContent("not admin"));
  });
});
