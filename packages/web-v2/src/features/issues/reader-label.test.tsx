// @vitest-environment jsdom
//
// ISS-1229 r24, the master's ruling on judge-70's finding: the reader's own comments were headed
// "Another member" while Activity said "You commented". The reader reads "You" wherever a person is
// named to them, and their own avatar never wears the initials of an unnamed member.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { READER_INITIAL } from "@forge/contracts/person-name";
import { CommentThread } from "./components/comment-thread";
import { creatorChoice, creatorInitialsOf, groupRows, memberLabel } from "./derive";
import type { CommentNode, IssueRow, ProjectMember } from "./types";

vi.mock("./detail-hooks", () => ({
  useCreateComment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "me" } }) }));

afterEach(cleanup);

const node = (over: Partial<CommentNode>): CommentNode => ({
  id: "c1",
  issueId: "i1",
  authorId: "me",
  nodes: null,
  record: null,
  body: "Looks right to me.",
  format: "markdown",
  template: null,
  parentId: null,
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  replies: [],
  attachments: [],
  ...over,
});

const members: ProjectMember[] = [
  { userId: "me", email: "me@example.com", displayName: null, kind: "human", role: "member", createdAt: "" },
  { userId: "u2", email: "lan@example.com", displayName: null, kind: "human", role: "member", createdAt: "" },
];

describe("the reader's own comment", () => {
  it('is headed "You", and its avatar is not "AM", where the reader has no name', () => {
    const { container } = render(
      <CommentThread
        issueId="i1"
        comments={[
          node({ author: { type: "user", id: "me", displayName: "A member", isAgent: false } }),
        ]}
        members={members}
        readOnly
      />,
    );
    expect(container.textContent).toContain("You");
    expect(container.textContent).not.toContain("A member");
    expect(container.textContent).not.toContain("AM");
    expect(container.textContent).toContain(READER_INITIAL);
  });

  it("names a member's comment as before", () => {
    const { container } = render(
      <CommentThread issueId="i1" comments={[node({ authorId: "u2", author: null })]} members={members} readOnly />,
    );
    expect(container.textContent).toContain("A member");
  });

  it('reads "via you" on a comment the reader\'s own agent wrote', () => {
    const { container } = render(
      <CommentThread
        issueId="i1"
        comments={[
          node({
            authorId: "d1",
            author: {
              type: "device",
              id: "d1",
              displayName: "CI Runner",
              isAgent: true,
              ownerName: "a member",
              ownerId: "me",
            },
          }),
        ]}
        members={members}
        readOnly
      />,
    );
    expect(container.textContent).toContain("via you");
  });
});

const row = (over: Partial<IssueRow>): IssueRow =>
  ({ id: "i1", createdById: "me", creatorLabel: "A member", status: "open", priority: "medium", ...over }) as IssueRow;

describe("the reader as an issue's creator", () => {
  it('groups the reader\'s own issues under "You"', () => {
    const groups = groupRows([row({}), row({ id: "i2", createdById: "u2" })], "creator", "me");
    expect(groups.map((g) => g.label).sort()).toEqual(["A member", "You"]);
  });

  it('offers the reader as "You" in the creator filter, keeping their address to tell them apart', () => {
    expect(creatorChoice(members[0] as ProjectMember, "me")).toEqual({ label: "You", detail: "me@example.com" });
    expect(creatorChoice(members[1] as ProjectMember, "me").label).toBe("A member");
  });

  it("initials the reader's own issue with their letter, never AM", () => {
    expect(creatorInitialsOf(row({}), "me")).toBe(READER_INITIAL);
    expect(creatorInitialsOf(row({ createdById: "u2" }), "me")).toBe("AM");
    expect(creatorInitialsOf(row({ creatorLabel: "Mai Tran" }), "me")).toBe("MT");
  });

  it('names the reader "You" as a project member', () => {
    expect(memberLabel("me", members, "me")).toBe("You");
    expect(memberLabel("u2", members, "me")).toBe("A member");
  });
});
