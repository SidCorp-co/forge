// @vitest-environment jsdom
//
// ISS-1229 r21: a comment's author line and avatar name the author as core resolves them, else as
// `personName` says the project member is called — never by address — and an agent's comment
// names the device's owner the same way.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommentNode, ProjectMember } from "../types";
import { CommentThread } from "./comment-thread";

vi.mock("../detail-hooks", () => ({
  useCreateComment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

afterEach(cleanup);

const node = (over: Partial<CommentNode>): CommentNode => ({
  id: "c1",
  issueId: "i1",
  authorId: "u2",
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
  { userId: "u2", email: "lan.pham@example.com", displayName: null, kind: "human", role: "member", createdAt: "" },
];

describe("a comment's author", () => {
  it("is named Another member, initialled AM, where the member has no display name", () => {
    const { container } = render(
      <CommentThread issueId="i1" comments={[node({ author: null })]} members={members} readOnly />,
    );
    expect(container.textContent).toContain("Another member");
    expect(container.textContent).toContain("AM");
    expect(container.textContent).not.toMatch(/lan\.pham|@example/);
  });

  it("names an agent's device owner as core called them, never by address", () => {
    const { container } = render(
      <CommentThread
        issueId="i1"
        comments={[
          node({
            authorId: "d1",
            author: { type: "device", id: "d1", displayName: "CI Runner", isAgent: true, ownerName: "another member" },
          }),
        ]}
        members={members}
        readOnly
      />,
    );
    expect(container.textContent).toContain("via another member");
    expect(container.textContent).not.toContain("@");
  });

  // ISS-1229 r22: the "via" line sits inside a sentence, so a capitalised label is placed again.
  it("names an unnamed owner lower-case on the via line, whichever form core served", () => {
    const { container } = render(
      <CommentThread
        issueId="i1"
        comments={[
          node({
            authorId: "d1",
            author: { type: "device", id: "d1", displayName: "CI Runner", isAgent: true, ownerName: "Another member" },
          }),
        ]}
        members={members}
        readOnly
      />,
    );
    expect(container.textContent).toContain("via another member");
  });
});

