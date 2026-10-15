// The issue peek says what the issue is before its facts: the description, the criteria with their
// marks and the newest comment, each read by the full page's own keys, and each left out when the
// issue has none of it, so the peek never draws an empty heading.

import { screen, within } from "@testing-library/react";
import type { QueryKey } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { STANDING_ROWS } from "@/test/vi-chrome-issues";
import { Seeded } from "@/test/vi-chrome-requirements";
import { issueQueryKey } from "../derive";
import { issueKeys } from "../queries";
import type { CommentNode, IssueDetail } from "../types";
import { IssuePeek, newestComment } from "./issue-peek";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const P = "p1";
const UUID = "0b7f3c1e-0000-4000-8000-000000000001";
const AT = "2026-10-15T08:00:00.000Z";
const row = STANDING_ROWS[0];
const peek = { open: row.key, position: { at: 1, of: 6 }, set: () => {}, move: () => {} };
const clock = { lang: "en" as const, now: Date.parse(AT), timeZone: "UTC" };

const detail = (over: Partial<IssueDetail> = {}) =>
  ({ id: UUID, displayId: row.key, projectId: P, status: "in_progress", description: null, descriptionFormat: "markdown", descriptionNodes: null, writtenLang: null, ...over }) as IssueDetail;

const comment = (id: string, body: string, createdAt: string, replies: CommentNode[] = []): CommentNode =>
  ({ id, issueId: UUID, authorId: "u1", nodes: null, record: null, body, format: "markdown", template: null, parentId: null, createdAt, updatedAt: createdAt, replies, attachments: [], author: { type: "user", id: "u1", displayName: "Lan", isAgent: false } });

function open(issue: IssueDetail, comments: CommentNode[], total = comments.length) {
  const data: [QueryKey, unknown][] = [
    [issueQueryKey(row.key, P), issue],
    [issueQueryKey(UUID, P), issue],
    [issueKeys.comments(UUID, P), { items: comments, totalCount: total }],
    [issueKeys.criteria(UUID), { criteria: [{ id: "k1", n: 1, statement: "A refused merge names the rule it broke", position: 0, requirementCriterionId: null, latest: null }], retired: [] }],
    [issueKeys.attachments(UUID), []],
  ];
  render(
    <Seeded data={data}>
      <IssuePeek projectId={P} slug="hop" row={row} clock={clock} peek={peek} full={{ href: `/projects/hop/issues/${row.key}`, origin: null }} />
    </Seeded>,
  );
}

describe("IssuePeek", () => {
  it("reads the description, the criteria and the newest comment before the facts", async () => {
    const older = comment("c1", "Planned the change in two steps.", "2026-10-14T08:00:00.000Z", [comment("c2", "The second step landed on dev.", "2026-10-15T07:00:00.000Z")]);
    open(detail({ description: "The merge is refused without saying which rule refused it." }), [older, comment("c3", "Moved to review.", "2026-10-14T09:00:00.000Z")], 3);
    expect(await screen.findByTestId("issue-peek-description")).toHaveTextContent("The merge is refused without saying which rule refused it.");
    expect(within(screen.getByTestId("issue-peek-criteria")).getByText(/A refused merge names the rule/)).toBeInTheDocument();
    const latest = screen.getByTestId("issue-peek-comment");
    expect(latest).toHaveTextContent("The second step landed on dev.");
    expect(latest).not.toHaveTextContent("Planned the change in two steps.");
    expect(latest).toHaveTextContent("3 in all");
    const sections = [...screen.getByTestId("issue-peek").querySelectorAll("[data-testid^=issue-peek-]")].map((el) => el.getAttribute("data-testid"));
    expect(sections.indexOf("issue-peek-description")).toBeLessThan(sections.indexOf("issue-peek-facts-group"));
    expect(sections.indexOf("issue-peek-comment")).toBeLessThan(sections.indexOf("issue-peek-facts-group"));
  });

  it("leaves out the sections an issue has nothing for, and keeps its facts", async () => {
    open(detail(), []);
    expect(await screen.findByTestId("issue-peek-criteria")).toBeInTheDocument();
    expect(screen.queryByTestId("issue-peek-description")).toBeNull();
    expect(screen.queryByTestId("issue-peek-comment")).toBeNull();
    expect(screen.getByTestId("issue-peek-facts")).toBeInTheDocument();
  });
});

describe("newestComment", () => {
  it("finds the newest anywhere in the thread and draws it without the replies under it", () => {
    const reply = comment("c2", "reply", "2026-10-15T07:00:00.000Z");
    const top = comment("c1", "top", "2026-10-15T09:00:00.000Z", [reply]);
    expect(newestComment([comment("c0", "old", "2026-10-13T07:00:00.000Z", [reply]), top])).toMatchObject({ id: "c1", replies: [] });
    expect(newestComment([comment("c0", "old", "2026-10-13T07:00:00.000Z", [reply])])).toMatchObject({ id: "c2", replies: [] });
    expect(newestComment([])).toBeNull();
  });
});
